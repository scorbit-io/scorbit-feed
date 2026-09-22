import { FeedError, type FetchLike, redact } from "../http.js";
import { asFeedUpdate } from "../message.js";
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
    let current: { active: boolean; abort: AbortController } | null = null;

    const close = () => {
      if (!current) return;
      current.active = false;
      current.abort.abort();
      current = null;
    };

    const handle = (conn: NonNullable<typeof current>, raw: string) => {
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      // uni_sse frames carry the reply directly, or wrapped in `push`.
      const wrapped = message as { push?: unknown } | null;
      const push = (wrapped?.push ?? wrapped) as {
        connect?: unknown;
        disconnect?: { code?: unknown };
        pub?: { data?: unknown };
      } | null;
      if (push?.disconnect) {
        close();
        const { code } = push.disconnect;
        hooks.disconnected(typeof code === "number" ? code : undefined);
        return;
      }
      if (push?.connect) hooks.live();
      const update = asFeedUpdate(push?.pub?.data);
      if (update && conn.active) hooks.update(update);
    };

    const run = async (conn: NonNullable<typeof current>, session: Session) => {
      try {
        const response = await fetchImpl(session.endpoint, {
          method: "POST",
          headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
          body: JSON.stringify({ token: session.connectionToken }),
          signal: conn.abort.signal,
        });
        if (!conn.active) return;
        if (!response.ok || !response.body) {
          throw new FeedError(`SSE endpoint answered ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (!conn.active) return;
          if (done) break;
          for (const data of parser.push(decoder.decode(value, { stream: true }))) {
            handle(conn, data);
            if (!conn.active) return;
          }
        }
        throw new FeedError("SSE stream closed by the server");
      } catch (err) {
        if (!conn.active) return;
        close();
        const message = err instanceof Error ? err.message : String(err);
        hooks.lost(new FeedError(redact(`SSE connection failed: ${message}`)));
      }
    };

    const open = (session: Session) => {
      close();
      const conn = { active: true, abort: new AbortController() };
      current = conn;
      // run() handles every failure itself.
      void run(conn, session);
    };

    return { open, refreshed: open, close };
  };
}
