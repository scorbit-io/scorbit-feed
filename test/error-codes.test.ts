/*
 * Error codes, not English messages, decide what the library does: every case
 * runs as the server sends it and again with its message reworded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFeed } from "../src/create.js";
import { attachFeed } from "../src/feed.js";
import {
  FeedError,
  FeedHttpError,
  FeedLimitReachedError,
  FeedScopeTooLargeError,
  MAX_ATTEMPTS,
  redactedError,
} from "../src/http.js";
import type { EndReason } from "../src/types.js";
import {
  API_KEY,
  BASE_URL,
  CREATED_SSE,
  ERRORS,
  FEED_ID,
  FEED_TOKEN,
  MACHINE_A,
  jwt,
  reworded,
} from "./fixtures/api.js";
import { fakeApi, flush, json } from "./helpers.js";

type Body = (typeof ERRORS)[keyof typeof ERRORS];

const create = (api: ReturnType<typeof fakeApi>, machines?: string[]) =>
  createFeed({ apiKey: API_KEY, machines, baseUrl: BASE_URL, fetch: api.fetch }).catch(
    (e: unknown) => e,
  );

const attach = (api: ReturnType<typeof fakeApi>) =>
  attachFeed({ feedId: FEED_ID, feedToken: FEED_TOKEN, baseUrl: BASE_URL, fetch: api.fetch });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([
  ["as sent", (body: Body) => body],
  ["reworded", reworded],
])("error bodies %s", (_variant, shape) => {
  it.each([
    ["data_feeds_unavailable", ERRORS.switchedOff],
    ["feeds_uncountable", ERRORS.uncountable],
    ["feed_store_unavailable", ERRORS.createUnavailable],
  ])("retries a create 503 with code %s", async (_code, body) => {
    const api = fakeApi();
    api.queue("create", json(503, shape(body)), json(201, CREATED_SSE));
    const pending = create(api);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual(CREATED_SSE);
    expect(api.count("create")).toBe(2);
  });

  it("throws FeedScopeTooLargeError for scope_too_large", async () => {
    const api = fakeApi();
    api.queue("create", json(400, shape(ERRORS.scopeTooLarge)));
    const error = await create(api);
    expect(error).toBeInstanceOf(FeedScopeTooLargeError);
    expect(error).toMatchObject({ status: 400, code: "scope_too_large" });
  });

  it("throws FeedLimitReachedError for feed_limit_reached, with or without machines", async () => {
    for (const machines of [undefined, [MACHINE_A]]) {
      const api = fakeApi();
      api.queue("create", json(400, shape(ERRORS.feedCap)));
      const error = await create(api, machines);
      expect(error).toBeInstanceOf(FeedLimitReachedError);
      expect(error).toBeInstanceOf(FeedHttpError);
      expect(error).toMatchObject({
        name: "FeedLimitReachedError",
        status: 400,
        code: "feed_limit_reached",
        detail: shape(ERRORS.feedCap).errors[0]!.detail,
      });
      expect(api.count("create")).toBe(1);
    }
  });

  it("retries a create's feed_store_unavailable once only", async () => {
    const api = fakeApi();
    const store = () => json(503, shape(ERRORS.createUnavailable));
    api.queue("create", store(), store(), json(201, CREATED_SSE));
    const pending = create(api);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);
    expect(await pending).toMatchObject({ status: 503, code: "feed_store_unavailable" });
    expect(api.count("create")).toBe(2);
  });

  it("keeps the normal attempts for the other codes after a store failure", async () => {
    const api = fakeApi();
    api.queue(
      "create",
      json(503, shape(ERRORS.createUnavailable)),
      json(503, shape(ERRORS.uncountable)),
      json(201, CREATED_SSE),
    );
    const pending = create(api);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);
    expect(await pending).toEqual(CREATED_SSE);
    expect(api.count("create")).toBe(3);
  });

  it("surfaces the store failure, not the limit its own record may have reached", async () => {
    const api = fakeApi();
    api.queue(
      "create",
      json(503, shape(ERRORS.createUnavailable)),
      json(400, shape(ERRORS.feedCap)),
    );
    const pending = create(api);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await pending;
    expect((error as Error).constructor).toBe(FeedHttpError);
    expect(error).toMatchObject({ status: 503, code: "feed_store_unavailable" });
    expect((error as Error).message).toMatch(/feed store failed.*couple of minutes/);
    expect(api.count("create")).toBe(2);
  });

  it.each([
    [401, "unauthorized", ERRORS.badFeedToken],
    [403, "withdrawn", ERRORS.withdrawn],
    [403, "withdrawn", ERRORS.feedsSwitchedOff],
    [404, "ended", ERRORS.notFound],
  ] as const)(
    "a %i heartbeat ends the feed as %s, carrying its code",
    async (status, reason, body) => {
      const api = fakeApi();
      api.queue("heartbeat", json(status, shape(body)));
      const feed = attach(api);
      const ended: { reason: EndReason; error?: FeedHttpError }[] = [];
      feed.on("ended", (e) => ended.push(e));
      feed.start();
      await flush();
      expect(ended).toHaveLength(1);
      expect(ended[0]!.reason).toBe(reason);
      expect(ended[0]!.error).toBeInstanceOf(FeedHttpError);
      expect(ended[0]!.error).toMatchObject({ status, code: body.errors[0]!.code });
      expect(api.count("heartbeat")).toBe(1);
    },
  );

  it("reports a heartbeat 503 as a FeedHttpError carrying feed_store_unavailable", async () => {
    const api = fakeApi();
    api.queue("heartbeat", json(503, shape(ERRORS.storeUnavailable)));
    const feed = attach(api);
    const errors: Error[] = [];
    feed.on("error", (e) => errors.push(e));
    feed.start();
    await flush();
    expect(errors[0]).toBeInstanceOf(FeedHttpError);
    expect(errors[0]).toMatchObject({ status: 503, code: "feed_store_unavailable" });
    expect(errors[0]!.message).toMatch(/^heartbeat failed: Scorbit API answered 503/);
    await feed.stop({ deleteFeed: false });
  });

  it.each([
    [409, "feed_kept_changing", ERRORS.keptChanging, 2],
    [503, "feed_store_unavailable", ERRORS.deleteUnavailable, MAX_ATTEMPTS],
  ])(
    "surfaces a delete %i with code %s once its retries are spent",
    async (status, code, body, n) => {
      const api = fakeApi();
      api.queue("delete", ...Array.from({ length: n }, () => json(status, shape(body))));
      const stopped = attach(api)
        .stop()
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
      expect(await stopped).toMatchObject({ status, code });
      expect(api.count("delete")).toBe(n);
    },
  );
});

describe("older servers, which sent no specific code for some errors", () => {
  const UNCOUNTABLE = "Your live feeds cannot be counted right now. Try again shortly.";

  it("retries their bare uncountable 503, matched by its exact text", async () => {
    const api = fakeApi();
    api.queue("create", json(503, { detail: UNCOUNTABLE }), json(201, CREATED_SSE));
    const pending = create(api);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual(CREATED_SSE);
  });

  it.each([
    ["other text in a bare body", { detail: "Live feeds unavailable." }],
    [
      "the same text under an unrecognised code",
      {
        message: UNCOUNTABLE,
        type: "server_error",
        errors: [{ code: "maintenance", detail: UNCOUNTABLE, attr: null }],
      },
    ],
  ])("does not retry %s", async (_label, body) => {
    const api = fakeApi();
    api.queue("create", json(503, body));
    expect(await create(api)).toMatchObject({ status: 503 });
    expect(api.count("create")).toBe(1);
  });

  it("recognises their over-scope 400 by its sentence under the generic code", async () => {
    const api = fakeApi();
    api.queue(
      "create",
      json(400, {
        ...ERRORS.scopeTooLarge,
        errors: [{ ...ERRORS.scopeTooLarge.errors[0]!, code: "invalid" }],
      }),
    );
    expect(await create(api)).toMatchObject({ name: "FeedScopeTooLargeError", code: "invalid" });
  });

  it.each([
    ["feed_limit_reached", FeedLimitReachedError],
    ["invalid_choice", FeedHttpError],
  ] as const)("does not read the over-scope sentence under %s", async (code, type) => {
    const api = fakeApi();
    const detail = ERRORS.scopeTooLarge.errors[0]!.detail;
    api.queue(
      "create",
      json(400, { ...ERRORS.scopeTooLarge, errors: [{ code, detail, attr: null }] }),
    );
    const error = await create(api);
    expect((error as Error).constructor).toBe(type);
    expect(error).toMatchObject({ code });
  });

  it("leaves their live-feed-ceiling 400 a plain FeedHttpError", async () => {
    const api = fakeApi();
    api.queue(
      "create",
      json(400, { ...ERRORS.feedCap, errors: [{ ...ERRORS.feedCap.errors[0]!, code: "invalid" }] }),
    );
    expect(((await create(api)) as Error).constructor).toBe(FeedHttpError);
  });

  it("ends a feed on a heartbeat body without a code, carrying none", async () => {
    const api = fakeApi();
    api.queue("heartbeat", json(404, { detail: "Not found." }));
    const feed = attach(api);
    const ended: { reason: EndReason; error?: FeedHttpError }[] = [];
    feed.on("ended", (e) => ended.push(e));
    feed.start();
    await flush();
    expect(ended[0]!.reason).toBe("ended");
    expect(ended[0]!.error).toMatchObject({ status: 404, code: undefined, detail: "Not found." });
  });
});

describe("redactedError", () => {
  it("keeps the subclass, and redacts the prefix too", () => {
    for (const answer of [
      new FeedScopeTooLargeError("Too many.", "scope_too_large"),
      new FeedLimitReachedError("At the limit.", "feed_limit_reached"),
    ]) {
      const error = redactedError(answer, `with ${API_KEY}`);
      expect(error.constructor).toBe(answer.constructor);
      expect(error).toMatchObject({ name: answer.name, code: answer.code, detail: answer.detail });
      expect(error.message).toBe(`with [redacted]: ${answer.message}`);
    }
  });

  it("treats a FeedHttpError thrown by a custom fetch as a failed request", async () => {
    const thrown = new FeedHttpError(500, "from the fetch", undefined, "boom");
    const error = await createFeed({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: () => Promise.reject(thrown),
    }).catch((e: unknown) => e);
    expect((error as Error).constructor).toBe(FeedError);
    expect((error as Error).message).toBe(
      "request failed: Scorbit API answered 500: from the fetch",
    );
  });

  it("keeps an API answer typed, code and all, with or without a prefix", () => {
    const answer = new FeedHttpError(503, "Down.", 5, "feed_store_unavailable");
    for (const [prefix, message] of [
      [undefined, "Scorbit API answered 503: Down."],
      ["heartbeat failed", "heartbeat failed: Scorbit API answered 503: Down."],
    ] as const) {
      const error = redactedError(answer, prefix);
      expect(error).not.toBe(answer);
      expect(error).toBeInstanceOf(FeedHttpError);
      expect(error).toMatchObject({
        message,
        status: 503,
        detail: "Down.",
        retryAfter: 5,
        code: "feed_store_unavailable",
      });
    }
  });
});

describe("redaction of API answers", () => {
  const SECRETS = [API_KEY, FEED_TOKEN, jwt("leak")];
  const leaky = {
    message: `key ${SECRETS.join(" ")}`,
    type: "client_error",
    errors: [{ code: `code_${SECRETS.join("_")}`, detail: `key ${SECRETS.join(" ")}`, attr: null }],
  };
  const clean = (error: unknown) => {
    const { message, detail, code } = error as FeedHttpError;
    const text = JSON.stringify({ message, detail, code });
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]");
  };

  it("strips credentials from a heartbeat error event and from ended.error", async () => {
    const api = fakeApi();
    api.queue("heartbeat", json(503, leaky), json(403, leaky));
    const feed = attach(api);
    const errors: Error[] = [];
    const ended: { error?: FeedHttpError }[] = [];
    feed.on("error", (e) => errors.push(e));
    feed.on("ended", (e) => ended.push(e));
    feed.start();
    await flush();
    clean(errors[0]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ended).toHaveLength(1);
    clean(ended[0]!.error);
  });

  it("strips credentials from a thrown create error", async () => {
    const api = fakeApi();
    api.queue("create", json(400, leaky));
    clean(await create(api));
  });
});
