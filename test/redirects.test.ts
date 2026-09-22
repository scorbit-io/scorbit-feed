/* No credential-bearing request follows a redirect: each call type refuses one. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFeed } from "../src/create.js";
import { attachFeed } from "../src/feed.js";
import {
  API_KEY,
  BASE_URL,
  CREATED_SSE,
  FEED_ID,
  FEED_TOKEN,
  MACHINE_A,
  heartbeatSse,
} from "./fixtures/api.js";
import { fakeApi, flush, json, sseStream } from "./helpers.js";

const redirect = (status: number) =>
  new Response(null, { status, headers: { Location: "https://elsewhere.example/steal" } });

/** What a browser returns for `redirect: "manual"`: an opaque redirect. */
function opaqueRedirect(): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "type", { value: "opaqueredirect" });
  return response;
}

const INTERVAL_MS = CREATED_SSE.heartbeat_interval * 1000;

function attached(api: ReturnType<typeof fakeApi>) {
  const feed = attachFeed({
    feedId: FEED_ID,
    feedToken: FEED_TOKEN,
    baseUrl: BASE_URL,
    fetch: api.fetch,
    initialTokens: CREATED_SSE,
  });
  const errors: string[] = [];
  feed.on("error", (e) => errors.push(e.message));
  return { feed, errors };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("redirects are refused", () => {
  it.each([307, 308, 302])(
    "create: a %i is an error, and the key is not re-sent",
    async (status) => {
      const api = fakeApi();
      api.queue("create", redirect(status));
      await expect(
        createFeed({ apiKey: API_KEY, machines: [MACHINE_A], baseUrl: BASE_URL, fetch: api.fetch }),
      ).rejects.toThrow(
        `request failed: refused a redirect (${status}); credentials are never re-sent`,
      );
      expect(api.calls).toHaveLength(1);
      expect(api.calls[0]!.redirect).toBe("manual");
    },
  );

  it("create: an opaque (browser) redirect is refused too", async () => {
    const api = fakeApi();
    api.queue("create", opaqueRedirect());
    await expect(
      createFeed({ apiKey: API_KEY, machines: [MACHINE_A], baseUrl: BASE_URL, fetch: api.fetch }),
    ).rejects.toThrow(/refused a redirect/);
  });

  it("heartbeat: a redirect is a transient failure, retried with backoff", async () => {
    const api = fakeApi();
    api.queue("sse", (init) => sseStream().respond(init));
    api.queue("heartbeat", redirect(307), json(200, heartbeatSse(2)));
    api.queue("sse", (init) => sseStream().respond(init));
    const { feed, errors } = attached(api);
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(errors).toEqual([
      "heartbeat failed: request failed: refused a redirect (307); credentials are never re-sent",
    ]);
    expect(feed.status).not.toBe("ended");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.count("heartbeat")).toBe(2);
    expect(
      api.calls.filter((c) => c.key === "heartbeat").every((c) => c.redirect === "manual"),
    ).toBe(true);
    await feed.stop({ deleteFeed: false });
  });

  it("delete: a redirect makes stop() reject, and it can be retried", async () => {
    const api = fakeApi();
    api.queue("delete", redirect(308), new Response(null, { status: 204 }));
    const { feed } = attached(api);
    await expect(feed.stop()).rejects.toThrow(/refused a redirect \(308\)/);
    await expect(feed.stop()).resolves.toBeUndefined();
    expect(api.calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("SSE connect: a redirect is a lost connection, retried with backoff, never followed", async () => {
    const api = fakeApi();
    api.queue("sse", redirect(307));
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    api.queue("sse", (init) => sseStream().respond(init));
    const { feed, errors } = attached(api);
    feed.start();
    await flush();
    expect(errors).toEqual([
      "SSE connection failed: refused a redirect (307); credentials are never re-sent",
    ]);
    expect(api.calls[0]!.redirect).toBe("manual");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.count("sse")).toBe(2);
    expect(api.calls.every((c) => c.redirect === "manual")).toBe(true);
    await feed.stop({ deleteFeed: false });
  });
});

describe("unread bodies are released", () => {
  function tracked(status: number, cancelFails = false) {
    const state = { cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        state.cancelled = true;
        if (cancelFails) throw new Error("cancel failed");
      },
    });
    return { response: new Response(body, { status }), state };
  }

  it.each([
    ["a refused redirect on an API request", 307, "create"],
    ["a refused redirect on the SSE connect", 307, "sse"],
    ["a refused SSE connect", 401, "sse"],
  ] as const)("cancels the body of %s", async (_label, status, key) => {
    const api = fakeApi();
    const { response, state } = tracked(status);
    api.queue(key, response);
    if (key === "create") {
      await expect(
        createFeed({ apiKey: API_KEY, machines: [MACHINE_A], baseUrl: BASE_URL, fetch: api.fetch }),
      ).rejects.toThrow();
    } else {
      const { feed } = attached(api);
      feed.start();
      await flush();
      await feed.stop({ deleteFeed: false });
    }
    await flush();
    expect(state.cancelled).toBe(true);
  });

  it("cancels the body of an SSE response that arrives after stop", async () => {
    const api = fakeApi();
    const { response, state } = tracked(200);
    let release!: () => void;
    api.queue("sse", () => new Promise<Response>((resolve) => (release = () => resolve(response))));
    const { feed } = attached(api);
    feed.start();
    await flush();
    await feed.stop({ deleteFeed: false });
    release();
    await flush();
    expect(state.cancelled).toBe(true);
  });

  it("does not let a failing cancel escape", async () => {
    const api = fakeApi();
    const { response, state } = tracked(308, true);
    api.queue("create", response);
    await expect(
      createFeed({ apiKey: API_KEY, machines: [MACHINE_A], baseUrl: BASE_URL, fetch: api.fetch }),
    ).rejects.toThrow(/refused a redirect/);
    await flush();
    expect(state.cancelled).toBe(true);
  });
});
