/*
 * Re-entrancy: any listener may call stop() synchronously, from inside any
 * emit. After that, the feed must do nothing more: no further events, no timer,
 * no open transport, and at most one DELETE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AttachOptions, type Feed, type FeedEvents, attachFeed } from "../src/feed.js";
import {
  BASE_URL,
  CREATED_SSE,
  FEED_ID,
  FEED_TOKEN,
  MACHINE_B,
  heartbeatSse,
} from "./fixtures/api.js";
import { CONNECT_FRAME, DISCONNECT_FRAME, UPDATE, pubFrame } from "./fixtures/messages.js";
import { fakeApi, flush, json, sseStream } from "./helpers.js";

const INTERVAL_MS = CREATED_SSE.heartbeat_interval * 1000;
const EVENTS: (keyof FeedEvents)[] = ["status", "update", "machines", "error", "ended"];

type Ctx = {
  api: ReturnType<typeof fakeApi>;
  feed: Feed;
  streams: ReturnType<typeof sseStream>[];
};

const withB = {
  ...UPDATE,
  payload: {
    machines: [
      UPDATE.payload.machines[0]!,
      { ...UPDATE.payload.machines[1]!, machine_uuid: MACHINE_B },
    ],
  },
};

const cases: {
  name: string;
  event: keyof FeedEvents;
  /** Which delivery stops the feed; the first by default. */
  when?: (value: unknown) => boolean;
  drive: (ctx: Ctx) => Promise<void>;
  attach?: Partial<AttachOptions>;
}[] = [
  {
    name: "status `connecting`, inside start()",
    event: "status",
    drive: async ({ feed }) => {
      feed.start();
      await flush();
    },
  },
  {
    name: "status `live`, with more frames in the same chunk",
    event: "status",
    drive: async ({ feed, streams }) => {
      feed.start();
      await flush();
      streams[0]!.push(CONNECT_FRAME + pubFrame(UPDATE) + pubFrame(UPDATE));
      await flush();
    },
  },
  {
    name: "update, with another update in the same chunk",
    event: "update",
    drive: async ({ feed, streams }) => {
      feed.start();
      await flush();
      streams[0]!.push(pubFrame(UPDATE) + pubFrame(UPDATE));
      await flush();
    },
  },
  {
    name: "machines, before the update that carried the change",
    event: "machines",
    drive: async ({ feed, streams }) => {
      feed.start();
      await flush();
      streams[0]!.push(pubFrame(withB));
      await flush();
    },
  },
  {
    name: "error from a failed heartbeat, before its retry is scheduled",
    event: "error",
    drive: async ({ api, feed }) => {
      api.queue("heartbeat", json(503));
      feed.start();
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    },
  },
  {
    name: "error from a lost stream, before its reconnect is scheduled",
    event: "error",
    drive: async ({ feed, streams }) => {
      feed.start();
      await flush();
      streams[0]!.close();
      await flush();
    },
  },
  {
    name: "status `reconnecting`, before a reconnect is scheduled",
    event: "status",
    when: (status) => status === "reconnecting",
    drive: async ({ feed, streams }) => {
      feed.start();
      await flush();
      streams[0]!.push(CONNECT_FRAME + DISCONNECT_FRAME);
      await flush();
    },
  },
  {
    name: "error from a feed with no endpoint, before it ends itself",
    event: "error",
    drive: async ({ api, feed }) => {
      api.queue("heartbeat", json(200, heartbeatSse(2)));
      feed.start();
      await flush();
    },
    attach: { initialTokens: undefined },
  },
  {
    name: "ended, when the server ended the feed",
    event: "ended",
    drive: async ({ api, feed }) => {
      api.queue("heartbeat", json(404));
      feed.start();
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    },
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a listener that calls stop() during an emit", () => {
  it.each(cases)("$name", async ({ event, when, drive, attach }) => {
    const api = fakeApi();
    const streams = [sseStream(), sseStream()];
    for (const stream of streams) api.queue("sse", (init) => stream.respond(init));
    api.queue("delete", new Response(null, { status: 204 }));
    const feed = attachFeed({
      feedId: FEED_ID,
      feedToken: FEED_TOKEN,
      baseUrl: BASE_URL,
      fetch: api.fetch,
      initialTokens: CREATED_SSE,
      ...attach,
    });

    const seen: string[] = [];
    for (const name of EVENTS) feed.on(name, () => seen.push(name));
    let fired = false;
    feed.on(event, (value: unknown) => {
      if (fired || (when && !when(value))) return;
      fired = true;
      void feed.stop();
    });
    // Registered after the stopper: must never hear anything after the end.
    const late: string[] = [];
    for (const name of EVENTS) feed.on(name, () => late.push(name));

    await drive({ api, feed, streams });
    const requests = api.calls.length;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await flush();

    expect(fired).toBe(true);
    // `ended` exactly once, and nothing after it.
    expect(seen.filter((name) => name === "ended")).toHaveLength(1);
    expect(seen.at(-1)).toBe("ended");
    expect(late.filter((name) => name === "ended")).toHaveLength(1);
    expect(late.at(-1)).toBe("ended");
    expect(vi.getTimerCount()).toBe(0);
    // No transport left open, and no request once stopped beyond the one DELETE.
    expect(streams.every((stream, i) => stream.aborted || api.count("sse") <= i)).toBe(true);
    expect(api.count("delete")).toBeLessThanOrEqual(1);
    expect(api.calls.length).toBe(requests);
  });
});
