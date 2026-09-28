import { describe, expect, it, vi } from "vitest";

import { Emitter } from "../src/emitter.js";
import { FeedHttpError, feedUrl, redact, request } from "../src/http.js";
import { asFeedUpdate } from "../src/message.js";
import { SseParser } from "../src/sse-parser.js";
import { API_KEY, FEED_TOKEN, jwt } from "./fixtures/api.js";
import { UPDATE } from "./fixtures/messages.js";
import { fakeApi, json } from "./helpers.js";

describe("feedUrl", () => {
  it("builds the collection, detail and action urls without doubling slashes", () => {
    expect(feedUrl("https://x.test/")).toBe("https://x.test/api/v2/data-feeds/");
    expect(feedUrl("https://x.test", "f_a")).toBe("https://x.test/api/v2/data-feeds/f_a/");
    expect(feedUrl("https://x.test", "f_a", "heartbeat")).toBe(
      "https://x.test/api/v2/data-feeds/f_a/heartbeat/",
    );
  });
});

describe("request", () => {
  it("sends the bearer credential and a JSON body", async () => {
    const api = fakeApi();
    api.queue("create", json(201, { ok: true }));
    await expect(
      request(api.fetch, "https://x.test/api/v2/data-feeds/", "POST", API_KEY, { a: 1 }),
    ).resolves.toEqual({ ok: true });
    expect(api.calls[0]!.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    });
    expect(api.calls[0]!.body).toEqual({ a: 1 });
  });

  it("resolves undefined for an empty body and sends no content type without a body", async () => {
    const api = fakeApi();
    api.queue("delete", new Response(null, { status: 204 }));
    await expect(
      request(api.fetch, "https://x.test/f/", "DELETE", FEED_TOKEN),
    ).resolves.toBeUndefined();
    expect(api.calls[0]!.headers["Content-Type"]).toBeUndefined();
  });

  it.each([
    [
      {
        message: "Feed not found.",
        type: "client_error",
        errors: [{ code: "not_found", detail: "Feed not found.", attr: null }],
      },
      "Feed not found.",
      "not_found",
    ],
    [
      {
        message: "a",
        type: "validation_error",
        errors: [
          { code: "invalid", detail: "a", attr: "machines.0" },
          { code: "invalid", detail: "b", attr: "machines.1" },
        ],
      },
      "a b",
      "invalid",
    ],
    // No usable detail in the errors: the message stands in.
    [
      { message: "Throttled.", type: "client_error", errors: [{ code: "throttled" }] },
      "Throttled.",
      "throttled",
    ],
    [{ message: 7, type: "client_error", errors: [null] }, undefined, undefined],
    [{ detail: "Feed not found." }, "Feed not found.", undefined],
    [
      ["You may have at most 2 live data feeds."],
      "You may have at most 2 live data feeds.",
      undefined,
    ],
    [{ machines: ["bad"] }, undefined, undefined],
    [{ detail: 3 }, undefined, undefined],
    [[1], undefined, undefined],
  ])("reads the error body %j", async (body, detail, code) => {
    const api = fakeApi();
    api.queue("create", json(400, body));
    const error = await request<never>(api.fetch, "https://x.test/", "POST", API_KEY, {}).catch(
      (e: FeedHttpError) => e,
    );
    expect(error).toBeInstanceOf(FeedHttpError);
    expect(error.status).toBe(400);
    expect(error.detail).toBe(detail);
    expect(error.code).toBe(code);
    expect(error.message).toBe(
      detail ? `Scorbit API answered 400: ${detail}` : "Scorbit API answered 400",
    );
  });

  it("tolerates a non-JSON error body", async () => {
    const api = fakeApi();
    api.queue("create", new Response("<html>bad gateway</html>", { status: 502 }));
    const error = await request<never>(api.fetch, "https://x.test/", "POST", API_KEY, {}).catch(
      (e: FeedHttpError) => e,
    );
    expect(error.status).toBe(502);
    expect(error.detail).toBeUndefined();
  });
});

describe("redact", () => {
  it("removes API keys, feed tokens and JWTs", () => {
    const text = `key ${API_KEY} token ${FEED_TOKEN} jwt ${jwt("abc")} fine`;
    expect(redact(text)).toBe("key [redacted] token [redacted] jwt [redacted] fine");
  });
});

describe("SseParser", () => {
  it("joins multi-line data, ignores other fields and comments", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\nevent: x\nid: 1\ndata: a\ndata:b\n\n")).toEqual(["a\nb"]);
  });

  it("reassembles events split at any point across chunks", () => {
    const frame = 'data: {"connect":{}}\r\n\r\ndata: {"pub":{}}\n\n';
    for (let cut = 0; cut <= frame.length; cut++) {
      const parser = new SseParser();
      const out = [...parser.push(frame.slice(0, cut)), ...parser.push(frame.slice(cut))];
      expect(out).toEqual(['{"connect":{}}', '{"pub":{}}']);
    }
  });

  it("accepts bare CR line endings and skips empty events", () => {
    const parser = new SseParser();
    expect(parser.push("\n\rdata: x\r\r\n")).toEqual(["x"]);
  });

  it("holds a trailing CR until it knows whether LF follows", () => {
    const parser = new SseParser();
    expect(parser.push("data: x\r")).toEqual([]);
    expect(parser.push("\n\r\n")).toEqual(["x"]);
  });
});

describe("asFeedUpdate", () => {
  it("accepts a data_feed_update and rejects anything else", () => {
    expect(asFeedUpdate(UPDATE)).toBe(UPDATE);
    expect(asFeedUpdate(null)).toBeUndefined();
    expect(asFeedUpdate("x")).toBeUndefined();
    expect(asFeedUpdate({ type: "other", payload: { machines: [] } })).toBeUndefined();
    expect(asFeedUpdate({ type: "data_feed_update", payload: {} })).toBeUndefined();
    expect(asFeedUpdate({ type: "data_feed_update" })).toBeUndefined();
  });
});

describe("Emitter", () => {
  class Test extends Emitter<{ ping: number }> {
    fire(n: number) {
      this.emit("ping", n);
    }
  }

  it("delivers to listeners until they unsubscribe", () => {
    const emitter = new Test();
    const a = vi.fn();
    const b = vi.fn();
    const offA = emitter.on("ping", a);
    emitter.on("ping", b);
    emitter.fire(1);
    offA();
    emitter.fire(2);
    emitter.off("ping", b);
    emitter.fire(3);
    expect(a.mock.calls).toEqual([[1]]);
    expect(b.mock.calls).toEqual([[1], [2]]);
  });
});
