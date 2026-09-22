import { FEED_TOKEN_PREFIX, checkEndpoint } from "./http.js";

// Response bodies are checked at the boundary, before anything trusts them.
// Each check names the field that failed, never its value (it may be a token).

type Body = Record<string, unknown>;

const nonEmpty = (value: unknown) => typeof value === "string" && value.length > 0;
const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

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
  if (!positive(b.heartbeat_interval)) return "heartbeat_interval";
  if (!positive(b.token_ttl)) return "token_ttl";
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
  return undefined;
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
  if (b.transport === "sdk" && b.ws_endpoint === undefined) return "ws_endpoint";
  if (b.transport === "sse" && b.sse_endpoint === undefined) return "sse_endpoint";
  if (!Array.isArray(b.machines)) return "machines";
  return undefined;
}
