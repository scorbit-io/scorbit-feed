export const DEFAULT_BASE_URL = "https://api.scorbit.io";
export const FEEDS_PATH = "/api/v2/data-feeds/";
export const API_KEY_PREFIX = "sb_live_";
export const FEED_TOKEN_PREFIX = "sbf_";

const SECRET_PATTERNS = [
  /sb_live_[A-Za-z0-9_-]+/g,
  /sbf_[A-Za-z0-9_-]+/g,
  // A JWT: three base64url segments. Centrifugo tokens are JWTs.
  /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** Strip anything shaped like a credential from text bound for a log or an error. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((out, pattern) => out.replace(pattern, "[redacted]"), text);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Base class for everything this library throws. Never carries a credential. */
export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedError";
  }
}

/**
 * The one way an error crosses the public boundary: its message redacted, as a
 * FeedError. The original is dropped, since it may carry a credential.
 */
export function redactedError(err: unknown, prefix?: string): FeedError {
  const message = err instanceof Error ? err.message : String(err);
  return new FeedError(redact(prefix ? `${prefix}: ${message}` : message));
}

/** A non-2xx answer from the Scorbit API. */
export class FeedHttpError extends FeedError {
  readonly status: number;
  readonly detail: string | undefined;
  /** Seconds from a `Retry-After` header, when the answer carried a usable one. */
  readonly retryAfter: number | undefined;

  constructor(status: number, detail: string | undefined, retryAfter?: number) {
    // The server's text is untrusted: never let it carry a credential into a log.
    const safe = detail === undefined ? undefined : redact(detail);
    super(`Scorbit API answered ${status}${safe ? `: ${safe}` : ""}`);
    this.name = "FeedHttpError";
    this.status = status;
    this.detail = safe;
    this.retryAfter = retryAfter;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Parse a URL and require one of `protocols`; plain-text schemes only for loopback hosts. */
export function checkedUrl(value: string, label: string, secure: string, plain: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FeedError(`${label} is not a valid URL.`);
  }
  const ok =
    url.protocol === secure || (url.protocol === plain && LOOPBACK_HOSTS.has(url.hostname));
  if (!ok) {
    throw new FeedError(`${label} must use ${secure}// (${plain}// only for localhost).`);
  }
  return url;
}

/** `baseUrl` must be https, except on a loopback host. */
export function checkBaseUrl(baseUrl: string): string {
  checkedUrl(baseUrl, "baseUrl", "https:", "http:");
  return baseUrl;
}

/** A Centrifugo endpoint: wss/https, or ws/http on a loopback host. */
export function checkEndpoint(endpoint: string): string {
  const [secure, plain] = /^wss?:/i.test(endpoint) ? ["wss:", "ws:"] : ["https:", "http:"];
  checkedUrl(endpoint, "endpoint", secure, plain);
  return endpoint;
}

/** The longest delay setTimeout honours; above it, Node and browsers fire after ~1 ms. */
export const TIMER_MAX_MS = 2 ** 31 - 1;
export const TIMER_MAX_SECONDS = Math.floor(TIMER_MAX_MS / 1000);

/** `Retry-After` as seconds (delta-seconds or an HTTP date), capped at what a timer can wait. */
function retryAfterOf(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header.trim())
    ? Number(header)
    : (Date.parse(header) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.min(Math.max(0, seconds), TIMER_MAX_SECONDS) : undefined;
}

export function feedUrl(baseUrl: string, feedId?: string, action?: string): string {
  let url = baseUrl.replace(/\/+$/, "") + FEEDS_PATH;
  if (feedId !== undefined) url += `${encodeURIComponent(feedId)}/`;
  if (action !== undefined) url += `${action}/`;
  return url;
}

function detailOf(body: unknown): string | undefined {
  // DRF answers `{"detail": "..."}`, or a bare list for a non-field ValidationError.
  if (Array.isArray(body) && body.every((item) => typeof item === "string")) {
    return body.join(" ");
  }
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return undefined;
}

/**
 * Every request that carries a credential sets `redirect: "manual"` and refuses
 * any redirect: following one would re-send the key, feed token or JWT to
 * wherever the Location header points.
 */
export const NO_REDIRECT = "manual" as const;

/** A redirect the request refused (manual mode: a 3xx, or an opaque redirect in browsers). */
export function refusedRedirect(response: Response): FeedError | undefined {
  const redirected =
    response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
  return redirected
    ? new FeedError(`refused a redirect (${response.status}); credentials are never re-sent`)
    : undefined;
}

/** One JSON request with a bearer credential. Resolves the body, or `undefined` on 204. */
export async function request<T>(
  fetchImpl: FetchLike,
  url: string,
  method: string,
  credential: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: NO_REDIRECT,
    });
    const refused = refusedRedirect(response);
    if (refused) throw refused;
    text = await response.text();
  } catch (err) {
    // A custom fetch may put the request, bearer credential included, in its error.
    throw redactedError(err, "request failed");
  }
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (!response.ok) {
    throw new FeedHttpError(
      response.status,
      detailOf(parsed),
      retryAfterOf(response.headers.get("Retry-After")),
    );
  }
  return parsed as T;
}
