import { FEED_TOKEN_PREFIX, TIMER_MAX_SECONDS, checkEndpoint } from "./http.js";
import type { FeedMachineRef } from "./types.js";

// Response bodies are checked at the boundary, before anything trusts them.
// Required here means the API always sends it: the response fields are
// read-only, and the view fills every one listed as required on every reply.
// Each check names the field that failed, never its value (it may be a token).

type Body = Record<string, unknown>;

const nonEmpty = (value: unknown) => typeof value === "string" && value.length > 0;
// A duration in whole seconds, as the serializer's IntegerFields send it: at
// least 1 (a fraction would reschedule every few milliseconds) and at most
// what a timer can wait (setTimeout turns anything above 2^31-1 ms into ~1 ms).
const duration = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= TIMER_MAX_SECONDS;

function endpointOk(value: unknown, scheme: RegExp): boolean {
  if (typeof value !== "string" || !scheme.test(value)) return false;
  try {
    checkEndpoint(value);
    return true;
  } catch {
    return false;
  }
}

/** The first problem in a heartbeat (or create) body's token and stream fields, or undefined. */
export function tokensProblem(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return "body";
  const b = body as Body;
  if (!nonEmpty(b.feed_id)) return "feed_id";
  // The channel reaches the SDK subscription: it can only be this feed's own.
  if (b.channel !== `data_feed:${String(b.feed_id)}`) return "channel";
  if (b.transport !== "sdk" && b.transport !== "sse") return "transport";
  if (!nonEmpty(b.connection_token)) return "connection_token";
  if (!duration(b.heartbeat_interval)) return "heartbeat_interval";
  if (!duration(b.token_ttl)) return "token_ttl";
  if (!duration(b.ttl)) return "ttl";
  if (b.subscription_token !== undefined && !nonEmpty(b.subscription_token)) {
    return "subscription_token";
  }
  // Each reply carries its transport's endpoint and never the other one, which
  // would hand an https URL to the WebSocket SDK, or a ws URL to fetch.
  if (b.transport === "sdk") {
    if (b.subscription_token === undefined) return "subscription_token";
    if (!endpointOk(b.ws_endpoint, /^wss?:/i)) return "ws_endpoint";
    if (b.sse_endpoint !== undefined) return "sse_endpoint";
  } else {
    if (!endpointOk(b.sse_endpoint, /^https?:/i)) return "sse_endpoint";
    if (b.ws_endpoint !== undefined) return "ws_endpoint";
  }
  return undefined;
}

/** A create reply's `machines`: an array of { uuid, game_name } refs. */
export function machineRefsOk(machines: unknown): machines is FeedMachineRef[] {
  return Array.isArray(machines) && machines.every(machineOk);
}

function machineOk(machine: unknown): boolean {
  if (!machine || typeof machine !== "object") return false;
  const m = machine as Body;
  return nonEmpty(m.uuid) && typeof m.game_name === "string";
}

function venueOk(venue: unknown): boolean {
  if (!venue || typeof venue !== "object") return false;
  const v = venue as Body;
  return nonEmpty(v.uuid) && typeof v.name === "string";
}

/** The first problem in a create response body, or undefined. */
export function createdProblem(body: unknown): string | undefined {
  const problem = tokensProblem(body);
  if (problem) return problem;
  const b = body as Body;
  if (typeof b.feed_token !== "string" || !b.feed_token.startsWith(FEED_TOKEN_PREFIX)) {
    return "feed_token";
  }
  if (b.delta !== undefined && typeof b.delta !== "string") return "delta";
  // May be empty: a feed following its venues can start with none.
  if (!machineRefsOk(b.machines)) return "machines";
  return undefined;
}

/** The first problem in a discovery response body, or undefined. */
export function scopeProblem(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return "body";
  const b = body as Body;
  if (b.scope_type !== "venues" && b.scope_type !== "machines") return "scope_type";
  if (!Array.isArray(b.machines)) return "machines";
  for (const [i, machine] of b.machines.entries()) {
    if (!machineOk(machine) || !venueOk((machine as Body).venue)) return `machines[${i}]`;
  }
  return undefined;
}
