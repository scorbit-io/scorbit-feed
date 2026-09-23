import { afterEach, describe, expect, it, vi } from "vitest";

import { createFeed, openFeed } from "../src/create.js";
import { Feed } from "../src/feed.js";
import { FeedError } from "../src/http.js";
import {
  API_KEY,
  BASE_URL,
  CREATED_SDK,
  CREATED_SSE,
  FEED_TOKEN,
  MACHINE_A,
  MACHINE_B,
} from "./fixtures/api.js";
import { fakeApi, json } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createFeed", () => {
  it("POSTs the machines with the API key and returns the typed create response", async () => {
    const api = fakeApi();
    api.queue("create", json(201, CREATED_SDK));

    const created = await createFeed({
      apiKey: API_KEY,
      machines: [MACHINE_A, MACHINE_B],
      baseUrl: BASE_URL,
      fetch: api.fetch,
    });

    expect(created).toEqual(CREATED_SDK);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({
      url: `${BASE_URL}/api/v2/data-feeds/`,
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: { machines: [MACHINE_A, MACHINE_B], transport: "sdk" },
    });
  });

  it("asks for the sse transport when told to", async () => {
    const api = fakeApi();
    api.queue("create", json(201, CREATED_SSE));
    await createFeed({
      apiKey: API_KEY,
      machines: [MACHINE_A],
      transport: "sse",
      baseUrl: BASE_URL,
      fetch: api.fetch,
    });
    expect(api.calls[0]!.body).toEqual({ machines: [MACHINE_A], transport: "sse" });
  });

  it("defaults to the production API and the global fetch", async () => {
    const api = fakeApi();
    api.queue("create", json(201, CREATED_SDK));
    vi.stubGlobal("fetch", api.fetch);
    await createFeed({ apiKey: API_KEY, machines: [MACHINE_A] });
    expect(api.calls[0]!.url).toBe("https://api.scorbit.io/api/v2/data-feeds/");
  });

  it("refuses to run in a browser, before any request", async () => {
    const api = fakeApi();
    vi.stubGlobal("window", {});
    await expect(
      createFeed({ apiKey: API_KEY, machines: [MACHINE_A], fetch: api.fetch }),
    ).rejects.toThrow(/server-side only/);
    expect(api.calls).toHaveLength(0);
  });

  it("runs in a browser-like runtime only with dangerouslyAllowBrowser", async () => {
    const api = fakeApi();
    api.queue("create", json(201, CREATED_SDK));
    vi.stubGlobal("window", {});
    await expect(
      createFeed({
        apiKey: API_KEY,
        machines: [MACHINE_A],
        fetch: api.fetch,
        dangerouslyAllowBrowser: true,
      }),
    ).resolves.toEqual(CREATED_SDK);
  });

  it.each([FEED_TOKEN, "", undefined as unknown as string])(
    "refuses a credential that is not an sb_live_ key (%s)",
    async (apiKey) => {
      const api = fakeApi();
      await expect(createFeed({ apiKey, machines: [MACHINE_A], fetch: api.fetch })).rejects.toThrow(
        FeedError,
      );
      expect(api.calls).toHaveLength(0);
    },
  );

  it("refuses an empty or malformed machine list rather than widening to the whole scope", async () => {
    const api = fakeApi();
    await expect(createFeed({ apiKey: API_KEY, machines: [], fetch: api.fetch })).rejects.toThrow(
      /omit it, or list at least one uuid/,
    );
    await expect(
      createFeed({ apiKey: API_KEY, machines: MACHINE_A as unknown as string[], fetch: api.fetch }),
    ).rejects.toThrow(/omit it, or list at least one uuid/);
    expect(api.calls).toHaveLength(0);
  });

  it("sends no machines field when machines is omitted: the key's whole scope (pending server support)", async () => {
    const api = fakeApi();
    api.queue("create", json(201, CREATED_SDK));
    await createFeed({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: api.fetch });
    expect(api.calls[0]!.body).toEqual({ transport: "sdk" });
  });

  it("surfaces an API refusal as an error without the key in it", async () => {
    const api = fakeApi();
    api.queue(
      "create",
      json(403, { detail: "One or more machines are not available to this account." }),
    );
    const error = await createFeed({
      apiKey: API_KEY,
      machines: [MACHINE_A],
      fetch: api.fetch,
    }).catch((e) => e);
    expect(error.status).toBe(403);
    expect(String(error.message)).not.toContain(API_KEY);
  });
});

describe("openFeed", () => {
  it("creates, then attaches with the create response as the first tokens", async () => {
    const api = fakeApi();
    api.queue("create", json(201, CREATED_SSE));
    const { feed, created } = await openFeed({
      apiKey: API_KEY,
      machines: [MACHINE_A],
      transport: "sse",
      baseUrl: BASE_URL,
      fetch: api.fetch,
    });
    expect(created).toEqual(CREATED_SSE);
    expect(feed).toBeInstanceOf(Feed);
    expect(feed.feedId).toBe(CREATED_SSE.feed_id);
    expect(feed.status).toBe("idle");
    expect(api.calls).toHaveLength(1);
  });
});
