import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AttachOptions, attachFeed } from "../src/feed.js";
import type {
  EndReason,
  FeedMachineState,
  FeedMachinesChange,
  FeedStatus,
  FeedUpdate,
} from "../src/types.js";
import { FakeCentrifuge } from "./fake-centrifuge.js";
import {
  BASE_URL,
  CREATED_SDK,
  CREATED_SSE,
  ERRORS,
  FEED_ID,
  FEED_TOKEN,
  SSE_ENDPOINT,
  heartbeatSse,
  jwt,
  withEndpoint,
} from "./fixtures/api.js";
import { CONNECT_FRAME, DISCONNECT_FRAME, UPDATE, pubFrame } from "./fixtures/messages.js";
import { fakeApi, flush, json, sseStream } from "./helpers.js";

vi.mock("centrifuge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("centrifuge")>();
  const { FakeCentrifuge } = await import("./fake-centrifuge.js");
  return { ...actual, Centrifuge: FakeCentrifuge };
});

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

/** Queue a hand-driven SSE stream as the next response from the Centrifugo endpoint. */
function queueStream(api: ReturnType<typeof fakeApi>, status = 200) {
  const stream = sseStream();
  api.queue("sse", (init) => stream.respond(init, status));
  return stream;
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

describe("sse transport: streaming", () => {
  it("opens uni_sse by POSTing the connect command, keeping the token out of the URL", async () => {
    const { api, feed, statuses, updates } = setup();
    const stream = queueStream(api);
    feed.start();
    await flush();

    const call = api.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers).toMatchObject({
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    });
    expect(call.url).toBe(SSE_ENDPOINT);
    expect(call.body).toEqual({ token: CREATED_SSE.connection_token });
    expect(FakeCentrifuge.instances).toHaveLength(0);

    stream.push(CONNECT_FRAME);
    await flush();
    expect(statuses).toEqual(["connecting", "live"]);

    stream.push(pubFrame(UPDATE));
    await flush();
    expect(updates).toEqual([UPDATE]);
  });

  it("parses frames split across chunks, including inside a multi-byte character", async () => {
    const { api, feed, updates } = setup();
    const stream = queueStream(api);
    feed.start();
    await flush();
    const accented = {
      ...UPDATE,
      payload: { machines: [{ ...UPDATE.payload.machines[0]!, game_name: "Café Pinball ★" }] },
    };
    const bytes = new TextEncoder().encode(pubFrame(accented));
    const star = bytes.findIndex((b) => b === 0xe2);
    stream.pushBytes(bytes.slice(0, 5));
    stream.pushBytes(bytes.slice(5, star + 1));
    stream.pushBytes(bytes.slice(star + 1, star + 2));
    await flush();
    expect(updates).toEqual([]);
    stream.pushBytes(bytes.slice(star + 2, bytes.length - 1));
    stream.pushBytes(bytes.slice(bytes.length - 1));
    await flush();
    expect(updates).toEqual([accented]);
  });

  it("accepts an unwrapped publication and ignores junk, pings and other messages", async () => {
    const { api, feed, updates, errors } = setup();
    const stream = queueStream(api);
    feed.start();
    await flush();
    stream.push("data: not json\n\n");
    stream.push("data: null\n\n");
    stream.push(": ping\n\n");
    stream.push(`data: {}\n\n`);
    stream.push(pubFrame({ type: "other" }));
    stream.push(`data: ${JSON.stringify({ pub: { data: UPDATE } })}\n\n`);
    await flush();
    expect(updates).toEqual([UPDATE]);
    expect(errors).toEqual([]);
  });

  it("reopens the stream with the fresh token after each scheduled refresh", async () => {
    const { api, feed, updates } = setup();
    const first = queueStream(api);
    const second = queueStream(api);
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    feed.start();
    await flush();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(api.count("heartbeat")).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(1);
    expect(first.aborted).toBe(true);
    const reopened = api.calls.filter((c) => c.key === "sse")[1]!;
    expect(reopened.body).toEqual({ token: jwt("sseconn2") });

    second.push(pubFrame(UPDATE));
    await flush();
    expect(updates).toEqual([UPDATE]);
  });

  it("reopens on the endpoint each heartbeat names", async () => {
    const moved = "https://moved.test.invalid/connection/uni_sse";
    const { api, feed } = setup();
    queueStream(api);
    queueStream(api);
    queueStream(api);
    api.queue(
      "heartbeat",
      json(200, heartbeatSse(2)),
      json(200, withEndpoint(heartbeatSse(3), moved)),
    );
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    const urls = api.calls.filter((c) => c.key === "sse").map((c) => c.url);
    expect(urls).toEqual([SSE_ENDPOINT, SSE_ENDPOINT, moved]);
  });

  it("never reopens on the create response's endpoint when a heartbeat omits it", async () => {
    const { api, feed, errors } = setup();
    queueStream(api);
    queueStream(api);
    api.queue(
      "heartbeat",
      json(200, { ...heartbeatSse(2), sse_endpoint: undefined }),
      json(200, heartbeatSse(3)),
    );
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(errors.map((e) => e.message)).toEqual([
      "malformed heartbeat response: bad sse_endpoint",
    ]);
    // Still the one stream from create: the endpoint it held was not reused.
    expect(api.count("sse")).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.calls.filter((c) => c.key === "sse").map((c) => c.body)).toEqual([
      { token: CREATED_SSE.connection_token },
      { token: jwt("sseconn3") },
    ]);
  });

  it("switches transport when the server's tokens say so", async () => {
    const { api, feed } = setup({ initialTokens: CREATED_SDK });
    const stream = queueStream(api);
    api.queue("heartbeat", json(200, withEndpoint(heartbeatSse(2), SSE_ENDPOINT)));
    feed.start();
    const client = FakeCentrifuge.last;
    client.emit("disconnected", { code: 3503, reason: "force disconnect" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.disconnectCalls).toBe(1);
    expect(api.count("sse")).toBe(1);
    stream.push(CONNECT_FRAME);
    await flush();
    expect(feed.status).toBe("live");
  });
});

