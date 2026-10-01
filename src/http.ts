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
 * FeedError (an API answer stays a FeedHttpError). The original is dropped,
 * since it may carry a credential.
 */
export function redactedError(err: unknown, prefix?: string): FeedError {
  if (err instanceof FeedHttpError) {
    // Kept typed, subclass included, so its `code` still reaches the caller.
    const copy: FeedHttpError = Object.assign(Object.create(Object.getPrototypeOf(err)), err);
    copy.message = redact(prefix ? `${prefix}: ${err.message}` : err.message);
    copy.stack = err.stack && redact(err.stack);
    return copy;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new FeedError(redact(prefix ? `${prefix}: ${message}` : message));
}

/** A non-2xx answer from the Scorbit API. */
export class FeedHttpError extends FeedError {
  readonly status: number;
  readonly detail: string | undefined;
  /** Seconds from a `Retry-After` header, when the answer carried a usable one. */
  readonly retryAfter: number | undefined;
  /** The API's error code (`errors[0].code`), when the body carried one. */
  readonly code: string | undefined;

  constructor(status: number, detail: string | undefined, retryAfter?: number, code?: string) {
    // The server's text is untrusted: never let it carry a credential into a log.
    const safe = detail === undefined ? undefined : redact(detail);
    super(`Scorbit API answered ${status}${safe ? `: ${safe}` : ""}`);
    this.name = "FeedHttpError";
    this.status = status;
    this.detail = safe;
    this.retryAfter = retryAfter;
    this.code = code === undefined ? undefined : redact(code);
  }
}

/**
 * A create without `machines` whose key covers more machines than one feed
 * carries (a `400`). Pass `machines` with a subset; `listMachines` lists them.
 */
export class FeedScopeTooLargeError extends FeedHttpError {
  constructor(detail: string | undefined, code?: string) {
    super(400, detail, undefined, code);
    this.name = "FeedScopeTooLargeError";
  }
}

/**
 * A create at the account's live-feed ceiling (a `400`, code
 * `feed_limit_reached`). End a feed, then create again.
 */
export class FeedLimitReachedError extends FeedHttpError {
  constructor(detail: string | undefined, code?: string) {
    super(400, detail, undefined, code);
    this.name = "FeedLimitReachedError";
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

interface ErrorBody {
  detail?: string;
  code?: string;
}

/**
 * An error body's text and code. The API answers every error in the
 * standardized shape `{message, type, errors: [{code, detail, attr}]}`. Older
 * servers wrote a few as a bare `{"detail": "..."}`, and a bare list of strings
 * is plain DRF's non-field ValidationError: both still parse, without a code.
 */
function errorOf(body: unknown): ErrorBody {
  if (Array.isArray(body)) {
    return body.every((item) => typeof item === "string") ? { detail: body.join(" ") } : {};
  }
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.errors)) {
    const errors = b.errors.filter(
      (e): e is Record<string, unknown> => !!e && typeof e === "object",
    );
    const details = errors.map((e) => e.detail).filter((d) => typeof d === "string");
    const code = errors[0]?.code;
    return {
      detail: details.length
        ? details.join(" ")
        : typeof b.message === "string"
          ? b.message
          : undefined,
      code: typeof code === "string" ? code : undefined,
    };
  }
  return typeof b.detail === "string" ? { detail: b.detail } : {};
}

/**
 * Every request that carries a credential sets `redirect: "manual"` and refuses
 * any redirect: following one would re-send the key, feed token or JWT to
 * wherever the Location header points.
 */
export const NO_REDIRECT = "manual" as const;

/** Release a response body that will not be read, so its connection is not held open. */
export function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/** A redirect the request refused (manual mode: a 3xx, or an opaque redirect in browsers). */
export function refusedRedirect(response: Response): FeedError | undefined {
  const redirected =
    response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
  return redirected
    ? new FeedError(`refused a redirect (${response.status}); credentials are never re-sent`)
    : undefined;
}

/** The largest API response body read; the API's replies are a few kilobytes. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** A response body as text, refusing one larger than the bound instead of buffering it. */
async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new FeedError("response too large");
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** One JSON request with a bearer credential. Resolves the body, or `undefined` on 204. */
export async function request<T>(
  fetchImpl: FetchLike,
  url: string,
  method: string,
  credential: string,
  body?: unknown,
  signal?: AbortSignal,
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
      ...(signal ? { signal } : {}),
    });
    const refused = refusedRedirect(response);
    if (refused) {
      discard(response);
      throw refused;
    }
    text = await boundedText(response);
  } catch (err) {
    // A custom fetch may put the request, bearer credential included, in its error.
    // One a custom fetch throws is a failed request, not an answer from the API.
    throw redactedError(err instanceof FeedHttpError ? err.message : err, "request failed");
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
    const { detail, code } = errorOf(parsed);
    throw new FeedHttpError(
      response.status,
      detail,
      retryAfterOf(response.headers.get("Retry-After")),
      code,
    );
  }
  return parsed as T;
}

// Local pacing after a failure. These are not feed timers: every feed timer
// (the refresh interval, the token lifetime) comes from the server. The cap
// sits far below any token lifetime, so an outage gets many attempts first.
const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

/** Capped exponential backoff for the `attempt`th retry (1-based). */
export const backoff = (attempt: number) =>
  Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);

/**
 * A wait with jitter: somewhere in its upper half, so many clients failing
 * together (a server outage) do not all retry in step.
 */
export const jitter = (ms: number) => ms * (1 - Math.random() / 2);

/** {@link backoff} with {@link jitter}. */
export const jittered = (attempt: number) => jitter(backoff(attempt));

/** Attempts a create or delete makes before a retryable answer is surfaced. */
export const MAX_ATTEMPTS = 4;

const aborted = () => new FeedError("aborted");

/** Wait `ms`, or reject as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `call`, retrying while `retryable` says so, at most {@link MAX_ATTEMPTS}
 * times, with jittered backoff and never sooner than a `Retry-After`. A wait
 * longer than {@link RETRY_MAX_MS} is not made: the error is surfaced instead.
 * `signal` stops it before an attempt or during a wait, never mid-request.
 */
export async function withRetry<T>(
  call: () => Promise<T>,
  retryable: (err: FeedHttpError) => boolean,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw aborted();
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof FeedHttpError) || attempt >= MAX_ATTEMPTS || !retryable(err)) {
        throw err;
      }
      const delay = Math.max(jittered(attempt), (err.retryAfter ?? 0) * 1000);
      if (delay > RETRY_MAX_MS) throw err;
      await sleep(delay, signal);
    }
  }
}

/**
 * DELETE a feed with either credential. 204 and 404 both mean it is gone. A
 * 503 (the feed store is unreachable, nothing deleted) is retried, and so is a
 * 429 whose `Retry-After` fits the cap; a 409 (the record was rewritten on every
 * attempt) is retried once, as the API asks. Deleting is idempotent, so
 * `signal` also aborts a request in flight.
 */
export async function deleteFeedRequest(
  fetchImpl: FetchLike,
  baseUrl: string,
  feedId: string,
  credential: string,
  signal?: AbortSignal,
): Promise<void> {
  let conflicts = 0;
  try {
    await withRetry(
      () => request(fetchImpl, feedUrl(baseUrl, feedId), "DELETE", credential, undefined, signal),
      (err) =>
        err.status === 503 || err.status === 429 || (err.status === 409 && conflicts++ === 0),
      signal,
    );
  } catch (err) {
    // Already gone is the outcome a delete wants.
    if (!(err instanceof FeedHttpError && err.status === 404)) throw err;
  }
}
