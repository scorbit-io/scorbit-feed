/*
 * Scoped API keys: discovery, creates without a machine list, and the
 * statuses a create or delete may answer while the feed store is down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFeed, listMachines, openFeed } from "../src/create.js";
import { attachFeed } from "../src/feed.js";
import { FeedError, FeedHttpError, FeedScopeTooLargeError, jittered } from "../src/http.js";
import { scopeProblem } from "../src/validate.js";
import {
  API_KEY,
  BASE_URL,
  CREATED_FOLLOWING_EMPTY,
  CREATED_SDK,
  CREATED_SSE,
  ERRORS,
  FEED_ID,
  FEED_TOKEN,
  MACHINE_A,
  SCOPE_MACHINES,
  SCOPE_VENUES,
  VENUE,
} from "./fixtures/api.js";
import { fakeApi, flush, json } from "./helpers.js";

const MACHINES_URL = `${BASE_URL}/api/v2/data-feeds/machines/`;
const noContent = () => new Response(null, { status: 204 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // The top of each jittered backoff, so the waits below are exact.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("listMachines", () => {
  it.each([
    ["venue", SCOPE_VENUES],
    ["machine", SCOPE_MACHINES],
    ["empty venue", { scope_type: "venues", machines: [] }],
  ])("GETs what a %s-scoped key covers, with the key", async (_label, scope) => {
    const api = fakeApi();
    api.queue(`GET ${MACHINES_URL}`, json(200, scope));
    await expect(
      listMachines({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: api.fetch }),
    ).resolves.toEqual(scope);
    expect(api.calls).toEqual([
      expect.objectContaining({
        url: MACHINES_URL,
        method: "GET",
        body: undefined,
        headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
      }),
    ]);
  });

  it("refuses to run in a browser or with anything but an API key, before any request", async () => {
    const api = fakeApi();
    await expect(listMachines({ apiKey: FEED_TOKEN, fetch: api.fetch })).rejects.toThrow(
      "listMachines needs an sb_live_ API key.",
    );
    vi.stubGlobal("window", {});
    await expect(listMachines({ apiKey: API_KEY, fetch: api.fetch })).rejects.toThrow(
      /listMachines runs server-side only/,
    );
    expect(api.calls).toHaveLength(0);
  });

  it("surfaces a refusal, such as a suspended account, without the key", async () => {
    const api = fakeApi();
    api.queue(`GET ${MACHINES_URL}`, json(403, ERRORS.suspended));
    const error = await listMachines({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: api.fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FeedHttpError);
    expect(error).toMatchObject({ status: 403 });
    expect(String(error)).not.toContain(API_KEY);
  });

  it("passes its signal to the request", async () => {
    const api = fakeApi();
    const controller = new AbortController();
    api.queue(`GET ${MACHINES_URL}`, (init) => {
      expect(init?.signal).toBe(controller.signal);
      return json(200, SCOPE_VENUES);
    });
    await expect(
      listMachines({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        fetch: api.fetch,
        signal: controller.signal,
      }),
    ).resolves.toEqual(SCOPE_VENUES);
  });

  it("refuses a malformed answer, naming the field", async () => {
    const api = fakeApi();
    api.queue(`GET ${MACHINES_URL}`, json(200, { ...SCOPE_VENUES, scope_type: "all" }));
    await expect(
      listMachines({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: api.fetch }),
    ).rejects.toThrow("malformed machines response: bad scope_type");
  });
});

describe("scopeProblem (discovery bodies)", () => {
  const machine = SCOPE_VENUES.machines[0]!;
  it.each([
    ["not an object", null, "body"],
    ["no scope_type", { machines: [] }, "scope_type"],
    ["machines not an array", { scope_type: "venues", machines: {} }, "machines"],
    ["a null machine", { scope_type: "venues", machines: [null] }, "machines[0]"],
    ["no uuid", { scope_type: "venues", machines: [{ ...machine, uuid: "" }] }, "machines[0]"],
    ["no venue", { scope_type: "venues", machines: [{ ...machine, venue: null }] }, "machines[0]"],
    [
      "a venue without a uuid",
      { scope_type: "venues", machines: [machine, { ...machine, venue: { name: "x" } }] },
      "machines[1]",
    ],
    [
      "a numeric venue name",
      { scope_type: "venues", machines: [{ ...machine, venue: { ...VENUE, name: 1 } }] },
      "machines[0]",
    ],
  ])("rejects %s", (_label, body, field) => {
    expect(scopeProblem(body)).toBe(field);
  });
});

describe("createFeed over a scoped key", () => {
  it("turns the API's over-cap 400 into FeedScopeTooLargeError, with the server's text", async () => {
    const api = fakeApi();
    api.queue("create", json(400, ERRORS.scopeTooLarge));
    const error = await createFeed({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: api.fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FeedScopeTooLargeError);
    expect(error).toBeInstanceOf(FeedHttpError);
    expect(error).toMatchObject({
      status: 400,
      code: "invalid",
      detail:
        "This key covers 73 machines and a feed carries at most 50. Pass `machines` with a subset.",
    });
    expect(String(error)).toContain("Pass `machines` with a subset.");
    expect(api.count("create")).toBe(1);
  });

  it("prefers a specific code, whatever the text", async () => {
    const api = fakeApi();
    api.queue(
      "create",
      json(400, {
        message: "Too many machines.",
        type: "validation_error",
        errors: [{ code: "scope_too_large", detail: "Too many machines.", attr: null }],
      }),
    );
    await expect(
      createFeed({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: api.fetch }),
    ).rejects.toBeInstanceOf(FeedScopeTooLargeError);
  });

  it.each([
    ["the live-feed cap", ERRORS.feedCap, undefined],
    ["a 400 when machines were listed", ERRORS.scopeTooLarge, [MACHINE_A]],
    ["a field error", ERRORS.badTransport, undefined],
    ["a 400 without a body", undefined, undefined],
    [
      "a different sentence that mentions machines",
      {
        ...ERRORS.feedCap,
        errors: [{ code: "invalid", detail: "Too many machines.", attr: null }],
      },
      undefined,
    ],
  ])("leaves any other 400 a plain FeedHttpError (%s)", async (_label, body, machines) => {
    const api = fakeApi();
    api.queue("create", json(400, body));
    const error = await createFeed({
      apiKey: API_KEY,
      machines,
      baseUrl: BASE_URL,
      fetch: api.fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FeedHttpError);
    expect(error).not.toBeInstanceOf(FeedScopeTooLargeError);
  });

  it("accepts a following feed that starts with no machines", async () => {
    const api = fakeApi();
    api.queue("create", json(201, CREATED_FOLLOWING_EMPTY));
    const { feed, created } = await openFeed({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: api.fetch,
    });
    expect(created.machines).toEqual([]);
    expect(feed.machines).toEqual([]);
    expect(api.calls[0]!.body).toEqual({ transport: "sdk" });
  });

  it("does not retry an out-of-scope 403", async () => {
    const api = fakeApi();
    api.queue("create", json(403, ERRORS.machinesUnavailable));
    await expect(
      createFeed({ apiKey: API_KEY, machines: [MACHINE_A], baseUrl: BASE_URL, fetch: api.fetch }),
    ).rejects.toMatchObject({ status: 403 });
    expect(api.count("create")).toBe(1);
  });
});

describe("503 on create: retried with backoff, then surfaced", () => {
  it.each([
    ["switched off", ERRORS.switchedOff],
    ["feeds uncountable", ERRORS.uncountable],
  ])("retries a 503 (%s) and returns the feed once it is created", async (_label, body) => {
    const api = fakeApi();
    api.queue("create", json(503, body), json(503, body), json(201, CREATED_SSE));
    const pending = createFeed({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: api.fetch });
    await flush();
    expect(api.count("create")).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(api.count("create")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.count("create")).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual(CREATED_SSE);
    expect(api.count("create")).toBe(3);
  });

  it("gives up after a bounded number of attempts", async () => {
    const api = fakeApi();
    api.queue("create", ...Array.from({ length: 4 }, () => json(503, ERRORS.switchedOff)));
    const pending = createFeed({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: api.fetch }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    const error = await pending;
    expect(error).toBeInstanceOf(FeedHttpError);
    expect(error).toMatchObject({
      status: 503,
      code: "data_feeds_unavailable",
      detail: ERRORS.switchedOff.errors[0]!.detail,
    });
    expect(api.count("create")).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honours Retry-After, and surfaces the 503 at once when it asks for longer than the cap", async () => {
    const api = fakeApi();
    const soon = json(503, ERRORS.switchedOff);
    soon.headers.set("Retry-After", "5");
    const later = json(503, ERRORS.switchedOff);
    later.headers.set("Retry-After", "120");
    api.queue("create", soon, later);
    const pending = createFeed({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: api.fetch }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(api.count("create")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 503, retryAfter: 120 });
    expect(api.count("create")).toBe(2);
  });

  it.each([
    ["a proxy's HTML page", new Response("<html>502 Bad Gateway</html>", { status: 503 })],
    ["an empty body", json(503)],
    ["an unrecognised API body", json(503, { detail: "Service unavailable." })],
    ["another server error code", json(503, { ...ERRORS.storeUnavailable })],
  ])(
    "surfaces any other 503 (%s) at once: the create may have gone through",
    async (_l, answer) => {
      const api = fakeApi();
      api.queue("create", answer);
      await expect(
        createFeed({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: api.fetch }),
      ).rejects.toMatchObject({ status: 503 });
      expect(api.count("create")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("stops retrying when its signal aborts during a wait, without another request", async () => {
    const api = fakeApi();
    api.queue("create", json(503, ERRORS.switchedOff), json(201, CREATED_SSE));
    const controller = new AbortController();
    const pending = createFeed({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: api.fetch,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    expect(await pending).toMatchObject({ name: "FeedError", message: "aborted" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.count("create")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never abandons a create in flight: the answer is returned even if the signal aborted", async () => {
    const api = fakeApi();
    const controller = new AbortController();
    api.queue("create", (init) => {
      expect(init?.signal).toBeUndefined();
      controller.abort();
      return json(201, CREATED_SSE);
    });
    await expect(
      createFeed({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        fetch: api.fetch,
        signal: controller.signal,
      }),
    ).resolves.toEqual(CREATED_SSE);
  });

  it("does not wait to retry when the signal aborted while the 503 was in flight", async () => {
    const api = fakeApi();
    const controller = new AbortController();
    api.queue("create", () => {
      controller.abort();
      return json(503, ERRORS.switchedOff);
    });
    await expect(
      createFeed({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        fetch: api.fetch,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing when the signal has already aborted", async () => {
    const api = fakeApi();
    await expect(
      createFeed({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        fetch: api.fetch,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("aborted");
    expect(api.calls).toHaveLength(0);
  });

  it("does not retry a network failure, which may have created the feed", async () => {
    const api = fakeApi();
    api.queue("create", new TypeError("fetch failed"));
    await expect(
      createFeed({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: api.fetch }),
    ).rejects.toBeInstanceOf(FeedError);
    expect(api.count("create")).toBe(1);
  });
});

describe("jittered backoff", () => {
  it("stays in the upper half of the capped backoff", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(jittered(1)).toBeCloseTo(500.5);
    expect(jittered(10)).toBeCloseTo(15_015);
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(jittered(1)).toBe(1_000);
    expect(jittered(10)).toBe(30_000);
  });
});

describe("DELETE statuses", () => {
  const attach = (api: ReturnType<typeof fakeApi>) =>
    attachFeed({ feedId: FEED_ID, feedToken: FEED_TOKEN, baseUrl: BASE_URL, fetch: api.fetch });

  it.each([
    ["204", [noContent()]],
    ["404, already gone", [json(404, ERRORS.notFound)]],
    ["503 then 204", [json(503, ERRORS.deleteUnavailable), noContent()]],
    ["503 (feed token unverifiable) then 204", [json(503, ERRORS.storeUnavailable), noContent()]],
    ["409 then 204", [json(409, ERRORS.keptChanging), noContent()]],
    ["409, 503, then 204", [json(409, ERRORS.keptChanging), json(503), noContent()]],
    ["503 then 404", [json(503), json(404, ERRORS.notFound)]],
    ["429 then 204", [json(429, ERRORS.throttled), noContent()]],
  ])("resolves on %s", async (_label, answers) => {
    const api = fakeApi();
    api.queue("delete", ...answers);
    const stopped = attach(api).stop();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);
    await expect(stopped).resolves.toBeUndefined();
    expect(api.count("delete")).toBe(answers.length);
  });

  it.each([
    ["a second 409", [json(409, ERRORS.keptChanging), json(409, ERRORS.keptChanging)], 409],
    ["four 503s", Array.from({ length: 4 }, () => json(503, ERRORS.deleteUnavailable)), 503],
    ["a 401", [json(401, ERRORS.badFeedToken)], 401],
    ["a 500", [json(500)], 500],
  ])("surfaces %s, and a later stop() may try again", async (_label, answers, status) => {
    const api = fakeApi();
    api.queue("delete", ...answers);
    const feed = attach(api);
    const stopped = feed.stop().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(await stopped).toMatchObject({ status });
    expect(api.count("delete")).toBe(answers.length);
    api.queue("delete", noContent());
    await expect(feed.stop()).resolves.toBeUndefined();
  });

  it("waits out a 429's Retry-After, and surfaces one that asks for longer than the cap", async () => {
    const api = fakeApi();
    const soon = json(429, ERRORS.throttled);
    soon.headers.set("Retry-After", "10");
    const later = json(429, ERRORS.throttled);
    later.headers.set("Retry-After", "31");
    api.queue("delete", soon, later);
    const stopped = attach(api)
      .stop()
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(api.count("delete")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await stopped).toMatchObject({ status: 429, code: "throttled", retryAfter: 31 });
    expect(api.count("delete")).toBe(2);
  });

  it("abandons the delete when stop()'s signal aborts, in flight or waiting", async () => {
    const api = fakeApi();
    api.queue("delete", json(503, ERRORS.deleteUnavailable));
    const controller = new AbortController();
    const feed = attach(api);
    const stopped = feed.stop({ signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await stopped).toMatchObject({ message: "aborted" });
    expect(api.count("delete")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    // The signal also reaches the request itself.
    const again = new AbortController();
    api.queue("delete", (init) => {
      expect(init?.signal).toBe(again.signal);
      return noContent();
    });
    await expect(feed.stop({ signal: again.signal })).resolves.toBeUndefined();
  });

  it("retries the API-key delete of an unusable create the same way", async () => {
    const api = fakeApi();
    api.queue("create", json(201, { ...CREATED_SDK, feed_token: "not-a-feed-token" }));
    api.queue("delete", json(503, ERRORS.deleteUnavailable), noContent());
    const pending = createFeed({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: api.fetch }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ message: "malformed create response: bad feed_token" });
    expect(api.calls.filter((c) => c.key === "delete").map((c) => c.headers.Authorization)).toEqual(
      [`Bearer ${API_KEY}`, `Bearer ${API_KEY}`],
    );
  });
});
