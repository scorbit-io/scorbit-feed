/* Publications are validated at the boundary; a malformed one is dropped, never thrown. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachFeed } from "../src/feed.js";
import { asFeedUpdate, parsePublication } from "../src/message.js";
import { SseParser } from "../src/sse-parser.js";
import type { FeedUpdate } from "../src/types.js";
import { BASE_URL, CREATED_SSE, FEED_ID, FEED_TOKEN } from "./fixtures/api.js";
import { CONNECT_FRAME, UPDATE, pubFrame } from "./fixtures/messages.js";
import { fakeApi, flush, sseStream } from "./helpers.js";

const machine = UPDATE.payload.machines[0]!;
const score = machine.scores[0]!;
const withMachine = (patch: Record<string, unknown>) => ({
  ...UPDATE,
  payload: { machines: [{ ...machine, ...patch }] },
});
const withScore = (patch: Record<string, unknown>) =>
  withMachine({ scores: [{ ...score, ...patch }] });

describe("parsePublication", () => {
  it.each([
    ["metadata not an object", { ...UPDATE, metadata: "x" }, "metadata"],
    [
      "a numeric metadata.updated_at",
      { ...UPDATE, metadata: { updated_at: 5 } },
      "metadata.updated_at",
    ],
    ["no payload", { type: "data_feed_update" }, "machines"],
    ["machines not an array", { ...UPDATE, payload: { machines: {} } }, "machines"],
    ["a null machine", { ...UPDATE, payload: { machines: [null] } }, "machines[0]"],
    ["an array machine", { ...UPDATE, payload: { machines: [[]] } }, "machines[0]"],
    ["no machine_uuid", withMachine({ machine_uuid: undefined }), "machines[0].machine_uuid"],
    ["an empty machine_uuid", withMachine({ machine_uuid: "" }), "machines[0].machine_uuid"],
    ["a numeric game_name", withMachine({ game_name: 1 }), "machines[0].game_name"],
    [
      "a string game_in_progress",
      withMachine({ game_in_progress: "yes" }),
      "machines[0].game_in_progress",
    ],
    ["a numeric game_ended", withMachine({ game_ended: 1 }), "machines[0].game_ended"],
    ["a numeric updated_at", withMachine({ updated_at: 7 }), "machines[0].updated_at"],
    ["scores not an array", withMachine({ scores: null }), "machines[0].scores"],
    ["a null score", withMachine({ scores: [null] }), "machines[0].scores[0]"],
    ["a string position", withScore({ position: "1" }), "machines[0].scores[0].position"],
    ["an infinite score", withScore({ score: Infinity }), "machines[0].scores[0].score"],
    ["a string ball", withScore({ ball: "2" }), "machines[0].scores[0].ball"],
    ["modes not an array", withScore({ modes: "Multiball" }), "machines[0].scores[0].modes"],
    [
      "a player without a username",
      withScore({ player: { display_name: "x" } }),
      "machines[0].scores[0].player",
    ],
    ["a string player", withScore({ player: "pinwizard" }), "machines[0].scores[0].player"],
    [
      "a numeric display_name",
      withScore({ player: { username: "u", display_name: 3 } }),
      "machines[0].scores[0].player.display_name",
    ],
    ["a player left undefined", withScore({ player: undefined }), "machines[0].scores[0].player"],
  ])("rejects %s", (_label, data, problem) => {
    expect(parsePublication(data)).toEqual({ problem });
    expect(asFeedUpdate(data)).toBeUndefined();
  });

  it.each([
    ["the full fixture", UPDATE],
    ["no metadata", { ...UPDATE, metadata: undefined }],
    [
      "optional fields left out",
      withMachine({
        game_name: undefined,
        game_ended: undefined,
        updated_at: undefined,
        scores: [{ position: 1, score: 5, player: null }],
      }),
    ],
    [
      "a null ball and updated_at",
      withMachine({ updated_at: null, scores: [{ ...score, ball: null }] }),
    ],
    ["no machines", { ...UPDATE, payload: { machines: [] } }],
  ])("accepts %s", (_label, data) => {
    expect(parsePublication(data)).toEqual({ update: data as FeedUpdate });
  });

  it.each([null, "x", { type: "other" }, [UPDATE]])(
    "ignores %j, which is not a feed update",
    (data) => {
      expect(parsePublication(data)).toBeUndefined();
    },
  );
});

describe("a malformed publication on a live feed", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is dropped with an error event, and the feed carries on", async () => {
    const api = fakeApi();
    const stream = sseStream();
    api.queue("sse", (init) => stream.respond(init));
    const feed = attachFeed({
      feedId: FEED_ID,
      feedToken: FEED_TOKEN,
      baseUrl: BASE_URL,
      fetch: api.fetch,
      initialTokens: CREATED_SSE,
    });
    const updates: FeedUpdate[] = [];
    const errors: string[] = [];
    const machines: unknown[] = [];
    feed.on("update", (u) => updates.push(u));
    feed.on("error", (e) => errors.push(e.message));
    feed.on("machines", (m) => machines.push(m));
    feed.start();
    await flush();
    stream.push(
      CONNECT_FRAME + pubFrame({ ...UPDATE, payload: { machines: [null] } }) + pubFrame(UPDATE),
    );
    await flush();
    expect(errors).toEqual(["malformed publication dropped: bad machines[0]"]);
    expect(updates).toEqual([UPDATE]);
    expect(machines).toHaveLength(1);
    expect(feed.status).toBe("live");
    await feed.stop({ deleteFeed: false });
  });
});

describe("SseParser bound", () => {
  it("refuses an event larger than the bound, whether in one line or many", () => {
    expect(() => new SseParser(16).push("data: " + "x".repeat(20))).toThrow("SSE event too large");
    const parser = new SseParser(16);
    parser.push("data: 12345678\n");
    expect(() => parser.push("data: 12345678\n")).toThrow("SSE event too large");
  });

  it("resets the count after each event", () => {
    const parser = new SseParser(16);
    for (let i = 0; i < 10; i++) expect(parser.push("data: 1234567\n\n")).toEqual(["1234567"]);
  });

  it("is lost (and retried) when the server streams an oversized event", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const api = fakeApi();
      const stream = sseStream();
      api.queue("sse", (init) => stream.respond(init));
      const feed = attachFeed({
        feedId: FEED_ID,
        feedToken: FEED_TOKEN,
        baseUrl: BASE_URL,
        fetch: api.fetch,
        initialTokens: CREATED_SSE,
      });
      const errors: string[] = [];
      feed.on("error", (e) => errors.push(e.message));
      feed.start();
      await flush();
      stream.push("data: " + "x".repeat(1024 * 1024 + 1));
      await flush();
      expect(errors).toEqual(["SSE connection failed: SSE event too large"]);
      expect(stream.aborted).toBe(true);
      expect(feed.status).toBe("reconnecting");
      await feed.stop({ deleteFeed: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
