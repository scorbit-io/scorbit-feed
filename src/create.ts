import { type AttachOptions, type Feed, attachFeed } from "./feed.js";
import {
  API_KEY_PREFIX,
  DEFAULT_BASE_URL,
  FeedError,
  FeedHttpError,
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
  const scope = await request<unknown>(fetchImpl, url, "GET", options.apiKey);
  const problem = scopeProblem(scope);
  if (problem) throw new FeedError(`malformed machines response: bad ${problem}`);
  return scope as MachineScope;
}

/**
 * Create a feed with the `sb_live_` API key. Server-side only. A `503` (data
 * feeds switched off, or the feed store unreadable; nothing was created) is
 * retried a few times with backoff before it is thrown.
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
  try {
    created = await withRetry(
      () => request<unknown>(fetchImpl, feedUrl(baseUrl), "POST", options.apiKey, body),
      (err) => err.status === 503,
    );
  } catch (err) {
    // The one 400 that names `machines` when none were sent: the scope is too large for one feed.
    const tooLarge =
      err instanceof FeedHttpError &&
      err.status === 400 &&
      !machines &&
      /\bmachines\b/.test(err.detail ?? "");
    throw tooLarge ? new FeedScopeTooLargeError(err.detail) : err;
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