describe("live machine set (feeds that follow their venues)", () => {
  const [A, B] = UPDATE.payload.machines as [FeedMachineState, FeedMachineState];
  const withMachines = (...machines: FeedMachineState[]) => ({
    ...UPDATE,
    payload: { machines },
  });

  it("starts from the create response and reports machines joining and leaving", async () => {
    const { api, feed, updates } = setup();
    const changes: FeedMachinesChange[] = [];
    const order: string[] = [];
    feed.on("machines", (change) => {
      changes.push(change);
      order.push("machines");
    });
    feed.on("update", () => order.push("update"));
    const stream = queueStream(api);
    expect(feed.machines).toEqual([A.machine_uuid]);
    feed.start();
    await flush();

    stream.push(pubFrame(withMachines(A)));
    await flush();
    expect(changes).toEqual([]);

    stream.push(pubFrame(withMachines(A, B)));
    await flush();
    stream.push(pubFrame(withMachines(B)));
    await flush();
    stream.push(pubFrame(withMachines()));
    await flush();

    expect(changes).toEqual([
      { added: [B.machine_uuid], removed: [], machines: [A.machine_uuid, B.machine_uuid] },
      { added: [], removed: [A.machine_uuid], machines: [B.machine_uuid] },
      { added: [], removed: [B.machine_uuid], machines: [] },
    ]);
    expect(order).toEqual([
      "update",
      "machines",
      "update",
      "machines",
      "update",
      "machines",
      "update",
    ]);
    expect(updates).toHaveLength(4);
    // An emptied venue is not an ended feed.
    expect(feed.machines).toEqual([]);
    expect(feed.status).not.toBe("ended");
  });

  it("starts empty when created over venues with no machines, and fills as they join", async () => {
    const { api, feed, updates } = setup({ initialTokens: { ...CREATED_SSE, machines: [] } });
    const changes: FeedMachinesChange[] = [];
    feed.on("machines", (change) => changes.push(change));
    const stream = queueStream(api);
    expect(feed.machines).toEqual([]);
    feed.start();
    await flush();
    // An empty publication is valid: the feed carries nothing yet, and nothing changed.
    stream.push(pubFrame(withMachines()));
    await flush();
    stream.push(pubFrame(withMachines(A)));
    await flush();
    expect(updates.map((u) => u.payload.machines.length)).toEqual([0, 1]);
    expect(changes).toEqual([{ added: [A.machine_uuid], removed: [], machines: [A.machine_uuid] }]);
  });

  it("learns the set from the first update when attaching without a create response", async () => {
    const { api, feed } = setup({ initialTokens: heartbeatSse(1) });
    const changes: FeedMachinesChange[] = [];
    feed.on("machines", (change) => changes.push(change));
    const stream = queueStream(api);
    expect(feed.machines).toEqual([]);
    feed.start();
    await flush();
    stream.push(pubFrame(withMachines(B, A)));
    await flush();
    expect(changes).toEqual([
      {
        added: [B.machine_uuid, A.machine_uuid],
        removed: [],
        machines: [B.machine_uuid, A.machine_uuid],
      },
    ]);
  });
});

