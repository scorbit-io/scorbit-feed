/*
 * The sdk transport against the REAL `centrifuge` client, with only the
 * WebSocket faked: a scripted server speaking Centrifugo's JSON protocol. This
 * is what proves the SDK actually calls our getToken hooks (on the token TTL,
 * and after a 109 "token expired") and receives the refreshed tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachFeed } from "../src/feed.js";
import type { FeedUpdate } from "../src/types.js";
import {
  BASE_URL,
  CREATED_SDK,
  FEED_ID,
  FEED_TOKEN,
  WS_ENDPOINT,
  heartbeatSdk,
  jwt,
} from "./fixtures/api.js";
import { UPDATE } from "./fixtures/messages.js";
import { fakeApi, json } from "./helpers.js";

type Command = { id?: number } & Record<string, Record<string, unknown> | number | undefined>;

const TOKEN_TTL = CREATED_SDK.token_ttl;
const INTERVAL_MS = CREATED_SDK.heartbeat_interval * 1000;

/** A scripted Centrifugo on the other end of a fake WebSocket. */
class FakeServer {
  readonly sockets: FakeSocket[] = [];
  readonly commands: Command[] = [];
  /** Error codes to answer the next connect commands with, in order. */
  connectErrors: number[] = [];

  handle(socket: FakeSocket, command: Command): void {
    this.commands.push(command);
    const id = command.id;
    if (command.connect) {
      const code = this.connectErrors.shift();
      if (code) return socket.reply({ id, error: { code, message: "token expired" } });
      return socket.reply({
        id,
        connect: { client: "c-1", version: "test", expires: true, ttl: TOKEN_TTL },
      });
    }
    if (command.subscribe) {
      return socket.reply({
        id,
        subscribe: { expires: true, ttl: TOKEN_TTL, recoverable: true, positioned: true },
      });
    }
    if (command.refresh) {
      return socket.reply({
        id,
        refresh: { client: "c-1", version: "test", expires: true, ttl: TOKEN_TTL },
      });
    }
    if (command.sub_refresh) {
      return socket.reply({ id, sub_refresh: { expires: true, ttl: TOKEN_TTL } });
    }
  }

  tokens(kind: "connect" | "subscribe" | "refresh" | "sub_refresh"): unknown[] {
    return this.commands
      .map((c) => c[kind])
      .filter((body): body is Record<string, unknown> => typeof body === "object")
      .map((body) => body.token);
  }

  publish(data: unknown): void {
    this.sockets.at(-1)!.reply({ push: { channel: CREATED_SDK.channel, pub: { data } } });
  }
}

let server: FakeServer;

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    server.sockets.push(this);
    void Promise.resolve().then(() => this.onopen?.());
  }

  send(data: string): void {
    for (const line of data.split("\n").filter(Boolean)) {
      server.handle(this, JSON.parse(line) as Command);
    }
  }

  close(): void {
    void Promise.resolve().then(() => this.onclose?.({ code: 1000, reason: "" }));
  }

  reply(message: unknown): void {
    void Promise.resolve().then(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
}

function setup() {
  const api = fakeApi();
  const feed = attachFeed({
    feedId: FEED_ID,
    feedToken: FEED_TOKEN,
    baseUrl: BASE_URL,
    fetch: api.fetch,
    websocket: FakeSocket,
    initialTokens: CREATED_SDK,
  });
  const updates: FeedUpdate[] = [];
  const errors: Error[] = [];
  feed.on("update", (u) => updates.push(u));
  feed.on("error", (e) => errors.push(e));
  return { api, feed, updates, errors };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  server = new FakeServer();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sdk transport with the real centrifuge client", () => {
  it("connects and subscribes with the create tokens and fossil delta, and delivers publications", async () => {
    const { feed, updates } = setup();
    feed.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(server.sockets[0]!.url).toBe(WS_ENDPOINT);
    expect(server.tokens("connect")).toEqual([CREATED_SDK.connection_token]);
    const subscribe = server.commands.find((c) => c.subscribe)!.subscribe as Record<
      string,
      unknown
    >;
    expect(subscribe).toMatchObject({
      channel: CREATED_SDK.channel,
      token: CREATED_SDK.subscription_token,
      delta: "fossil",
    });
    expect(feed.status).toBe("live");
    server.publish(UPDATE);
    await vi.advanceTimersByTimeAsync(1);
    expect(updates).toEqual([UPDATE]);
    await feed.stop({ deleteFeed: false });
  });

  it("hands the SDK the heartbeat's tokens when its token TTL runs out", async () => {
    const { api, feed } = setup();
    api.queue("heartbeat", json(200, heartbeatSdk(2)));
    feed.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(api.count("heartbeat")).toBe(1);
    expect(server.tokens("refresh")).toEqual([]);

    await vi.advanceTimersByTimeAsync(TOKEN_TTL * 1000 - INTERVAL_MS + 1_000);
    expect(server.tokens("refresh")).toEqual([jwt("conn2")]);
    expect(server.tokens("sub_refresh")).toEqual([jwt("sub2")]);
    // Served from the scheduled heartbeat, not a second one.
    expect(api.count("heartbeat")).toBe(1);
    await feed.stop({ deleteFeed: false });
  });

  it("heartbeats and reconnects with the fresh token after a 109 token-expired answer", async () => {
    const { api, feed, errors } = setup();
    server.connectErrors = [109];
    api.queue("heartbeat", json(200, heartbeatSdk(2)));
    feed.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.count("heartbeat")).toBe(1);
    expect(server.tokens("connect")).toEqual([CREATED_SDK.connection_token, jwt("conn2")]);
    expect(feed.status).toBe("live");
    // The SDK's own connect error is reported once, not doubled with ours.
    expect(errors.filter((e) => /connectToken/.test(e.message))).toEqual([]);
    await feed.stop({ deleteFeed: false });
  });

  it("stops the SDK for good when the refresh finds the feed gone", async () => {
    const { api, feed } = setup();
    server.connectErrors = [109];
    api.queue("heartbeat", json(404, { detail: "Feed not found." }));
    const ended: string[] = [];
    feed.on("ended", ({ reason }) => ended.push(reason));
    feed.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ended).toEqual(["ended"]);
    expect(server.tokens("connect")).toEqual([CREATED_SDK.connection_token]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
