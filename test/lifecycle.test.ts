import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as browser from "../src/browser.js";
import { createFeed } from "../src/create.js";
import { Emitter } from "../src/emitter.js";
import { type AttachOptions, Feed, attachFeed } from "../src/feed.js";
import { FeedHttpError, request } from "../src/http.js";
import type { EndReason, FeedStatus } from "../src/types.js";
import {
  API_KEY,
  BASE_URL,
  CREATED_SSE,
  FEED_ID,
  FEED_TOKEN,
  MACHINE_A,
  SSE_ENDPOINT,
  heartbeatSse,
  jwt,
  withEndpoint,
} from "./fixtures/api.js";
import { CONNECT_FRAME, UPDATE, pubFrame } from "./fixtures/messages.js";
import { fakeApi, flush, json, sseStream } from "./helpers.js";

const INTERVAL_MS = CREATED_SSE.heartbeat_interval * 1000;

function setup(extra: Partial<AttachOptions> = {}) {
  const api = fakeApi();
  const feed = attachFeed({
    feedId: FEED_ID,
    feedToken: FEED_TOKEN,
    baseUrl: BASE_URL,
    fetch: api.fetch,
    initialTokens: CREATED_SSE,
    ...extra,
  });
  const statuses: FeedStatus[] = [];
  const ended: EndReason[] = [];
  const errors: Error[] = [];
  feed.on("status", (s) => statuses.push(s));
  feed.on("ended", ({ reason }) => ended.push(reason));
  feed.on("error", (e) => errors.push(e));
  return { api, feed, statuses, ended, errors };
}

