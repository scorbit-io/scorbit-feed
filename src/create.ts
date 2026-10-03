import { type AttachOptions, type Feed, attachFeed } from "./feed.js";
import {
  API_KEY_PREFIX,
  DEFAULT_BASE_URL,
  FeedError,
  FeedHttpError,
  FeedLimitReachedError,
  FeedScopeTooLargeError,
  type FetchLike,
  checkBaseUrl,
  deleteFeedRequest,
  feedUrl,
  request,
  withRetry,
} from "./http.js";
import type { CreatedFeed, MachineScope, Transport } from "./types.js";
import { createdProblem, scopeProblem } from "./validate.js";

/** Options for the calls that take the API key: `listMachines` and `createFeed`. */
export interface KeyOptions {
  /** The `sb_live_` API key. A server-side secret: never ship it to a browser. */
  apiKey: string;
  /** Defaults to the production API, `https://api.scorbit.io`. Must be https, except on localhost. */
  baseUrl?: string;
  fetch?: FetchLike;
  /**
   * These calls refuse to run in a page or a worker (`window`, `document` or
   * `WorkerGlobalScope` defined), because the API key must never reach a
   * browser. Set this only for a trusted runtime that happens to define them.
   */
  dangerouslyAllowBrowser?: boolean;
  /**
   * Stops the call. `listMachines` aborts its request; `createFeed` stops
   * before its next attempt or during a wait between them, but never abandons
   * a create in flight, whose answer says whether a feed now exists.
   */
  signal?: AbortSignal;
}

export interface CreateOptions extends KeyOptions {
  /**
   * VenueMachine uuids, in the order the feed should carry them: a subset of
   * the key's scope. Omit to stream the whole scope; on a venue-scoped key the
   * feed then follows its venues, gaining and losing machines as they come and go.
   */
  machines?: string[];
  transport?: Transport;
}

// The API's own create 503s, and only those, are retried: nothing was written
// (the platform switch is off, or live feeds cannot be counted). A 503 from
// anything in front of the API may follow a create that went through, so one
// without these codes is not retried.
const RETRYABLE_CREATE_CODES = new Set(["data_feeds_unavailable", "feeds_uncountable"]);
// A failed record write is retried once only: its write may have landed, and
// that record counts toward the live-feed limit until it is dropped as unwatched.
const STORE_UNAVAILABLE_CODE = "feed_store_unavailable";
// Older servers wrote the uncountable 503 as a bare `{"detail"}` with no code;
// only for them is this exact sentence matched.
const LEGACY_UNCOUNTABLE_DETAIL = "Your live feeds cannot be counted right now. Try again shortly.";
const refusedBeforeWrite = (err: FeedHttpError) =>
  err.status === 503 &&
  (RETRYABLE_CREATE_CODES.has(err.code ?? "") ||
    (err.code === undefined && err.detail === LEGACY_UNCOUNTABLE_DETAIL));

// Older servers sent the over-scope 400 with the generic `invalid` code, so for
// them its sentence is matched as well; the code is checked first.
const SCOPE_TOO_LARGE_CODE = "scope_too_large";
const LEGACY_SCOPE_TOO_LARGE =
  /^This key covers \d+ machines and a feed carries at most \d+\. Pass `machines` with a subset\.$/;
const scopeTooLarge = (err: FeedHttpError) =>
  err.status === 400 &&
  (err.code === SCOPE_TOO_LARGE_CODE ||
    ((err.code === undefined || err.code === "invalid") &&
      LEGACY_SCOPE_TOO_LARGE.test(err.detail ?? "")));

const FEED_LIMIT_REACHED_CODE = "feed_limit_reached";

/** The typed error a create's refusal maps to, or the error itself. */
function typedCreateError(err: unknown, machines: string[] | undefined): unknown {
  if (!(err instanceof FeedHttpError)) return err;
  // Only a create without `machines` can be refused for covering too much.
  if (!machines && scopeTooLarge(err)) return new FeedScopeTooLargeError(err.detail, err.code);
  if (err.status === 400 && err.code === FEED_LIMIT_REACHED_CODE) {
    return new FeedLimitReachedError(err.detail, err.code);
  }
  return err;
}

// A page, a worker, or anything that looks like one.
const inBrowser = () =>
  typeof window !== "undefined" ||
  typeof document !== "undefined" ||
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined";

function resolve(options: KeyOptions): { fetchImpl: FetchLike; baseUrl: string } {
  return {
    fetchImpl: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    baseUrl: checkBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
  };
}

