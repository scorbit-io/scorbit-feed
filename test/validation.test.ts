import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFeed } from "../src/create.js";
import { attachFeed } from "../src/feed.js";
import { request } from "../src/http.js";
import { createdProblem, tokensProblem } from "../src/validate.js";
import {
  API_KEY,
  BASE_URL,
  CREATED_SDK,
  CREATED_SSE,
  FEED_ID,
  FEED_TOKEN,
  MACHINE_A,
  SSE_ENDPOINT,
  heartbeatSdk,
  heartbeatSse,
  jwt,
} from "./fixtures/api.js";
import { CONNECT_FRAME, DISCONNECT_FRAME, UPDATE, pubFrame } from "./fixtures/messages.js";
import { fakeApi, flush, json, sseStream } from "./helpers.js";

describe("tokensProblem (heartbeat bodies)", () => {
  it.each([
    ["not an object", null, "body"],
    ["a string", "tokens", "body"],
    ["no feed_id", { ...heartbeatSse(1), feed_id: "" }, "feed_id"],
    [
      "no connection_token",
      { ...heartbeatSse(1), connection_token: undefined },
      "connection_token",
    ],
    ["a numeric connection_token", { ...heartbeatSse(1), connection_token: 7 }, "connection_token"],
    ["zero interval", { ...heartbeatSse(1), heartbeat_interval: 0 }, "heartbeat_interval"],
    ["string interval", { ...heartbeatSse(1), heartbeat_interval: "600" }, "heartbeat_interval"],
    [
      "infinite interval",
      { ...heartbeatSse(1), heartbeat_interval: Infinity },
      "heartbeat_interval",
    ],
    ["negative token_ttl", { ...heartbeatSse(1), token_ttl: -1 }, "token_ttl"],
    ["NaN token_ttl", { ...heartbeatSse(1), token_ttl: NaN }, "token_ttl"],
    ["an unknown transport", { ...heartbeatSse(1), transport: "grpc" }, "transport"],
    [
      "an empty subscription_token",
      { ...heartbeatSdk(1), subscription_token: "" },
      "subscription_token",
    ],
    [
      "sdk without subscription_token",
      { ...heartbeatSse(1), transport: "sdk" },
      "subscription_token",
    ],
    [
      "an http ws_endpoint",
      { ...heartbeatSdk(1), ws_endpoint: "https://c.test/ws" },
      "ws_endpoint",
    ],
    [
      "a plain ws ws_endpoint",
      { ...heartbeatSdk(1), ws_endpoint: "ws://c.example/ws" },
      "ws_endpoint",
    ],
    ["a numeric sse_endpoint", { ...heartbeatSse(1), sse_endpoint: 5 }, "sse_endpoint"],
    ["a ws sse_endpoint", { ...heartbeatSse(1), sse_endpoint: "wss://c.test/sse" }, "sse_endpoint"],
  ])("rejects %s", (_label, body, field) => {
    expect(tokensProblem(body)).toBe(field);
  });

  it.each([
    ["sse", heartbeatSse(1)],
    ["sdk", heartbeatSdk(1)],
    ["sdk with endpoint", { ...heartbeatSdk(1), transport: "sdk", ws_endpoint: "wss://c.test/ws" }],
    ["sse with endpoint", { ...heartbeatSse(1), transport: "sse", sse_endpoint: SSE_ENDPOINT }],
    ["loopback endpoint", { ...heartbeatSdk(1), ws_endpoint: "ws://localhost:8000/ws" }],
  ])("accepts %s", (_label, body) => {
    expect(tokensProblem(body)).toBeUndefined();
  });
});

describe("createdProblem (create bodies)", () => {
  it.each([
    ["a bad token field", { ...CREATED_SDK, connection_token: "" }, "connection_token"],
    ["no feed_token", { ...CREATED_SDK, feed_token: undefined }, "feed_token"],
    ["an API key as feed_token", { ...CREATED_SDK, feed_token: API_KEY }, "feed_token"],
    ["no transport", { ...CREATED_SSE, transport: undefined }, "transport"],
    ["sdk without ws_endpoint", { ...CREATED_SDK, ws_endpoint: undefined }, "ws_endpoint"],
    ["sse without sse_endpoint", { ...CREATED_SSE, sse_endpoint: undefined }, "sse_endpoint"],
    ["no machines", { ...CREATED_SSE, machines: undefined }, "machines"],
  ])("rejects %s", (_label, body, field) => {
    expect(createdProblem(body)).toBe(field);
  });

  it.each([
    ["sdk", CREATED_SDK],
    ["sse", CREATED_SSE],
  ])("accepts %s", (_label, body) => {
    expect(createdProblem(body)).toBeUndefined();
  });
});

