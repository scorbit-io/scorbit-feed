import { UnauthorizedError } from "centrifuge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AttachOptions, attachFeed } from "../src/feed.js";
import { FeedError } from "../src/http.js";
import type { EndReason, FeedStatus, FeedUpdate } from "../src/types.js";
import { FakeCentrifuge, FakeSubscription } from "./fake-centrifuge.js";
import {
  API_KEY,
  BASE_URL,
  CREATED_SDK,
  ERRORS,
  FEED_ID,
  FEED_TOKEN,
  WS_ENDPOINT,
  heartbeatSdk,
  jwt,
  withEndpoint,
} from "./fixtures/api.js";
import { UPDATE } from "./fixtures/messages.js";
import { deferred, fakeApi, flush, json } from "./helpers.js";

vi.mock("centrifuge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("centrifuge")>();
  const { FakeCentrifuge } = await import("./fake-centrifuge.js");
  return { ...actual, Centrifuge: FakeCentrifuge };
});

const INTERVAL_MS = CREATED_SDK.heartbeat_interval * 1000;
const FakeWebSocket = function FakeWebSocket() {};

function setup(extra: Partial<AttachOptions> = {}) {
  const api = fakeApi();
  const feed = attachFeed({
    feedId: FEED_ID,
    feedToken: FEED_TOKEN,
    baseUrl: BASE_URL,
    fetch: api.fetch,
    websocket: FakeWebSocket,
    initialTokens: CREATED_SDK,
    ...extra,
  });
  const updates: FeedUpdate[] = [];
  const statuses: FeedStatus[] = [];
  const ended: EndReason[] = [];
  const errors: Error[] = [];
  feed.on("update", (u) => updates.push(u));
  feed.on("status", (s) => statuses.push(s));
  feed.on("ended", ({ reason }) => ended.push(reason));
  feed.on("error", (e) => errors.push(e));
  return { api, feed, updates, statuses, ended, errors };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // No jitter: each wait is the top of its range (jitter has its own tests).
  vi.spyOn(Math, "random").mockReturnValue(0);
  FakeCentrifuge.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("attachFeed credential guard", () => {
  it.each([
    [API_KEY, /sb_live_ API key/],
    ["not-a-token", /sbf_ feed token/],
    ["", /sbf_ feed token/],
    [undefined, /sbf_ feed token/],
  ])("refuses %s before any network call", (token, message) => {
    const api = fakeApi();
    expect(() =>
      attachFeed({ feedId: FEED_ID, feedToken: token as string, fetch: api.fetch }),
    ).toThrow(message);
    expect(api.calls).toHaveLength(0);
    expect(FakeCentrifuge.instances).toHaveLength(0);
  });

  it("needs a feed id", () => {
    expect(() => attachFeed({ feedId: "", feedToken: FEED_TOKEN })).toThrow(/feedId/);
  });
});

describe("sdk transport: connecting", () => {
  it("connects with the create response's tokens, fossil delta, and no first heartbeat", () => {
    const { api, feed, statuses } = setup();
    feed.start();

    const client = FakeCentrifuge.last;
    expect(client.endpoint).toBe(WS_ENDPOINT);
    expect(client.options.token).toBe(CREATED_SDK.connection_token);
    expect(client.options.websocket).toBe(FakeWebSocket);
    expect(client.sub.channel).toBe(CREATED_SDK.channel);
    expect(client.sub.options).toMatchObject({
      token: CREATED_SDK.subscription_token,
      delta: "fossil",
      positioned: true,
      recoverable: true,
    });
    expect(client.sub.subscribeCalls).toBe(1);
    expect(client.connectCalls).toBe(1);
    expect(api.calls).toHaveLength(0);
    expect(statuses).toEqual(["connecting"]);

    client.emit("connecting", { code: 0, reason: "connect called" });
    client.sub.emit("subscribing", { code: 0, reason: "subscribe called" });
    client.sub.emit("subscribed", {});
    expect(feed.status).toBe("live");
    expect(statuses).toEqual(["connecting", "live"]);
  });

  it("leaves the WebSocket choice to the SDK when none is injected", () => {
    const { feed } = setup({ websocket: undefined });
    feed.start();
    expect("websocket" in FakeCentrifuge.last.options).toBe(false);
  });

  it("start() is idempotent and does nothing after stop()", async () => {
    const { api, feed } = setup();
    api.queue("delete", new Response(null, { status: 204 }));
    feed.start();
    feed.start();
    expect(FakeCentrifuge.instances).toHaveLength(1);
    await feed.stop();
    feed.start();
    expect(FakeCentrifuge.instances).toHaveLength(1);
  });

  it("emits parsed updates and ignores other publications", () => {
    const { feed, updates } = setup();
    feed.start();
    FakeCentrifuge.last.sub.emit("publication", { data: UPDATE });
    FakeCentrifuge.last.sub.emit("publication", { data: { type: "something_else" } });
    expect(updates).toEqual([UPDATE]);
  });

  it("reports SDK reconnects as status and SDK errors as redacted error events", () => {
    const { feed, statuses, errors } = setup();
    feed.start();
    const client = FakeCentrifuge.last;
    client.sub.emit("subscribed", {});
    client.emit("connecting", { code: 1, reason: "transport closed" });
    expect(feed.status).toBe("reconnecting");
    client.sub.emit("subscribed", {});
    client.sub.emit("subscribing", { code: 1, reason: "transport closed" });
    expect(statuses).toEqual(["connecting", "live", "reconnecting", "live", "reconnecting"]);

    client.emit("error", { type: "transport", error: { code: 2, message: `bad ${jwt("x")}` } });
    // Token errors come from our own getToken; the feed has reported them already.
    client.emit("error", { type: "refreshToken", error: { code: 6, message: "x" } });
    client.emit("error", { type: "connectToken", error: { code: 5, message: "x" } });
    expect(errors.map((e) => e.message)).toEqual(["centrifugo transport error: bad [redacted]"]);
  });

  it("attaches without tokens in hand: heartbeat first, endpoint from the heartbeat", async () => {
    const { api, feed } = setup({ initialTokens: undefined });
    api.queue("heartbeat", json(200, heartbeatSdk(2)));
    feed.start();
    await flush();
    expect(api.calls[0]).toMatchObject({
      url: `${BASE_URL}/api/v2/data-feeds/${FEED_ID}/heartbeat/`,
      method: "POST",
      headers: { Authorization: `Bearer ${FEED_TOKEN}` },
    });
    expect(FakeCentrifuge.last.endpoint).toBe(WS_ENDPOINT);
    expect(FakeCentrifuge.last.sub.channel).toBe(`data_feed:${FEED_ID}`);
    expect(FakeCentrifuge.last.options.token).toBe(jwt("conn2"));
  });

  it("falls back to a heartbeat when the tokens in hand are unusable", async () => {
    // Rejected tokens are not trusted for anything, their endpoint included.
    const { api, feed } = setup({
      initialTokens: { ...CREATED_SDK, heartbeat_interval: 0 },
    });
    api.queue("heartbeat", json(200, heartbeatSdk(2)));
    feed.start();
    await flush();
    expect(api.count("heartbeat")).toBe(1);
    expect(FakeCentrifuge.instances).toHaveLength(1);
    expect(FakeCentrifuge.last.options.token).toBe(jwt("conn2"));
  });

  it("never connects on a heartbeat without its endpoint: it is retried, not ended", async () => {
    const { api, feed, ended, errors } = setup({ initialTokens: undefined });
    api.queue("heartbeat", json(200, { ...heartbeatSdk(2), ws_endpoint: undefined }));
    feed.start();
    await flush();
    expect(errors.map((e) => e.message)).toEqual(["malformed heartbeat response: bad ws_endpoint"]);
    expect(ended).toEqual([]);
    expect(FakeCentrifuge.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("takes no endpoint from the create response after the first connect", async () => {
    const { api, feed, errors } = setup();
    // The create response connected the feed; this refresh omits its endpoint.
    api.queue(
      "heartbeat",
      json(200, { ...heartbeatSdk(2), ws_endpoint: undefined }),
      json(200, heartbeatSdk(3)),
    );
    feed.start();
    const client = FakeCentrifuge.last;
    client.emit("disconnected", { code: 3503, reason: "force disconnect" });
    await vi.advanceTimersByTimeAsync(30_000);
    // Rejected rather than reopened on the endpoint from create.
    expect(errors.map((e) => e.message)).toEqual(["malformed heartbeat response: bad ws_endpoint"]);
    expect(FakeCentrifuge.instances).toEqual([client]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeCentrifuge.instances).toHaveLength(2);
    expect(FakeCentrifuge.last.options.token).toBe(jwt("conn3"));
  });
});

describe("sdk transport: token refresh", () => {
  it("refreshes at the server's interval and not before, then on the next interval it returns", async () => {
    const { api, feed } = setup();
    api.queue("heartbeat", json(200, heartbeatSdk(2, 500)), json(200, heartbeatSdk(3, 500)));
    feed.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(api.count("heartbeat")).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(1);

    await vi.advanceTimersByTimeAsync(500_000 - 1);
    expect(api.count("heartbeat")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(2);
    // A scheduled refresh does not reconnect: the SDK pulls the new tokens.
    expect(FakeCentrifuge.instances).toHaveLength(1);
  });

  it("serves the SDK the newest tokens, and heartbeats when the SDK asks again", async () => {
    const { api, feed } = setup();
    api.queue("heartbeat", json(200, heartbeatSdk(2)), json(200, heartbeatSdk(3)));
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    const client = FakeCentrifuge.last;

    await expect(client.options.getToken()).resolves.toBe(jwt("conn2"));
    await expect(client.sub.options.getToken!()).resolves.toBe(jwt("sub2"));
    expect(api.count("heartbeat")).toBe(1);

    // Asking again for the token it already has means the SDK found it stale.
    await expect(client.options.getToken()).resolves.toBe(jwt("conn3"));
    expect(api.count("heartbeat")).toBe(2);
    await expect(client.sub.options.getToken!()).resolves.toBe(jwt("sub3"));
    expect(api.count("heartbeat")).toBe(2);
  });

  it("shares one heartbeat between concurrent token requests (re-entrancy guard)", async () => {
    const { api, feed } = setup();
    const pending = deferred<Response>();
    api.queue("heartbeat", () => pending.promise);
    feed.start();
    const client = FakeCentrifuge.last;
    const a = client.options.getToken();
    const b = client.sub.options.getToken!();
    const c = client.options.getToken();
    await flush();
    expect(api.count("heartbeat")).toBe(1);
    pending.resolve(json(200, heartbeatSdk(2)));
    await expect(Promise.all([a, b, c])).resolves.toEqual([
      jwt("conn2"),
      jwt("sub2"),
      jwt("conn2"),
    ]);
    expect(api.count("heartbeat")).toBe(1);
  });

  it("tells the SDK to give up (UnauthorizedError) once the feed has ended", async () => {
    const { api, feed, ended } = setup();
    api.queue("heartbeat", json(404, ERRORS.notFound));
    feed.start();
    await expect(FakeCentrifuge.last.options.getToken()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(ended).toEqual(["ended"]);
  });

  it("tells the SDK to give up when an error listener stops the feed during a failed refresh", async () => {
    const { api, feed } = setup();
    api.queue("heartbeat", json(503));
    feed.on("error", () => void feed.stop({ deleteFeed: false }));
    feed.start();
    await expect(FakeCentrifuge.last.options.getToken()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes the SDK retry (plain error) when a refresh fails transiently", async () => {
    const { api, feed, errors } = setup();
    api.queue("heartbeat", json(503, ERRORS.storeUnavailable));
    feed.start();
    const error = await FakeCentrifuge.last.options.getToken().catch((e) => e);
    expect(error).toBeInstanceOf(FeedError);
    expect(error).not.toBeInstanceOf(UnauthorizedError);
    expect(errors[0]!.message).toMatch(/heartbeat failed: Scorbit API answered 503/);
  });

  it("treats a heartbeat answer without a usable interval as a failed refresh", async () => {
    const { api, feed, errors } = setup();
    api.queue("heartbeat", json(200, { ...heartbeatSdk(2), heartbeat_interval: null }));
    api.queue("heartbeat", json(200, heartbeatSdk(3)));
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(errors[0]!.message).toBe("malformed heartbeat response: bad heartbeat_interval");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.count("heartbeat")).toBe(2);
    await expect(FakeCentrifuge.last.options.getToken()).resolves.toBe(jwt("conn3"));
  });

  it("retries transient failures with backoff, keeps the connection's status, and recovers", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { api, feed, errors, statuses } = setup();
    api.queue(
      "heartbeat",
      json(503),
      new TypeError(`fetch failed for ${FEED_TOKEN}`),
      json(429, ERRORS.throttled),
      json(200, heartbeatSdk(2)),
      json(200, heartbeatSdk(3)),
    );
    feed.start();
    FakeCentrifuge.last.sub.emit("subscribed", {});
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(api.count("heartbeat")).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(api.count("heartbeat")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.count("heartbeat")).toBe(3);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(api.count("heartbeat")).toBe(4);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.message).join()).not.toContain(FEED_TOKEN);
    expect(statuses).toEqual(["connecting", "live"]);

    // Recovered: back on the server's interval, and the backoff has reset.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(api.count("heartbeat")).toBe(5);
  });

  it("caps the backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { api, feed } = setup();
    api.queue("heartbeat", ...Array.from({ length: 8 }, () => json(502)));
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 30_000);
    expect(api.count("heartbeat")).toBe(7);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(api.count("heartbeat")).toBe(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(8);
  });

  it.each([
    ["the feed store is unavailable", json(503, ERRORS.storeUnavailable)],
    ["a bare 503", json(503)],
  ])("retries a 503 (%s) with jittered backoff, never ending the feed", async (_label, answer) => {
    // Jitter keeps a retry in the upper half of the backoff: 1s becomes 750ms here.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { api, feed, ended, errors } = setup();
    api.queue("heartbeat", answer, json(503), json(200, heartbeatSdk(2)));
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(749);
    expect(api.count("heartbeat")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(2);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(api.count("heartbeat")).toBe(3);
    expect(errors.map((e) => e.message)[0]).toMatch(/^heartbeat failed: Scorbit API answered 503/);
    expect(ended).toEqual([]);
    expect(feed.status).toBe("connecting");
    await expect(FakeCentrifuge.last.options.getToken()).resolves.toBe(jwt("conn2"));
  });

  it("handles a non-Error rejection from fetch as transient", async () => {
    const { api, feed, errors } = setup();
    api.queue("heartbeat", () => Promise.reject("socket hang up"));
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(errors[0]!.message).toBe("heartbeat failed: request failed: socket hang up");
  });
});

describe("sdk transport: terminal answers", () => {
  it.each([
    [401, "unauthorized", ERRORS.badFeedToken],
    [403, "withdrawn", ERRORS.withdrawn],
    [403, "withdrawn", ERRORS.feedsSwitchedOff],
    [403, "withdrawn", ERRORS.suspended],
    [404, "ended", ERRORS.notFound],
  ] as const)(
    "a %i heartbeat ends the feed as %s and is never retried",
    async (status, reason, body) => {
      const { api, feed, ended, statuses } = setup();
      api.queue("heartbeat", json(status, body), json(200, heartbeatSdk(2)));
      feed.start();
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(ended).toEqual([reason]);
      expect(statuses.at(-1)).toBe("ended");
      expect(FakeCentrifuge.last.disconnectCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(api.count("heartbeat")).toBe(1);
      expect(api.count("delete")).toBe(0);
    },
  );
});

describe("sdk transport: disconnects", () => {
  it("backs off hard after a no-reconnect disconnect, then reconnects with fresh tokens", async () => {
    const { api, feed, statuses } = setup();
    api.queue("heartbeat", json(200, heartbeatSdk(2)));
    feed.start();
    const first = FakeCentrifuge.last;
    first.sub.emit("subscribed", {});
    // Even after a long, stable session: the server said not to reconnect.
    await vi.advanceTimersByTimeAsync(60_000);

    first.emit("disconnected", { code: 3503, reason: "force disconnect" });
    expect(statuses.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(api.count("heartbeat")).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(1);
    expect(first.disconnectCalls).toBe(1);
    expect(FakeCentrifuge.instances).toHaveLength(2);
    const second = FakeCentrifuge.last;
    expect(second.options.token).toBe(jwt("conn2"));
    expect(second.sub.options.token).toBe(jwt("sub2"));
    // The previous client is ignored from here on.
    first.sub.emit("publication", { data: UPDATE });
    first.sub.emit("subscribed", {});
    first.emit("disconnected", { code: 3503, reason: "late" });
    expect(api.count("heartbeat")).toBe(1);
    expect(feed.status).toBe("reconnecting");
  });

  it("treats another server unsubscribe code like a disconnect, and ignores a local one", async () => {
    const { api, feed } = setup();
    api.queue("heartbeat", json(403, ERRORS.withdrawn));
    feed.start();
    FakeCentrifuge.last.sub.emit("unsubscribed", { code: 0, reason: "unsubscribe called" });
    await flush();
    expect(api.count("heartbeat")).toBe(0);
    FakeCentrifuge.last.sub.emit("unsubscribed", { code: 2500, reason: "unsubscribed" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(api.count("heartbeat")).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(1);
    expect(feed.status).toBe("ended");
  });

  it.each([
    ["withdrawn", 403, ERRORS.withdrawn],
    ["withdrawn", 403, ERRORS.feedsSwitchedOff],
    ["ended", 404, ERRORS.notFound],
  ])(
    "heartbeats at once on a server unsubscribe, and ends as %s on a %i",
    async (reason, status, body) => {
      const { api, feed, statuses, ended } = setup();
      api.queue("heartbeat", json(status, body));
      feed.start();
      const client = FakeCentrifuge.last;
      client.sub.emit("subscribed", {});
      client.sub.emit("unsubscribed", { code: 2000, reason: "server unsubscribe" });
      expect(statuses.at(-1)).toBe("reconnecting");
      expect(client.disconnectCalls).toBe(1);
      await flush();
      expect(api.count("heartbeat")).toBe(1);
      expect(ended).toEqual([reason]);
      expect(FakeCentrifuge.instances).toHaveLength(1);
    },
  );

  it("reopens when the heartbeat after a server unsubscribe succeeds", async () => {
    const { api, feed } = setup();
    api.queue("heartbeat", json(200, heartbeatSdk(2)));
    feed.start();
    FakeCentrifuge.last.sub.emit("subscribed", {});
    FakeCentrifuge.last.sub.emit("unsubscribed", { code: 2000, reason: "server unsubscribe" });
    await flush();
    expect(api.count("heartbeat")).toBe(1);
    expect(FakeCentrifuge.instances).toHaveLength(2);
    expect(FakeCentrifuge.last.options.token).toBe(jwt("conn2"));
    FakeCentrifuge.last.sub.emit("subscribed", {});
    expect(feed.status).toBe("live");
  });

  it("backs off on a server unsubscribe that recurs before a stable session", async () => {
    const { api, feed } = setup();
    api.queue("heartbeat", ...[2, 3, 4].map((n) => json(200, heartbeatSdk(n))));
    feed.start();
    const unsubscribe = () => {
      FakeCentrifuge.last.sub.emit("subscribed", {});
      FakeCentrifuge.last.sub.emit("unsubscribed", { code: 2000, reason: "server unsubscribe" });
    };
    unsubscribe();
    await flush();
    expect(api.count("heartbeat")).toBe(1);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(api.count("heartbeat")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(2);
    // After a stable session the next one asks at once again.
    FakeCentrifuge.last.sub.emit("subscribed", {});
    await vi.advanceTimersByTimeAsync(30_000);
    FakeCentrifuge.last.sub.emit("unsubscribed", { code: 2000, reason: "server unsubscribe" });
    await flush();
    expect(api.count("heartbeat")).toBe(3);
  });

  it("merges a disconnect into a refresh already in flight, then reconnects", async () => {
    const { api, feed } = setup();
    const pending = deferred<Response>();
    api.queue("heartbeat", () => pending.promise);
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(api.count("heartbeat")).toBe(1);
    FakeCentrifuge.last.emit("disconnected", { code: 3503, reason: "force disconnect" });
    await flush();
    expect(api.count("heartbeat")).toBe(1);
    pending.resolve(json(200, heartbeatSdk(2)));
    await flush();
    expect(FakeCentrifuge.instances).toHaveLength(2);
    expect(FakeCentrifuge.last.options.token).toBe(jwt("conn2"));
  });

  it("takes the endpoint from every heartbeat", async () => {
    const moved = "wss://moved.test.invalid/connection/websocket";
    const { api, feed } = setup();
    api.queue(
      "heartbeat",
      json(200, heartbeatSdk(2)),
      json(200, withEndpoint(heartbeatSdk(3), moved)),
    );
    feed.start();
    FakeCentrifuge.last.emit("disconnected", { code: 3503, reason: "force disconnect" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeCentrifuge.last.endpoint).toBe(WS_ENDPOINT);
    FakeCentrifuge.last.emit("disconnected", { code: 3503, reason: "force disconnect" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeCentrifuge.last.endpoint).toBe(moved);
  });
});

describe("sdk transport: synchronous events while opening", () => {
  it("does nothing more when a listener stops the feed from inside the transport's open()", async () => {
    FakeSubscription.syncSubscribed = true;
    try {
      const { api, feed, ended } = setup();
      feed.on("status", (status) => {
        if (status === "live") void feed.stop({ deleteFeed: false });
      });
      feed.start();
      await flush();
      expect(ended).toEqual(["stopped"]);
      expect(vi.getTimerCount()).toBe(0);
      expect(FakeCentrifuge.last.disconnectCalls).toBe(1);
      expect(api.calls).toHaveLength(0);
    } finally {
      FakeSubscription.syncSubscribed = false;
    }
  });
});

describe("sdk transport: connection parameters that change", () => {
  it("rebuilds the client when a heartbeat moves the endpoint, and ignores the old one", async () => {
    const moved = "wss://moved.test.invalid/connection/websocket";
    const { api, feed, updates } = setup();
    api.queue("heartbeat", json(200, withEndpoint(heartbeatSdk(2), moved)));
    feed.start();
    const first = FakeCentrifuge.last;
    first.sub.emit("subscribed", {});
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(FakeCentrifuge.instances).toHaveLength(2);
    const second = FakeCentrifuge.last;
    expect(second.endpoint).toBe(moved);
    expect(second.options.token).toBe(jwt("conn2"));
    expect(second.sub.options.token).toBe(jwt("sub2"));
    expect(second.connectCalls).toBe(1);
    // The old client was closed first, and nothing it says any more counts.
    expect(first.disconnectCalls).toBe(1);
    first.sub.emit("publication", { data: UPDATE });
    first.emit("disconnected", { code: 3503, reason: "late" });
    expect(updates).toEqual([]);
    expect(api.count("heartbeat")).toBe(1);
    second.sub.emit("publication", { data: UPDATE });
    expect(updates).toEqual([UPDATE]);
  });

  it("keeps the client, and retries, when a heartbeat names another feed's channel", async () => {
    const { api, feed, errors } = setup();
    api.queue("heartbeat", json(200, { ...heartbeatSdk(2), channel: "data_feed:f_other" }));
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(errors.map((e) => e.message)).toEqual(["malformed heartbeat response: bad channel"]);
    expect(FakeCentrifuge.instances).toHaveLength(1);
    expect(FakeCentrifuge.last.disconnectCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps the same client when only the tokens change", async () => {
    const { api, feed } = setup();
    api.queue(
      "heartbeat",
      json(200, withEndpoint(heartbeatSdk(2), WS_ENDPOINT)),
      json(200, { ...heartbeatSdk(3), channel: CREATED_SDK.channel }),
    );
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(api.count("heartbeat")).toBe(2);
    expect(FakeCentrifuge.instances).toHaveLength(1);
    expect(FakeCentrifuge.last.disconnectCalls).toBe(0);
    await expect(FakeCentrifuge.last.options.getToken()).resolves.toBe(jwt("conn3"));
  });

  it("does not open a client from a refresh after the connection dropped", async () => {
    const moved = "wss://moved.test.invalid/connection/websocket";
    const { api, feed } = setup();
    const pending = deferred<Response>();
    api.queue("heartbeat", () => pending.promise);
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    // The connection drops while the scheduled heartbeat is in flight: the
    // refresh reopens exactly once, on the new endpoint.
    FakeCentrifuge.last.emit("disconnected", { code: 3503, reason: "force disconnect" });
    pending.resolve(json(200, withEndpoint(heartbeatSdk(2), moved)));
    await flush();
    expect(FakeCentrifuge.instances).toHaveLength(2);
    expect(FakeCentrifuge.last.endpoint).toBe(moved);
    expect(FakeCentrifuge.last.connectCalls).toBe(1);
  });
});

describe("sdk transport: stop", () => {
  it("deletes the feed with the feed token, clears timers and disconnects", async () => {
    const { api, feed, ended, statuses } = setup();
    api.queue("delete", new Response(null, { status: 204 }));
    feed.start();
    await feed.stop();
    expect(api.calls).toEqual([
      expect.objectContaining({
        method: "DELETE",
        url: `${BASE_URL}/api/v2/data-feeds/${FEED_ID}/`,
        headers: expect.objectContaining({ Authorization: `Bearer ${FEED_TOKEN}` }),
      }),
    ]);
    expect(FakeCentrifuge.last.disconnectCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(ended).toEqual(["stopped"]);
    expect(statuses.at(-1)).toBe("ended");
    expect(feed.status).toBe("ended");
  });

  it("fires nothing after stop, whatever the old client does", async () => {
    const { feed, updates, statuses, ended, errors } = setup();
    feed.start();
    const client = FakeCentrifuge.last;
    await feed.stop({ deleteFeed: false });
    const counts = [updates.length, statuses.length, ended.length, errors.length];
    client.sub.emit("publication", { data: UPDATE });
    client.sub.emit("subscribed", {});
    client.emit("error", { type: "transport", error: { code: 1, message: "x" } });
    client.emit("disconnected", { code: 3005, reason: "x" });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect([updates.length, statuses.length, ended.length, errors.length]).toEqual(counts);
  });

  it("tells the SDK to give up if it asks for a token after stop, without a request", async () => {
    const { api, feed } = setup();
    feed.start();
    const client = FakeCentrifuge.last;
    await feed.stop({ deleteFeed: false });
    await expect(client.options.getToken()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(api.calls).toHaveLength(0);
  });

  it("does no work when a heartbeat resolves after stop", async () => {
    const { api, feed, statuses, errors } = setup({ initialTokens: undefined });
    const pending = deferred<Response>();
    api.queue("heartbeat", () => pending.promise);
    feed.start();
    await flush();
    await feed.stop({ deleteFeed: false });
    pending.resolve(json(200, heartbeatSdk(2)));
    await flush();
    expect(FakeCentrifuge.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(statuses).toEqual(["connecting", "ended"]);
    expect(errors).toEqual([]);
  });

  it("does no work when a heartbeat fails after stop", async () => {
    const { api, feed, ended, errors } = setup({ initialTokens: undefined });
    const pending = deferred<Response>();
    api.queue("heartbeat", () => pending.promise);
    feed.start();
    await flush();
    await feed.stop({ deleteFeed: false });
    // A transient failure would otherwise arm a retry timer on a stopped feed.
    pending.resolve(json(503));
    await flush();
    expect(ended).toEqual(["stopped"]);
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deletes once, treats an already-deleted feed as success, and surfaces other failures", async () => {
    const a = setup();
    a.api.queue("delete", json(404, ERRORS.notFound));
    await expect(a.feed.stop()).resolves.toBeUndefined();
    await a.feed.stop();
    expect(a.api.count("delete")).toBe(1);

    const b = setup();
    b.api.queue("delete", json(500));
    await expect(b.feed.stop()).rejects.toMatchObject({ status: 500 });

    const c = setup();
    await c.feed.stop({ deleteFeed: false });
    expect(c.api.calls).toHaveLength(0);
  });

  it("uses the global fetch and the production API by default", async () => {
    const api = fakeApi();
    api.queue("delete", new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", api.fetch);
    try {
      const feed = attachFeed({ feedId: FEED_ID, feedToken: FEED_TOKEN });
      await feed.stop();
      expect(api.calls[0]!.url).toBe(`https://api.scorbit.io/api/v2/data-feeds/${FEED_ID}/`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
