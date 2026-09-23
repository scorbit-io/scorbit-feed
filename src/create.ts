import { type AttachOptions, type Feed, attachFeed } from "./feed.js";
import {
  API_KEY_PREFIX,
  DEFAULT_BASE_URL,
  FeedError,
  type FetchLike,
  checkBaseUrl,
  feedUrl,
  request,
} from "./http.js";
import type { CreatedFeed, Transport } from "./types.js";
import { createdProblem } from "./validate.js";

export interface CreateOptions {
  /** The `sb_live_` API key. A server-side secret: never ship it to a browser. */
  apiKey: string;
  /**
   * VenueMachine uuids, in the order the feed should carry them. Omit to stream
   * everything in the API key's scope (planned server support): a venue-scoped
   * feed then gains and loses machines as the venue's membership changes.
   */
  machines?: string[];
  transport?: Transport;
  /** Defaults to the production API, `https://api.scorbit.io`. Must be https, except on localhost. */
  baseUrl?: string;
  fetch?: FetchLike;
  /**
   * createFeed refuses to run in a page or a worker (`window`, `document` or
   * `WorkerGlobalScope` defined), because the API key must never reach a
   * browser. Set this only for a trusted runtime that happens to define them.
   */
  dangerouslyAllowBrowser?: boolean;
}

// A page, a worker, or anything that looks like one.
const inBrowser = () =>
  typeof window !== "undefined" ||
  typeof document !== "undefined" ||
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined";

function resolve(options: CreateOptions): { fetchImpl: FetchLike; baseUrl: string } {
  return {
    fetchImpl: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    baseUrl: checkBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
  };
}

/** Best-effort DELETE with the API key, for a feed created but not usable. */
async function deleteWithKey(options: CreateOptions, feedId: string): Promise<void> {
  const { fetchImpl, baseUrl } = resolve(options);
  await request(fetchImpl, feedUrl(baseUrl, feedId), "DELETE", options.apiKey).catch(
    () => undefined,
  );
}

/** Create a feed with the `sb_live_` API key. Server-side only. */
export async function createFeed(options: CreateOptions): Promise<CreatedFeed> {
  if (inBrowser() && !options.dangerouslyAllowBrowser) {
    throw new FeedError(
      "createFeed runs server-side only: it needs the sb_live_ API key, which must never reach a browser. Create the feed on a server and hand the browser its sbf_ feed token (attachFeed).",
    );
  }
  if (!String(options.apiKey ?? "").startsWith(API_KEY_PREFIX)) {
    throw new FeedError("createFeed needs an sb_live_ API key.");
  }
  const { machines } = options;
  if (machines !== undefined && (!Array.isArray(machines) || machines.length === 0)) {
    throw new FeedError(
      "createFeed: `machines` narrows the key's scope; omit it, or list at least one uuid.",
    );
  }
  const { fetchImpl, baseUrl } = resolve(options);
  const created = await request<unknown>(
    fetchImpl,
    feedUrl(baseUrl),
    "POST",
    options.apiKey,
    // No `machines` field at all means "everything in this key's scope".
    { ...(machines ? { machines } : {}), transport: options.transport ?? "sdk" },
  );
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
