import type { FeedUpdate } from "./types.js";

/** Narrow a publication's data to a `data_feed_update`, or `undefined` for anything else. */
export function asFeedUpdate(data: unknown): FeedUpdate | undefined {
  if (!data || typeof data !== "object") return undefined;
  const message = data as { type?: unknown; payload?: { machines?: unknown } };
  if (message.type !== "data_feed_update") return undefined;
  if (!Array.isArray(message.payload?.machines)) return undefined;
  return data as FeedUpdate;
}