describe("createFeed with a malformed response", () => {
  it("throws, naming the field but never its value, and deletes the feed with the key", async () => {
    const api = fakeApi();
    api.queue("create", json(201, { ...CREATED_SDK, feed_token: API_KEY }));
    api.queue("delete", new Response(null, { status: 204 }));
    const error = await createFeed({
      apiKey: API_KEY,
      machines: [MACHINE_A],
      baseUrl: BASE_URL,
      fetch: api.fetch,
    }).catch((e: unknown) => e);
    if (!(error instanceof Error)) throw new Error("expected a rejection");
    expect(error.message).toBe("malformed create response: bad feed_token");
    const del = api.calls.find((c) => c.key === "delete")!;
    expect(del.url).toBe(`${BASE_URL}/api/v2/data-feeds/${FEED_ID}/`);
    expect(del.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("still throws the malformed-response error when that delete fails", async () => {
    const api = fakeApi();
    api.queue("create", json(201, { ...CREATED_SDK, heartbeat_interval: 0 }));
    api.queue("delete", json(500));
    await expect(
      createFeed({ apiKey: API_KEY, machines: [MACHINE_A], baseUrl: BASE_URL, fetch: api.fetch }),
    ).rejects.toThrow("malformed create response: bad heartbeat_interval");
    expect(api.count("delete")).toBe(1);
  });

  it.each([
    ["no body", undefined],
    ["no feed_id", { ...CREATED_SDK, feed_id: undefined }],
  ])("has nothing to delete with %s", async (_label, body) => {
    const api = fakeApi();
    api.queue("create", body === undefined ? new Response(null, { status: 201 }) : json(201, body));
    await expect(
      createFeed({ apiKey: API_KEY, machines: [MACHINE_A], baseUrl: BASE_URL, fetch: api.fetch }),
    ).rejects.toThrow(/malformed create response/);
    expect(api.count("delete")).toBe(0);
  });
});

/** A WebSocket that never opens: enough for the real SDK to sit connecting. */
class SilentSocket {
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  send(): void {}
  close(): void {}
}

describe("heartbeat validation in the feed", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a heartbeat that drops the subscription token of an sdk feed", async () => {
    const api = fakeApi();
    const feed = attachFeed({
      feedId: FEED_ID,
      feedToken: FEED_TOKEN,
      baseUrl: BASE_URL,
      fetch: api.fetch,
      websocket: SilentSocket,
      initialTokens: CREATED_SDK,
    });
    const errors: string[] = [];
    feed.on("error", (e) => errors.push(e.message));
    api.queue("heartbeat", json(200, heartbeatSse(2)), json(200, heartbeatSdk(3)));
    feed.start();
    await vi.advanceTimersByTimeAsync(CREATED_SDK.heartbeat_interval * 1000);
    expect(errors).toContain("malformed heartbeat response: bad subscription_token");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.count("heartbeat")).toBe(2);
    expect(feed.status).not.toBe("ended");
    await feed.stop({ deleteFeed: false });
  });

  it("falls back to a heartbeat when the tokens in hand are malformed", async () => {
    const api = fakeApi();
    const stream = sseStream();
    api.queue("sse", (init) => stream.respond(init));
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    const feed = attachFeed({
      feedId: FEED_ID,
      feedToken: FEED_TOKEN,
      baseUrl: BASE_URL,
      fetch: api.fetch,
      endpoint: SSE_ENDPOINT,
      initialTokens: { ...CREATED_SSE, token_ttl: 0 },
    });
    feed.start();
    await flush();
    expect(api.calls.map((c) => c.key)).toEqual(["heartbeat", "sse"]);
    expect(api.calls[1]!.body).toEqual({ token: jwt("sseconn2") });
    await feed.stop({ deleteFeed: false });
  });
});