describe("sse transport: channels", () => {
  it.each([
    ["wrapped, own channel", pubFrame(UPDATE)],
    [
      "top-level channel, as the uni protocol docs show",
      `data: ${JSON.stringify({ channel: CREATED_SSE.channel, pub: { data: UPDATE } })}\n\n`,
    ],
    [
      "no channel (the server-side subscription)",
      `data: ${JSON.stringify({ pub: { data: UPDATE } })}\n\n`,
    ],
  ])("accepts a publication: %s", async (_label, frame) => {
    const { api, feed, updates, errors } = setup();
    const stream = queueStream(api);
    feed.start();
    await flush();
    stream.push(frame);
    await flush();
    expect(updates).toEqual([UPDATE]);
    expect(errors).toEqual([]);
  });

  it.each([
    ["wrapped", pubFrame(UPDATE, "data_feed:f_someone_else")],
    [
      "top-level",
      `data: ${JSON.stringify({ channel: "data_feed:f_someone_else", pub: { data: UPDATE } })}\n\n`,
    ],
    ["a non-string channel", `data: ${JSON.stringify({ channel: 7, pub: { data: UPDATE } })}\n\n`],
  ])("drops a publication for another channel (%s) with an error", async (_label, frame) => {
    const { api, feed, updates, errors, statuses } = setup();
    const stream = queueStream(api);
    feed.start();
    await flush();
    stream.push(CONNECT_FRAME + frame);
    await flush();
    expect(updates).toEqual([]);
    expect(errors.map((e) => e.message)).toEqual(["publication for another channel dropped"]);
    expect(statuses.at(-1)).toBe("live");
  });
});

