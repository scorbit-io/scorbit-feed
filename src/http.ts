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

/** A non-2xx answer from the Scorbit API. */
export class FeedHttpError extends FeedError {
  readonly status: number;
  readonly detail: string | undefined;
  /** Seconds from a `Retry-After` header, when the answer carried a usable one. */
  readonly retryAfter: number | undefined;

  constructor(status: number, detail: string | undefined, retryAfter?: number) {
    super(`Scorbit API answered ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "FeedHttpError";
    this.status = status;
    this.detail = detail;
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

/** `Retry-After` as seconds: delta-seconds or an HTTP date. */
function retryAfterOf(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header.trim())
    ? Number(header)
    : (Date.parse(header) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
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
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
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
