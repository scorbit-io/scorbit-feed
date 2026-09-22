import { FEED_TOKEN_PREFIX, TIMER_MAX_SECONDS, checkEndpoint } from "./http.js";
import type { FeedMachineRef } from "./types.js";

// Response bodies are checked at the boundary, before anything trusts them.
// Required here means the API always sends it: the response fields are
// read-only, and the view fills every one listed as required on every reply.
// Each check names the field that failed, never its value (it may be a token).

type Body = Record<string, unknown>;

const nonEmpty = (value: unknown) => typeof value === "string" && value.length > 0;
// A duration in seconds that a timer can actually wait: setTimeout clamps
// anything above 2^31-1 ms to ~1 ms, which would turn a long wait into a storm.
const duration = (value: unknown) =>
  typeof value === "number" && value > 0 && value <= TIMER_MAX_SECONDS;

function endpointOk(value: unknown, scheme: RegExp): boolean {
  if (typeof value !== "string" || !scheme.test(value)) return false;
  try {
    checkEndpoint(value);
    return true;
  } catch {
    return false;
  }
}

/** The first problem in a heartbeat (or create) body's token fields, or undefined. */
export function tokensProblem(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return "body";
  const b = body as Body;
  if (!nonEmpty(b.feed_id)) return "feed_id";
  if (!nonEmpty(b.connection_token)) return "connection_token";
  // The channel reaches the SDK subscription: it can only be this feed's own.
  if (b.channel !== undefined && b.channel !== `data_feed:${String(b.feed_id)}`) return "channel";
  if (!duration(b.heartbeat_interval)) return "heartbeat_interval";
  if (!duration(b.token_ttl)) return "token_ttl";
  if (!duration(b.ttl)) return "ttl";
  if (b.delta !== undefined && typeof b.delta !== "string") return "delta";
  if (b.transport !== undefined && b.transport !== "sdk" && b.transport !== "sse") {
    return "transport";
  }
  if (b.subscription_token !== undefined && !nonEmpty(b.subscription_token)) {
    return "subscription_token";
  }
  if (b.transport === "sdk" && b.subscription_token === undefined) return "subscription_token";
  if (b.ws_endpoint !== undefined && !endpointOk(b.ws_endpoint, /^wss?:/i)) return "ws_endpoint";
  if (b.sse_endpoint !== undefined && !endpointOk(b.sse_endpoint, /^https?:/i)) {
    return "sse_endpoint";
  }
  // An endpoint for the other transport would hand an https URL to the WebSocket
  // SDK, or a ws URL to fetch. The transport is explicit, or inferred as the feed does.
  const transport = b.transport ?? (b.subscription_token === undefined ? "sse" : "sdk");
  if (transport === "sdk" && b.sse_endpoint !== undefined) return "sse_endpoint";
  if (transport === "sse" && b.ws_endpoint !== undefined) return "ws_endpoint";
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

/** The first problem in a create response body, or undefined. */
export function createdProblem(body: unknown): string | undefined {
  const problem = tokensProblem(body);
  if (problem) return problem;
  const b = body as Body;
  if (typeof b.feed_token !== "string" || !b.feed_token.startsWith(FEED_TOKEN_PREFIX)) {
    return "feed_token";
  }
  if (b.transport !== "sdk" && b.transport !== "sse") return "transport";
  // Required by FeedInfo: tokensProblem only checks it when present.
  if (b.channel !== `data_feed:${String(b.feed_id)}`) return "channel";
  if (b.transport === "sdk" && b.ws_endpoint === undefined) return "ws_endpoint";
  if (b.transport === "sse" && b.sse_endpoint === undefined) return "sse_endpoint";
  if (!machineRefsOk(b.machines)) return "machines";
  return undefined;
}
