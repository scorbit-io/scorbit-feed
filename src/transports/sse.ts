import {
  FeedError,
  type FetchLike,
  NO_REDIRECT,
  discard,
  redactedError,
  refusedRedirect,
} from "../http.js";
import { SseParser } from "../sse-parser.js";
import type { Session, Transport, TransportHooks } from "./types.js";

/**
 * The sse transport: Centrifugo's unidirectional SSE endpoint, read with `fetch` so it
 * runs in browsers and Node without EventSource. The connect command goes in a
 * POST body (which uni_sse accepts), so the token never appears in a URL. A
 * unidirectional client cannot swap tokens in place, so every refresh reopens
 * the stream.
 */
export function sseTransport(fetchImpl: FetchLike) {
  return (hooks: TransportHooks): Transport => {
    let current: { active: boolean; abort: AbortController; channel: string } | null = null;

    const close = () => {
      if (!current) return;
      current.active = false;
      current.abort.abort();
      current = null;
    };

    const handle = (conn: NonNullable<typeof current>, raw: string) => {
      // A replaced stream's buffered frames must never reach the feed.
      if (!conn.active) return;
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      // uni_sse frames carry the reply directly, or wrapped in `push`.
      const wrapped = message as { push?: unknown } | null;
      const push = (wrapped?.push ?? wrapped) as {
        channel?: unknown;
        connect?: unknown;
        disconnect?: { code?: unknown };
        unsubscribe?: { code?: unknown };
        pub?: { data?: unknown };
      } | null;
      if (push?.disconnect) {
        close();
        const { code } = push.disconnect;
        hooks.disconnected(typeof code === "number" ? code : undefined);
        return;
      }
      // Only this connection's channel, or the server-side subscription's (no channel), as for pub.
      // Codes from 2500 ask for a resubscribe, not an end; any other value counts as an unsubscribe.
      if (push?.unsubscribe) {
        if (push.channel !== undefined && push.channel !== conn.channel) return;
        const { code } = push.unsubscribe;
        if (typeof code === "number" && code >= 2500) return;
        close();
        hooks.unsubscribed();
        return;
      }
      if (push?.connect) hooks.live();
      // hooks.live() may have stopped the feed, which closes this connection.
      if (!conn.active) return;
      if (!push?.pub) return;
      // A publication names its channel on the push. One for any other channel
      // is not this feed's, whatever it contains. A push with no channel is the
      // server-side subscription's, which is only ever this feed's own.
      if (push.channel !== undefined && push.channel !== conn.channel) {
        hooks.error(new FeedError("publication for another channel dropped"));
        return;
      }
      hooks.publication(push.pub.data);
    };

    const run = async (conn: NonNullable<typeof current>, session: Session) => {
      try {
        const response = await fetchImpl(session.endpoint, {
          method: "POST",
          headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
          body: JSON.stringify({ token: session.connectionToken }),
          signal: conn.abort.signal,
          redirect: NO_REDIRECT,
        });
        if (!conn.active) return discard(response);
        const refused = refusedRedirect(response);
        if (refused) {
          discard(response);
          throw refused;
        }
        if (!response.ok || !response.body) {
          discard(response);
          throw new FeedError(`SSE endpoint answered ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (!conn.active) return;
          if (done) break;
          // handle() drops every frame once this connection is no longer current.
          for (const data of parser.push(decoder.decode(value, { stream: true }))) {
            handle(conn, data);
          }
        }
        throw new FeedError("SSE stream closed by the server");
      } catch (err) {
        if (!conn.active) return;
        close();
        hooks.lost(redactedError(err, "SSE connection failed"));
      }
    };

    const open = (session: Session) => {
      close();
      const conn = { active: true, abort: new AbortController(), channel: session.channel };
      current = conn;
      // run() handles every failure itself.
      void run(conn, session);
    };

    return { open, refreshed: open, close };
  };
}