describe("redaction at the public boundary", () => {
  it("redacts a custom fetch's rejection, which may contain the bearer credential", async () => {
    const leaky = async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      throw new Error(`boom sending ${auth}`);
    };
    const error = await request<never>(leaky, "https://x.test/", "POST", API_KEY, {}).catch(
      (e: Error) => e,
    );
    expect(error.message).toBe("request failed: boom sending Bearer [redacted]");
    expect(error.message).not.toContain(API_KEY);
    expect(error).not.toHaveProperty("cause");
  });

  it("redacts a body read that fails after the headers", async () => {
    const response = json(200, {});
    vi.spyOn(response, "text").mockRejectedValue(new Error(`reset ${FEED_TOKEN}`));
    const error = await request<never>(
      async () => response,
      "https://x.test/",
      "GET",
      FEED_TOKEN,
    ).catch((e: Error) => e);
    expect(error.message).toBe("request failed: reset [redacted]");
  });

  it("redacts a listener's exception before emitting it", async () => {
    const api = fakeApi();
    api.queue("sse", (init) => sseStream().respond(init));
    const feed = attachFeed({
      feedId: FEED_ID,
      feedToken: FEED_TOKEN,
      baseUrl: BASE_URL,
      fetch: api.fetch,
      initialTokens: CREATED_SSE,
    });
    const errors: Error[] = [];
    feed.on("error", (e) => errors.push(e));
    feed.on("status", (status) => {
      if (status === "connecting") throw new Error(`listener saw ${API_KEY} and ${jwt("x")}`);
    });
    feed.start();
    await flush();
    expect(errors.map((e) => e.message)).toEqual(["listener saw [redacted] and [redacted]"]);
    await feed.stop({ deleteFeed: false });
  });
});

describe("stale SSE frames", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the rest of a chunk once a frame in it closed the connection", async () => {
    const api = fakeApi();
    const first = sseStream();
    api.queue("sse", (init) => first.respond(init));
    api.queue("sse", (init) => sseStream().respond(init));
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    const feed = attachFeed({
      feedId: FEED_ID,
      feedToken: FEED_TOKEN,
      baseUrl: BASE_URL,
      fetch: api.fetch,
      initialTokens: CREATED_SSE,
    });
    const statuses: string[] = [];
    feed.on("status", (s) => statuses.push(s));
    feed.start();
    await flush();
    // After the disconnect, a stale connect must not mark the feed live, and a
    // second disconnect must not count as another drop (which doubles the backoff).
    first.push(DISCONNECT_FRAME + CONNECT_FRAME + DISCONNECT_FRAME);
    await flush();
    expect(statuses).toEqual(["connecting", "reconnecting"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.count("heartbeat")).toBe(1);
    await feed.stop({ deleteFeed: false });
  });

  it("ignores connect, disconnect and publications from a stream that was replaced", async () => {
    const api = fakeApi();
    const first = sseStream({ ignoreAbort: true });
    const second = sseStream();
    api.queue("sse", (init) => first.respond(init));
    api.queue("sse", (init) => second.respond(init));
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    const feed = attachFeed({
      feedId: FEED_ID,
      feedToken: FEED_TOKEN,
      baseUrl: BASE_URL,
      fetch: api.fetch,
      initialTokens: CREATED_SSE,
    });
    const statuses: string[] = [];
    let updates = 0;
    feed.on("status", (s) => statuses.push(s));
    feed.on("update", () => (updates += 1));
    feed.start();
    await flush();
    // A scheduled refresh replaces the first stream with the second.
    await vi.advanceTimersByTimeAsync(CREATED_SSE.heartbeat_interval * 1000);
    expect(api.count("sse")).toBe(2);

    // The old stream still delivers buffered frames after being replaced.
    first.push(CONNECT_FRAME + pubFrame(UPDATE) + DISCONNECT_FRAME);
    await flush();
    expect(statuses).toEqual(["connecting"]);
    expect(updates).toBe(0);
    expect(second.aborted).toBe(false);
    expect(api.count("heartbeat")).toBe(1);

    second.push(CONNECT_FRAME + pubFrame(UPDATE));
    await flush();
    expect(statuses).toEqual(["connecting", "live"]);
    expect(updates).toBe(1);
    await feed.stop({ deleteFeed: false });
  });
});