function queueStream(api: ReturnType<typeof fakeApi>) {
  const stream = sseStream();
  api.queue("sse", (init) => stream.respond(init));
  return stream;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("listener isolation", () => {
  it("routes a throwing update listener to `error` and keeps the feed running", async () => {
    const { api, feed, errors } = setup();
    const stream = queueStream(api);
    const seen: number[] = [];
    let calls = 0;
    feed.on("update", () => {
      calls += 1;
      if (calls === 1) throw new Error("listener bug");
    });
    feed.on("update", () => seen.push(calls));
    feed.start();
    await flush();
    stream.push(CONNECT_FRAME + pubFrame(UPDATE) + pubFrame(UPDATE));
    await flush();
    expect(errors.map((e) => e.message)).toEqual(["listener bug"]);
    expect(seen).toEqual([1, 2]);
    expect(feed.status).toBe("live");
  });

  it("wraps a non-Error throw", async () => {
    const { api, feed, errors } = setup();
    queueStream(api);
    feed.on("status", () => {
      throw "just a string";
    });
    feed.start();
    await flush();
    expect(errors[0]!.message).toBe("just a string");
  });

  it("still DELETEs on stop() when a status listener throws on `ended`", async () => {
    const rethrown: (() => void)[] = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((fn) => void rethrown.push(fn));
    const { api, feed, ended, errors } = setup();
    queueStream(api);
    api.queue("delete", new Response(null, { status: 204 }));
    feed.on("status", (status) => {
      if (status === "ended") throw new Error("listener bug");
    });
    feed.start();
    await flush();
    await expect(feed.stop()).resolves.toBeUndefined();
    expect(api.count("delete")).toBe(1);
    expect(ended).toEqual(["stopped"]);
    expect(vi.getTimerCount()).toBe(0);
    // Past the end there is no `error` event to carry it: it is re-thrown outside instead.
    expect(errors).toEqual([]);
    expect(rethrown).toHaveLength(1);
    expect(() => rethrown[0]!()).toThrow("listener bug");
  });

  it("ends exactly once when an `ended` or `status` listener calls stop() or start()", async () => {
    const { api, feed, ended, statuses } = setup();
    queueStream(api);
    api.queue("delete", new Response(null, { status: 204 }));
    feed.on("status", (status) => {
      if (status === "ended") void feed.stop();
    });
    feed.on("ended", () => {
      void feed.stop();
      feed.start();
    });
    feed.start();
    await flush();
    await feed.stop();
    await flush();
    expect(ended).toEqual(["stopped"]);
    expect(statuses.filter((s) => s === "ended")).toHaveLength(1);
    expect(api.count("delete")).toBe(1);
    expect(api.count("sse")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-throws, outside the emitter, an error thrown by an `error` listener", () => {
    const deferred: (() => void)[] = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((fn) => void deferred.push(fn));
    class Test extends Emitter<{ error: Error }> {
      fire() {
        this.emit("error", new Error("original"));
      }
    }
    const emitter = new Test();
    const after = vi.fn();
    emitter.on("error", () => {
      throw new Error("from the error listener");
    });
    emitter.on("error", after);
    emitter.fire();
    expect(after).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveLength(1);
    expect(() => deferred[0]!()).toThrow("from the error listener");
  });
});

describe("feed error listeners and stability", () => {
  it("re-throws outside the feed when an `error` listener itself throws", async () => {
    const deferred: (() => void)[] = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((fn) => void deferred.push(fn));
    const { api, feed } = setup();
    const stream = queueStream(api);
    feed.on("error", () => {
      throw new Error("error listener bug");
    });
    feed.on("update", () => {
      throw new Error("update listener bug");
    });
    feed.start();
    await flush();
    stream.push(pubFrame(UPDATE));
    await flush();
    expect(deferred).toHaveLength(1);
    expect(() => deferred[0]!()).toThrow("error listener bug");
  });

  it("a repeated live signal does not restart the stability clock", async () => {
    const { api, feed } = setup();
    const stream = queueStream(api);
    queueStream(api);
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    feed.start();
    await flush();
    stream.push(CONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(20_000);
    stream.push(CONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(10_000);
    stream.push(`data: ${JSON.stringify({ push: { disconnect: { code: 3005 } } })}\n\n`);
    await flush();
    // Thirty seconds live in total: refreshed at once, no backoff.
    expect(api.count("heartbeat")).toBe(1);
  });
});

describe("review fixes", () => {
  it("runs attachFeed's checks in the Feed constructor too", () => {
    expect(() => new Feed({ feedId: FEED_ID, feedToken: API_KEY })).toThrow(/sb_live_ API key/);
    expect(() => new Feed({ feedId: FEED_ID, feedToken: "nope" })).toThrow(/sbf_ feed token/);
    expect(
      () => new Feed({ feedId: FEED_ID, feedToken: FEED_TOKEN, baseUrl: "http://evil.example" }),
    ).toThrow(/baseUrl/);
    expect(new Feed({ feedId: FEED_ID, feedToken: FEED_TOKEN })).toBeInstanceOf(Feed);
  });

  it("redacts credentials in a server error's message and detail", async () => {
    const api = fakeApi();
    api.queue(
      "create",
      json(400, { detail: `bad key ${API_KEY} token ${FEED_TOKEN} jwt ${jwt("x")}` }),
    );
    const error = await request<never>(api.fetch, "https://x.test/", "POST", API_KEY, {}).catch(
      (e: FeedHttpError) => e,
    );
    expect(error.detail).toBe("bad key [redacted] token [redacted] jwt [redacted]");
    expect(error.message).toBe(
      "Scorbit API answered 400: bad key [redacted] token [redacted] jwt [redacted]",
    );
  });

  it("ends once when an error listener calls stop() while the feed is ending itself", async () => {
    const { api, feed, ended, statuses } = setup();
    queueStream(api);
    api.queue(
      "heartbeat",
      json(200, withEndpoint(heartbeatSse(2), "http://centrifugo.example/uni_sse")),
    );
    api.queue("delete", new Response(null, { status: 204 }));
    feed.on("error", () => void feed.stop());
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(ended).toEqual(["stopped"]);
    expect(statuses.filter((s) => s === "ended")).toHaveLength(1);
    expect(api.count("delete")).toBe(1);
  });

  it("still deletes on stop() after the feed ended locally, and retries a failed delete", async () => {
    // No endpoint known anywhere: the feed ends locally after its first heartbeat.
    const { api, feed, ended } = setup({ initialTokens: undefined });
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    feed.start();
    await flush();
    expect(ended).toEqual(["stopped"]);
    api.queue("delete", json(500), new Response(null, { status: 204 }));
    await expect(feed.stop()).rejects.toMatchObject({ status: 500 });
    await expect(feed.stop()).resolves.toBeUndefined();
    await feed.stop();
    expect(api.count("delete")).toBe(2);
  });

  it("does not try to delete a feed the server already ended", async () => {
    const { api, feed, ended } = setup();
    queueStream(api);
    api.queue("heartbeat", json(404, { detail: "Feed not found." }));
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(ended).toEqual(["ended"]);
    await feed.stop();
    expect(api.count("delete")).toBe(0);
  });
});

describe("Retry-After", () => {
  it("waits at least as long as a 429 asks", async () => {
    const { api, feed, errors } = setup();
    queueStream(api);
    const throttled = json(429, { detail: "Request was throttled." });
    throttled.headers.set("Retry-After", "10");
    api.queue("heartbeat", throttled, json(200, heartbeatSse(2)));
    queueStream(api);
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(errors[0]!.message).toMatch(/429/);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(api.count("heartbeat")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(2);
  });

  it.each([
    ["120", 120],
    [new Date(Date.now() + 60_000).toUTCString(), 60],
    [new Date(Date.now() - 60_000).toUTCString(), 0],
    ["soon", undefined],
    [null, undefined],
  ])("parses Retry-After %j", async (header, seconds) => {
    vi.setSystemTime(Date.now());
    const api = fakeApi();
    const response = json(429);
    if (header !== null) response.headers.set("Retry-After", header);
    api.queue("create", response);
    const error = await request<never>(api.fetch, "https://x.test/", "POST", API_KEY, {}).catch(
      (e: FeedHttpError) => e,
    );
    if (seconds === undefined) expect(error.retryAfter).toBeUndefined();
    else expect(error.retryAfter).toBeCloseTo(seconds, -1);
  });
});

describe("URL checks", () => {
  it.each(["http://api.example.com", "ftp://api.example.com", "not a url"])(
    "refuses baseUrl %j",
    async (baseUrl) => {
      const api = fakeApi();
      expect(() => attachFeed({ feedId: FEED_ID, feedToken: FEED_TOKEN, baseUrl })).toThrow(
        /baseUrl/,
      );
      await expect(
        createFeed({ apiKey: API_KEY, machines: [MACHINE_A], baseUrl, fetch: api.fetch }),
      ).rejects.toThrow(/baseUrl/);
      expect(api.calls).toHaveLength(0);
    },
  );

  it.each(["http://localhost:8000", "http://127.0.0.1:8000/", "http://[::1]:8000"])(
    "allows plain http for a loopback baseUrl %j",
    (baseUrl) => {
      expect(attachFeed({ feedId: FEED_ID, feedToken: FEED_TOKEN, baseUrl })).toBeInstanceOf(Feed);
    },
  );

  it.each([
    "ftp://centrifugo.test/",
    "ws://centrifugo.example/connection/websocket",
    "http://centrifugo.example/connection/uni_sse",
    "not a url",
  ])("refuses endpoint %j up front", (endpoint) => {
    expect(() => attachFeed({ feedId: FEED_ID, feedToken: FEED_TOKEN, endpoint })).toThrow(
      /endpoint/,
    );
  });

  it.each(["ws://localhost:8000/connection/websocket", "wss://c.test/x", SSE_ENDPOINT])(
    "accepts endpoint %j",
    (endpoint) => {
      expect(attachFeed({ feedId: FEED_ID, feedToken: FEED_TOKEN, endpoint })).toBeInstanceOf(Feed);
    },
  );

  it("treats a heartbeat with a bad endpoint as a failed refresh, never connecting to it", async () => {
    const { api, feed, errors, ended } = setup();
    queueStream(api);
    api.queue(
      "heartbeat",
      json(200, withEndpoint(heartbeatSse(2), "http://centrifugo.example/uni_sse")),
    );
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(errors[0]!.message).toBe("malformed heartbeat response: bad sse_endpoint");
    expect(ended).toEqual([]);
    expect(api.count("sse")).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("never lets a refresh reject: an unexpected failure becomes an error event", async () => {
    const target = Feed.prototype as unknown as { heartbeat: () => Promise<boolean> };
    const spy = vi.spyOn(target, "heartbeat").mockRejectedValueOnce(new Error("unexpected"));
    const { api, feed, errors } = setup({ initialTokens: undefined, endpoint: SSE_ENDPOINT });
    feed.start();
    await flush();
    expect(errors.map((e) => e.message)).toEqual(["unexpected"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(api.calls).toHaveLength(0);
  });
});

describe("browser guards", () => {
  it.each([
    ["document", {}],
    ["WorkerGlobalScope", function WorkerGlobalScope() {}],
  ])("createFeed refuses when %s is defined", async (name, value) => {
    const api = fakeApi();
    vi.stubGlobal(name, value);
    await expect(
      createFeed({ apiKey: API_KEY, machines: [MACHINE_A], fetch: api.fetch }),
    ).rejects.toThrow(/server-side only/);
    expect(api.calls).toHaveLength(0);
  });

  it("the browser bundle's entry exports attach only", () => {
    expect(Object.keys(browser).sort()).toEqual([
      "DEFAULT_BASE_URL",
      "FEED_TOKEN_PREFIX",
      "Feed",
      "FeedError",
      "FeedHttpError",
      "asFeedUpdate",
      "attachFeed",
    ]);
  });
});
