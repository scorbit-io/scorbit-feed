/**
 * Response fixtures for the Data Feed REST API: shapes from the Scorbit API's
 * data-feed views and serializers, including which keys each transport
 * receives. Derived from the API source, not recorded from a live server.
 *
 * The response serializers' fields are all read-only, which in DRF means
 * required=False: a key is present only if the view puts it in the payload.
 * Every token reply (create, PATCH, heartbeat) carries feed_id, channel,
 * transport, connection_token, ttl, token_ttl and heartbeat_interval, plus
 * subscription_token and ws_endpoint for sdk, or sse_endpoint for sse. Create
 * and PATCH add machines (uuid and game_name, which may be ""), and delta
 * ("fossil") for sdk; create adds feed_token. The heartbeat serializer
 * declares no delta or machines, so those are absent from heartbeats.
 *
 * Error bodies: the API's exception handler (drf-standardized-errors, with a
 * formatter that adds `message`) answers every RAISED error as
 * `{message, type, errors: [{code, detail, attr}]}`. `type` is
 * validation_error for a ValidationError, client_error for any other 4xx and
 * server_error for a 5xx; `code` is the exception's code (`invalid` for a
 * view's plain ValidationError, `permission_denied`, `not_found`,
 * `authentication_failed`, `throttled`, or a custom exception's default_code);
 * `attr` is the field for a field error and null otherwise; `message` is the
 * first error's detail. Only the bodies a view writes itself are
 * `{"detail": "..."}`: the create 503 for uncountable feeds, and the delete
 * 503 and 409.
 *
 * Every credential here is an obviously fake placeholder.
 */
import type { CreatedFeed, FeedTokens, MachineScope } from "../../src/types.js";

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

/** A create without `machines` on a venue-scoped key whose venues have no machines yet. */
export const CREATED_FOLLOWING_EMPTY: CreatedFeed = { ...CREATED_SDK, machines: [] };

/** The heartbeat response: tokens, timers, and the stream they are for. */
export const heartbeatSdk = (n: number, interval = 612): FeedTokens => ({
  feed_id: FEED_ID,
  channel: `data_feed:${FEED_ID}`,
  transport: "sdk",
  connection_token: jwt(`conn${n}`),
  subscription_token: jwt(`sub${n}`),
  ws_endpoint: WS_ENDPOINT,
  ttl: 900,
  token_ttl: 900,
  heartbeat_interval: interval,
});

export const heartbeatSse = (n: number, interval = 587): FeedTokens => ({
  feed_id: FEED_ID,
  channel: `data_feed:${FEED_ID}`,
  transport: "sse",
  connection_token: jwt(`sseconn${n}`),
  sse_endpoint: SSE_ENDPOINT,
  ttl: 900,
  token_ttl: 900,
  heartbeat_interval: interval,
});

/** The same reply naming a different endpoint for its transport, as after a move. */
export const withEndpoint = (tokens: FeedTokens, endpoint: string): FeedTokens =>
  tokens.transport === "sdk"
    ? { ...tokens, ws_endpoint: endpoint }
    : { ...tokens, sse_endpoint: endpoint };

export const VENUE = { uuid: "33333333-3333-4333-8333-333333333333", name: "The Test Arcade" };

/** GET /api/v2/data-feeds/machines/ for a venue-scoped key. */
export const SCOPE_VENUES: MachineScope = {
  scope_type: "venues",
  machines: [
    { uuid: MACHINE_A, game_name: "Monster Bash", venue: VENUE },
    { uuid: MACHINE_B, game_name: "Medieval Madness", venue: VENUE },
  ],
};

/** The same for a machine-scoped key; a machine the account lost is simply absent. */
export const SCOPE_MACHINES: MachineScope = {
  scope_type: "machines",
  machines: [{ uuid: MACHINE_A, game_name: "Monster Bash", venue: VENUE }],
};

/** A raised error, as the API's exception handler renders it. */
const raised = (
  type: "validation_error" | "client_error" | "server_error",
  code: string,
  detail: string,
  attr: string | null = null,
) => ({ message: detail, type, errors: [{ code, detail, attr }] });

/** Error bodies, exactly as each server path produces them. */
export const ERRORS = {
  /** 400: a create without `machines` over a scope larger than one feed (ValidationError). */
  scopeTooLarge: raised(
    "validation_error",
    "invalid",
    "This key covers 73 machines and a feed carries at most 50. Pass `machines` with a subset.",
  ),
  /** 400: the account's live-feed cap (ValidationError). */
  feedCap: raised("validation_error", "invalid", "You may have at most 2 live data feeds."),
  /** 400: a field error from the request serializer. */
  badTransport: raised(
    "validation_error",
    "invalid_choice",
    '"grpc" is not a valid choice.',
    "transport",
  ),
  /** 403: a machine outside the key's scope, or not the account's (never says which). */
  machinesUnavailable: raised(
    "client_error",
    "permission_denied",
    "One or more machines are not available to this account.",
  ),
  /** 403 on create, discovery or heartbeat: the account's data-feed access is suspended. */
  suspended: raised(
    "client_error",
    "permission_denied",
    "Data-feed access for this account is suspended.",
  ),
  /** 503 on create: the platform switch is off or unreadable (DataFeedsSwitchedOff). */
  switchedOff: raised(
    "server_error",
    "data_feeds_unavailable",
    "Data feeds are temporarily unavailable. Try again later.",
  ),
  /** 503 on create: live feeds cannot be counted against the cap (written by the view). */
  uncountable: { detail: "Your live feeds cannot be counted right now. Try again shortly." },
  /** 503 on heartbeat or delete: the feed token cannot be checked (FeedStoreUnavailable). */
  storeUnavailable: raised(
    "server_error",
    "feed_store_unavailable",
    "The feed store is unavailable. Try again shortly.",
  ),
  /** 503 on delete: nothing was deleted (written by the view). */
  deleteUnavailable: { detail: "The feed could not be deleted right now. Try again shortly." },
  /** 409 on delete: the record was rewritten on every attempt (written by the view). */
  keptChanging: { detail: "The feed kept changing while it was being deleted. Try again." },
  /** 403 on heartbeat: the feed ended because data feeds were switched off. */
  feedsSwitchedOff: raised(
    "client_error",
    "permission_denied",
    "Data feeds have been turned off by Scorbit; this feed has ended.",
  ),
  /** 403 on heartbeat: authorization withdrawn (key revoked, machine lost). */
  withdrawn: raised(
    "client_error",
    "permission_denied",
    "Authorization for this feed has been withdrawn.",
  ),
  /** 404: an unknown or expired feed, or a key that did not create it. */
  notFound: raised("client_error", "not_found", "Feed not found."),
  /** 401: a feed token that does not match its feed. */
  badFeedToken: raised("client_error", "authentication_failed", "Invalid feed token."),
  /** 429: a throttle; the answer also carries `Retry-After`. */
  throttled: raised(
    "client_error",
    "throttled",
    "Request was throttled. Expected available in 1 second.",
  ),
};
