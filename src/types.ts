/** Wire types for the Scorbit Data Feed API: its REST responses and published messages. */

export type Transport = "sdk" | "sse";

export interface FeedMachineRef {
  uuid: string;
  game_name: string;
}

/** The heartbeat response (`DataFeedTokensSerializer`): refreshed tokens and timers. */
export interface FeedTokens {
  feed_id: string;
  connection_token: string;
  /** sdk transport only. */
  subscription_token?: string;
  /** Seconds the feed survives with nobody subscribed and nobody refreshing it. */
  ttl: number;
  /** Seconds the Centrifugo tokens are valid for. */
  token_ttl: number;
  /** Seconds after which to refresh tokens. Server-supplied and per-feed. */
  heartbeat_interval: number;
  /**
   * The heartbeat response does not include these yet. Read when present,
   * otherwise the last known value is used.
   */
  transport?: Transport;
  ws_endpoint?: string;
  sse_endpoint?: string;
  delta?: string;
  channel?: string;
}

/** The create and PATCH response (`DataFeedSerializer`). */
export interface FeedInfo extends FeedTokens {
  channel: string;
  transport: Transport;
  machines: FeedMachineRef[];
}

/** The create response (`DataFeedCreatedSerializer`). `feed_token` is shown once. */
export interface CreatedFeed extends FeedInfo {
  feed_token: string;
}

export interface FeedPlayer {
  id?: string;
  username: string;
  avatar?: string | null;
  display_name?: string;
  initials?: string;
}

export interface FeedScore {
  position: number;
  /** Null for an unclaimed player slot. */
  player: FeedPlayer | null;
  score: number;
  /** Null when unavailable; not proof that a game is or is not running. */
  ball?: number | null;
  ball_in_progress?: boolean | null;
  modes: string[];
  is_nfc_verified: boolean;
  tournament_id?: string | null;
}

export interface FeedMachineState {
  machine_uuid: string;
  game_name?: string;
  game_in_progress: boolean;
  /**
   * True when the last game finished and `scores` are its final scores. The
   * server normalises both device generations (a v2 `game_end` message, a v1
   * update with `game_in_progress: false`) onto this flag.
   */
  game_ended: boolean;
  scores: FeedScore[];
  updated_at?: string | null;
}

export interface FeedMessageMetadata {
  created_at: string;
  updated_at: string;
  game?: string;
  machine?: string;
  sequence?: number;
  variant?: string;
  venue?: string;
}

/** A `data_feed_update` publication: every machine the feed covers, in order. */
export interface FeedUpdate {
  type: "data_feed_update";
  metadata: FeedMessageMetadata;
  payload: { machines: FeedMachineState[] };
}

/**
 * The feed's machine set changed. A venue-scoped feed's set is live: machines
 * join and leave as the venue's membership changes (planned server support).
 * Uuids, in feed order.
 */
export interface FeedMachinesChange {
  added: string[];
  removed: string[];
  machines: string[];
}

export type FeedStatus = "idle" | "connecting" | "live" | "reconnecting" | "ended";

/**
 * Why a feed ended:
 * - `withdrawn`: heartbeat 403, authorization was withdrawn and the feed deleted.
 * - `ended`: heartbeat 404, the feed no longer exists (deleted, or unwatched past its grace period).
 * - `unauthorized`: heartbeat 401, the feed token is not valid for this feed.
 * - `stopped`: `stop()` was called, locally.
 */
export type EndReason = "withdrawn" | "ended" | "unauthorized" | "stopped";