describe("sse transport: disconnects and failures", () => {
  it("refreshes at once on a disconnect push after a stable session, and reconnects with the fresh token", async () => {
    const { api, feed, statuses } = setup();
    const first = queueStream(api);
    queueStream(api);
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    feed.start();
    await flush();
    first.push(CONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(30_000);
    first.push(DISCONNECT_FRAME + pubFrame(UPDATE));
    // At once, give or take the spread (none here: Math.random is pinned to 0).
    await vi.advanceTimersByTimeAsync(0);
    expect(first.aborted).toBe(true);
    expect(api.count("heartbeat")).toBe(1);
    expect(statuses).toEqual(["connecting", "live", "reconnecting"]);
    const reopened = api.calls.filter((c) => c.key === "sse")[1]!;
    expect(reopened.body).toEqual({ token: jwt("sseconn2") });
  });

  it("spreads the refresh after a stable session's drop over up to a second", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { api, feed } = setup();
    const first = queueStream(api);
    queueStream(api);
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    feed.start();
    await flush();
    first.push(CONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(30_000);
    first.push(DISCONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(499);
    expect(api.count("heartbeat")).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(1);
  });

  it("jitters the reconnect backoff and the no-reconnect wait", async () => {
    // 0.5 puts each wait at three quarters of its top: 1s becomes 750ms, 30s 22.5s.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { api, feed } = setup();
    const streams = Array.from({ length: 3 }, () => queueStream(api));
    api.queue("heartbeat", ...[2, 3].map((n) => json(200, heartbeatSse(n))));
    feed.start();
    await flush();
    streams[0]!.push(CONNECT_FRAME + DISCONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(749);
    expect(api.count("heartbeat")).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(1);
    streams[1]!.push(
      CONNECT_FRAME + `data: ${JSON.stringify({ push: { disconnect: { code: 3503 } } })}\n\n`,
    );
    await vi.advanceTimersByTimeAsync(22_499);
    expect(api.count("heartbeat")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(2);
  });

  it("cannot refresh faster than the backoff when disconnects come right after connecting", async () => {
    const { api, feed } = setup();
    const streams = Array.from({ length: 5 }, () => queueStream(api));
    api.queue("heartbeat", ...[2, 3, 4, 5].map((n) => json(200, heartbeatSse(n))));
    feed.start();
    await flush();
    let t = 0;
    for (const [i, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
      streams[i]!.push(CONNECT_FRAME + DISCONNECT_FRAME);
      await flush();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(api.count("heartbeat")).toBe(i);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.count("heartbeat")).toBe(i + 1);
      t += delay;
    }
    // Fifteen seconds of storm cost four heartbeats, not dozens.
    expect(t).toBe(15_000);
    expect(api.count("sse")).toBe(5);
  });

  it("resets the backoff only after a sustained live session", async () => {
    const { api, feed } = setup();
    const streams = Array.from({ length: 4 }, () => queueStream(api));
    api.queue("heartbeat", ...[2, 3, 4].map((n) => json(200, heartbeatSse(n))));
    feed.start();
    await flush();
    streams[0]!.push(CONNECT_FRAME + DISCONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(1_000);
    streams[1]!.push(CONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(30_000);
    streams[1]!.push(DISCONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.count("heartbeat")).toBe(2);
    // The next quick drop starts the backoff from the bottom again.
    streams[2]!.push(CONNECT_FRAME + DISCONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(999);
    expect(api.count("heartbeat")).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(3);
  });

  it.each([
    ["a no-reconnect code", 3503],
    ["a custom no-reconnect code", 4501],
  ])("backs off hard on %s", async (_label, code) => {
    const { api, feed } = setup();
    const stream = queueStream(api);
    queueStream(api);
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    feed.start();
    await flush();
    stream.push(CONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(60_000);
    stream.push(`data: ${JSON.stringify({ push: { disconnect: { code, reason: "x" } } })}\n\n`);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(api.count("heartbeat")).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("heartbeat")).toBe(1);
  });

  it("treats a disconnect push without a code as reconnectable", async () => {
    const { api, feed } = setup();
    const stream = queueStream(api);
    queueStream(api);
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    feed.start();
    await flush();
    stream.push(`data: ${JSON.stringify({ disconnect: { reason: "x" } })}\n\n`);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.count("heartbeat")).toBe(1);
  });

  it("ends as withdrawn when the refresh after a disconnect answers 403", async () => {
    const { api, feed, ended } = setup();
    const stream = queueStream(api);
    api.queue("heartbeat", json(403, ERRORS.withdrawn));
    feed.start();
    await flush();
    stream.push(DISCONNECT_FRAME);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ended).toEqual(["withdrawn"]);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(api.count("heartbeat")).toBe(1);
    expect(api.count("sse")).toBe(1);
  });

  it.each([
    [
      "the server closes the stream",
      (s: ReturnType<typeof sseStream>) => s.close(),
      /closed by the server/,
    ],
    [
      "the stream errors",
      (s: ReturnType<typeof sseStream>) => s.fail(new Error("socket reset")),
      /socket reset/,
    ],
  ])("when %s it backs off, refreshes and reopens", async (_label, breakIt, message) => {
    const { api, feed, errors, statuses } = setup();
    const first = queueStream(api);
    queueStream(api);
    api.queue("heartbeat", json(200, heartbeatSse(2)));
    feed.start();
    await flush();
    first.push(CONNECT_FRAME);
    await flush();
    breakIt(first);
    await flush();
    expect(errors[0]!.message).toMatch(message);
    expect(statuses.at(-1)).toBe("reconnecting");
    expect(api.count("heartbeat")).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.count("heartbeat")).toBe(1);
    expect(api.count("sse")).toBe(2);
  });

  it("treats a refused stream or a missing body as a lost connection", async () => {
    const { api, feed, errors } = setup();
    queueStream(api, 401);
    api.queue("sse", new Response(null, { status: 200 }));
    queueStream(api);
    api.queue("heartbeat", json(200, heartbeatSse(2)), json(200, heartbeatSse(3)));
    feed.start();
    await flush();
    expect(errors[0]!.message).toBe("SSE connection failed: SSE endpoint answered 401");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(errors[1]!.message).toBe("SSE connection failed: SSE endpoint answered 200");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.count("sse")).toBe(3);
  });

  it("never puts a token in an error message", async () => {
    const { api, feed, errors } = setup();
    api.queue(
      "sse",
      new TypeError(`fetch failed: ${SSE_ENDPOINT} {"token":"${CREATED_SSE.connection_token}"}`),
    );
    api.queue("sse", () => Promise.reject(`gone ${FEED_TOKEN}`));
    queueStream(api);
    api.queue("heartbeat", json(200, heartbeatSse(2)), json(200, heartbeatSse(3)));
    feed.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const text = errors.map((e) => e.message).join("\n");
    expect(errors).toHaveLength(2);
    expect(text).not.toContain(CREATED_SSE.connection_token);
    expect(text).not.toContain(FEED_TOKEN);
    expect(text).toContain("[redacted]");
  });
});

describe("sse transport: stop", () => {
  it("aborts the stream, deletes the feed, and fires nothing afterwards", async () => {
    const { api, feed, updates, statuses, ended } = setup();
    const stream = queueStream(api);
    api.queue("delete", new Response(null, { status: 204 }));
    feed.start();
    await flush();
    stream.push(CONNECT_FRAME);
    await flush();
    await feed.stop();
    expect(stream.aborted).toBe(true);
    expect(api.count("delete")).toBe(1);
    expect(ended).toEqual(["stopped"]);
    expect(vi.getTimerCount()).toBe(0);
    const before = [updates.length, statuses.length];
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect([updates.length, statuses.length]).toEqual(before);
    expect(api.count("heartbeat")).toBe(0);
  });

  it("drops a frame that was already read when stop lands mid-chunk", async () => {
    const { api, feed, updates } = setup();
    const stream = queueStream(api);
    feed.start();
    await flush();
    feed.on("status", (status) => {
      if (status === "live") void feed.stop({ deleteFeed: false });
    });
    stream.push(CONNECT_FRAME + pubFrame(UPDATE));
    await flush();
    expect(updates).toEqual([]);
    expect(feed.status).toBe("ended");
  });

  it("stops reading a body that keeps delivering after stop", async () => {
    const { api, feed, updates, statuses } = setup();
    const stream = sseStream({ ignoreAbort: true });
    api.queue("sse", (init) => stream.respond(init));
    feed.start();
    await flush();
    await feed.stop({ deleteFeed: false });
    stream.push(CONNECT_FRAME + pubFrame(UPDATE));
    await flush();
    expect(updates).toEqual([]);
    expect(statuses).toEqual(["connecting", "ended"]);
  });

  it("ignores a stream that resolves after stop", async () => {
    const { api, feed, statuses } = setup();
    let release!: (r: Response) => void;
    const stream = sseStream();
    api.queue(
      "sse",
      (init) => new Promise<Response>((resolve) => (release = () => resolve(stream.respond(init)))),
    );
    feed.start();
    await flush();
    await feed.stop({ deleteFeed: false });
    release(new Response(null));
    await flush();
    expect(statuses).toEqual(["connecting", "ended"]);
  });
});
