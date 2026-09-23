/* openFeed must not leak a feed the server created when attaching then fails. */
import { describe, expect, it, vi } from "vitest";

import { openFeed } from "../src/create.js";
import { API_KEY, BASE_URL, CREATED_SSE, FEED_ID, MACHINE_A } from "./fixtures/api.js";
import { fakeApi, json } from "./helpers.js";

vi.mock("../src/feed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/feed.js")>();
  return {
    ...actual,
    attachFeed: vi.fn(() => {
      throw new Error("attach failed");
    }),
  };
});

describe("openFeed cleanup", () => {
  it("deletes the created feed with the API key when attaching fails, then rethrows", async () => {
    const api = fakeApi();
    api.queue("create", json(201, CREATED_SSE));
    api.queue("delete", new Response(null, { status: 204 }));
    await expect(
      openFeed({ apiKey: API_KEY, machines: [MACHINE_A], baseUrl: BASE_URL, fetch: api.fetch }),
    ).rejects.toThrow("attach failed");
    const del = api.calls.find((c) => c.key === "delete")!;
    expect(del.url).toBe(`${BASE_URL}/api/v2/data-feeds/${FEED_ID}/`);
    expect(del.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("still rethrows the attach error when that delete fails too", async () => {
    const api = fakeApi();
    api.queue("create", json(201, CREATED_SSE));
    api.queue("delete", json(500));
    await expect(
      openFeed({ apiKey: API_KEY, machines: [MACHINE_A], baseUrl: BASE_URL, fetch: api.fetch }),
    ).rejects.toThrow("attach failed");
    expect(api.count("delete")).toBe(1);
  });
});
