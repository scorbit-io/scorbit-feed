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