/** The checks every API-key call makes before any request. */
function checkKeyOptions(name: string, options: KeyOptions): void {
  if (inBrowser() && !options.dangerouslyAllowBrowser) {
    throw new FeedError(
      `${name} runs server-side only: it needs the sb_live_ API key, which must never reach a browser. Create the feed on a server and hand the browser its sbf_ feed token (attachFeed).`,
    );
  }
  if (!String(options.apiKey ?? "").startsWith(API_KEY_PREFIX)) {
    throw new FeedError(`${name} needs an sb_live_ API key.`);
  }
}

/** Best-effort DELETE with the API key, for a feed created but not usable. */
async function deleteWithKey(options: KeyOptions, feedId: string): Promise<void> {
  const { fetchImpl, baseUrl } = resolve(options);
  await deleteFeedRequest(fetchImpl, baseUrl, feedId, options.apiKey).catch(() => undefined);
}

/** The machines the `sb_live_` API key covers now, with their venues. Server-side only. */
export async function listMachines(options: KeyOptions): Promise<MachineScope> {
  checkKeyOptions("listMachines", options);
  const { fetchImpl, baseUrl } = resolve(options);
  const url = feedUrl(baseUrl, undefined, "machines");
  const scope = await request<unknown>(
    fetchImpl,
    url,
    "GET",
    options.apiKey,
    undefined,
    options.signal,
  );
  const problem = scopeProblem(scope);
  if (problem) throw new FeedError(`malformed machines response: bad ${problem}`);
  return scope as MachineScope;
}

/**
 * Create a feed with the `sb_live_` API key. Server-side only. The API's own
 * `503` (codes `data_feeds_unavailable` and `feeds_uncountable`) is retried a
 * few times with backoff before it is thrown, and `feed_store_unavailable` once. A refusal for scope throws `FeedScopeTooLargeError`, one at the
 * live-feed ceiling `FeedLimitReachedError`.
 */
export async function createFeed(options: CreateOptions): Promise<CreatedFeed> {
  checkKeyOptions("createFeed", options);
  const { machines } = options;
  if (machines !== undefined && (!Array.isArray(machines) || machines.length === 0)) {
    throw new FeedError(
      "createFeed: `machines` narrows the key's scope; omit it, or list at least one uuid.",
    );
  }
  const { fetchImpl, baseUrl } = resolve(options);
  // No `machines` field at all means "everything in this key's scope".
  const body = { ...(machines ? { machines } : {}), transport: options.transport ?? "sdk" };
  let created: unknown;
  let storeFailure: FeedHttpError | undefined;
  const retryable = (err: FeedHttpError) => {
    if (err.status !== 503 || err.code !== STORE_UNAVAILABLE_CODE) return refusedBeforeWrite(err);
    const first = storeFailure === undefined;
    storeFailure ??= err;
    return first;
  };
  try {
    created = await withRetry(
      () => request<unknown>(fetchImpl, feedUrl(baseUrl), "POST", options.apiKey, body),
      retryable,
      options.signal,
    );
  } catch (err) {
    const typed = typedCreateError(err, machines);
    // The limit may be this call's own record, written before the store failed.
    if (storeFailure && typed instanceof FeedLimitReachedError) {
      throw new FeedHttpError(
        503,
        "The feed store failed during the create, and a feed it may have left counts toward the live-feed limit. Try again in a couple of minutes.",
        storeFailure.retryAfter,
        STORE_UNAVAILABLE_CODE,
      );
    }
    throw typed;
  }
  const problem = createdProblem(created);
  if (problem) {
    // The server may have created a feed we cannot use: delete it with the key, best effort.
    const feedId = (created as { feed_id?: unknown } | undefined)?.feed_id;
    if (typeof feedId === "string" && feedId) await deleteWithKey(options, feedId);
    throw new FeedError(`malformed create response: bad ${problem}`);
  }
  return created as CreatedFeed;
}

export type OpenOptions = CreateOptions & Pick<AttachOptions, "websocket">;

/**
 * Create a feed and attach to it, for Node and agent use. The feed is not
 * started: register listeners, then call `feed.start()`. `created` carries the
 * feed token; keep it out of logs and responses.
 */
export async function openFeed(
  options: OpenOptions,
): Promise<{ feed: Feed; created: CreatedFeed }> {
  const created = await createFeed(options);
  try {
    const feed = attachFeed({
      feedId: created.feed_id,
      feedToken: created.feed_token,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      websocket: options.websocket,
      initialTokens: created,
    });
    return { feed, created };
  } catch (err) {
    // The feed exists on the server but cannot be used here: do not leak it.
    await deleteWithKey(options, created.feed_id);
    throw err;
  }
}
