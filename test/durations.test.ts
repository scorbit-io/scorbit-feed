/* Every server- or header-supplied duration that reaches a timer is bounded. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachFeed } from "../src/feed.js";
import { FeedHttpError, TIMER_MAX_MS, TIMER_MAX_SECONDS, request } from "../src/http.js";
import { tokensProblem } from "../src/validate.js";
import {
  API_KEY,
  BASE_URL,
  CREATED_SSE,
  FEED_ID,
  FEED_TOKEN,
  heartbeatSse,
} from "./fixtures/api.js";
import { fakeApi, json, sseStream } from "./helpers.js";

describe("durations in token replies", () => {
  it("the limit is the largest delay setTimeout honours", () => {
    expect(TIMER_MAX_MS).toBe(2147483647);
    expect(TIMER_MAX_SECONDS).toBe(2147483);
  });

  it.each(["heartbeat_interval", "token_ttl", "ttl"] as const)(
    "%s: whole seconds from 1 up to the limit are accepted",
    (field) => {
      expect(tokensProblem({ ...heartbeatSse(1), [field]: 1 })).toBeUndefined();
      expect(tokensProblem({ ...heartbeatSse(1), [field]: TIMER_MAX_SECONDS })).toBeUndefined();
    },
  );

  it.each([
    ["heartbeat_interval", 0],
    ["heartbeat_interval", 0.5],
    ["heartbeat_interval", 1.5],
    ["heartbeat_interval", 0.001],
    ["token_ttl", 0.5],
    ["ttl", 1.5],
    ["ttl", 0],
    ["heartbeat_interval", TIMER_MAX_SECONDS + 1],
    ["heartbeat_interval", 1e12],
    ["heartbeat_interval", Number.MAX_VALUE],
    ["token_ttl", TIMER_MAX_SECONDS + 1],
    ["token_ttl", 1e12],
  ] as const)("%s = %d is rejected", (field, value) => {
    expect(tokensProblem({ ...heartbeatSse(1), [field]: value })).toBe(field);
  });
});

describe("Retry-After", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function retryAfter(header: string) {
    const api = fakeApi();
    const response = json(429);
    response.headers.set("Retry-After", header);
    api.queue("create", response);
    const error = await request<never>(api.fetch, "https://x.test/", "POST", API_KEY, {}).catch(
      (e: FeedHttpError) => e,
    );
    return error.retryAfter;
  }

  it.each([
    ["at the limit", String(TIMER_MAX_SECONDS), TIMER_MAX_SECONDS],
    ["above the limit", "99999999999", TIMER_MAX_SECONDS],
    [
      "a date a century away",
      new Date(Date.now() + 100 * 365 * 86400_000).toUTCString(),
      TIMER_MAX_SECONDS,
    ],
  ])("is capped %s", async (_label, header, seconds) => {
    expect(await retryAfter(header)).toBe(seconds);
  });

  it("ignores a value too large to be a number", async () => {
    expect(await retryAfter("9".repeat(400))).toBeUndefined();
  });

  it("never schedules a retry beyond the timer limit", async () => {
    const api = fakeApi();
    api.queue("sse", (init) => sseStream().respond(init));
    const throttled = json(429);
    throttled.headers.set("Retry-After", "99999999999");
    api.queue("heartbeat", throttled);
    const feed = attachFeed({
      feedId: FEED_ID,
      feedToken: FEED_TOKEN,
      baseUrl: BASE_URL,
      fetch: api.fetch,
      initialTokens: CREATED_SSE,
    });
    const spy = vi.spyOn(globalThis, "setTimeout");
    feed.start();
    await vi.advanceTimersByTimeAsync(CREATED_SSE.heartbeat_interval * 1000);
    const delays = spy.mock.calls.map((call) => call[1] as number);
    expect(delays.at(-1)).toBe(TIMER_MAX_SECONDS * 1000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(TIMER_MAX_MS);
    // It really waits: no retry soon after.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(api.count("heartbeat")).toBe(1);
    await feed.stop({ deleteFeed: false });
  });

  it("clamps any delay handed to the scheduler, as defence in depth", () => {
    const feed = attachFeed({ feedId: FEED_ID, feedToken: FEED_TOKEN, baseUrl: BASE_URL });
    const spy = vi.spyOn(globalThis, "setTimeout");
    (feed as unknown as { schedule(ms: number): void }).schedule(1e15);
    (feed as unknown as { schedule(ms: number): void }).schedule(-5);
    expect(spy.mock.calls.map((call) => call[1])).toEqual([TIMER_MAX_MS, 0]);
    void feed.stop({ deleteFeed: false });
  });
});

describe("channel in token replies", () => {
  it("accepts only the feed's own channel", () => {
    expect(tokensProblem({ ...heartbeatSse(1), channel: `data_feed:${FEED_ID}` })).toBeUndefined();
    expect(tokensProblem({ ...heartbeatSse(1), channel: "data_feed:f_other" })).toBe("channel");
    expect(tokensProblem({ ...heartbeatSse(1), channel: 5 })).toBe("channel");
  });
});
