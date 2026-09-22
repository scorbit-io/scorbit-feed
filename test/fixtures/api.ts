/**
 * Response fixtures for the Data Feed REST API: shapes from the Scorbit API's
 * data-feed serializers, including which keys each transport receives.
 *
 * Every credential here is an obviously fake placeholder. The heartbeat
 * fixtures have no endpoint fields because the heartbeat response does not
 * include them yet; `withEndpoint` builds the shape once it does.
 */
import type { CreatedFeed, FeedTokens } from "../../src/types.js";

export const FEED_ID = "f_TESTFEEDID0000000000";
export const FEED_TOKEN = "sbf_TESTTOKEN_not_a_real_feed_token";
export const API_KEY = "sb_live_TESTKEY_not_a_real_api_key";
export const MACHINE_A = "11111111-1111-4111-8111-111111111111";
export const MACHINE_B = "22222222-2222-4222-8222-222222222222";
export const WS_ENDPOINT = "wss://centrifugo.test.invalid/connection/websocket";
export const SSE_ENDPOINT = "https://centrifugo.test.invalid/connection/uni_sse";
export const BASE_URL = "https://api.test.invalid";

// JWT-shaped placeholders, so the redaction tests exercise the real pattern.
export const jwt = (label: string) => `eyJhbGciOiJIUzI1NiJ9.eyJ${label}fake.c2lnbmF0dXJlZmFrZQ`;

export const CREATED_SDK: CreatedFeed = {
  feed_id: FEED_ID,
  channel: `data_feed:${FEED_ID}`,
  transport: "sdk",
  machines: [
    { uuid: MACHINE_A, game_name: "Monster Bash" },
    { uuid: MACHINE_B, game_name: "Medieval Madness" },
  ],
  feed_token: FEED_TOKEN,
  connection_token: jwt("conn1"),
  subscription_token: jwt("sub1"),
  ws_endpoint: WS_ENDPOINT,
  delta: "fossil",
  ttl: 900,
  token_ttl: 900,
  heartbeat_interval: 612,
};

export const CREATED_SSE: CreatedFeed = {
  feed_id: FEED_ID,
  channel: `data_feed:${FEED_ID}`,
  transport: "sse",
  machines: [{ uuid: MACHINE_A, game_name: "Monster Bash" }],
  feed_token: FEED_TOKEN,
  connection_token: jwt("sseconn1"),
  sse_endpoint: SSE_ENDPOINT,
  ttl: 900,
  token_ttl: 900,
  heartbeat_interval: 587,
};

/** The heartbeat response on main today: tokens and timers only. */
export const heartbeatSdk = (n: number, interval = 612): FeedTokens => ({
  feed_id: FEED_ID,
  connection_token: jwt(`conn${n}`),
  subscription_token: jwt(`sub${n}`),
  ttl: 900,
  token_ttl: 900,
  heartbeat_interval: interval,
});

export const heartbeatSse = (n: number, interval = 587): FeedTokens => ({
  feed_id: FEED_ID,
  connection_token: jwt(`sseconn${n}`),
  ttl: 900,
  token_ttl: 900,
  heartbeat_interval: interval,
});

/** The heartbeat shape once the response includes the endpoint fields. */
export const withEndpoint = (tokens: FeedTokens, endpoint: string): FeedTokens =>
  tokens.subscription_token
    ? { ...tokens, transport: "sdk", ws_endpoint: endpoint, delta: "fossil" }
    : { ...tokens, transport: "sse", sse_endpoint: endpoint };
