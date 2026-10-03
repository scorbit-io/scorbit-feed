import {
  Centrifuge,
  UnauthorizedError,
  connectingCodes,
  subscribingCodes,
  unsubscribedCodes,
} from "centrifuge";

import { FeedError, redactedError } from "../http.js";
import type { Session, Transport, TransportHooks } from "./types.js";

type TokenKind = "connectionToken" | "subscriptionToken";

const TOKEN_ERRORS = new Set(["connectToken", "refreshToken"]);
// Centrifugo's server unsubscribe code; the SDK exports no constant for it.
const SERVER_UNSUBSCRIBE = 2000;

/**
 * The sdk transport: the official Centrifugo SDK over a bidirectional WebSocket, with
 * fossil delta. Tokens are pulled by the SDK through its `getToken` hooks,
 * which serve whatever the scheduled heartbeat last fetched.
 *
 * @param websocket A WebSocket constructor, for runtimes without a global one
 *   (Node 22+ and browsers have one).
 */
export function sdkTransport(websocket?: unknown) {
  return (hooks: TransportHooks): Transport => {
    let current: {
      client: Centrifuge;
      active: boolean;
      endpoint: string;
      channel: string;
    } | null = null;
    // The token each hook last handed the SDK: asking again means it was rejected or expired.
    const handedOut: Record<TokenKind, string | undefined> = {
      connectionToken: undefined,
      subscriptionToken: undefined,
    };

    const tokenFor = async (kind: TokenKind): Promise<string> => {
      const stale = handedOut[kind];
      let token = hooks.latest()[kind];
      if (!token || token === stale) {
        if (!(await hooks.refreshNow())) throw new UnauthorizedError("feed ended");
        token = hooks.latest()[kind];
        // Any other error makes the SDK retry, which is right for a failed refresh.
        if (!token || token === stale) throw new FeedError("token refresh failed");
      }
      handedOut[kind] = token;
      return token;
    };

    const close = () => {
      if (!current) return;
      current.active = false;
      current.client.disconnect();
      current = null;
    };

    const open = (session: Session) => {
      close();
      handedOut.connectionToken = session.connectionToken;
      handedOut.subscriptionToken = session.subscriptionToken;
      const client = new Centrifuge(session.endpoint, {
        token: session.connectionToken,
        getToken: () => tokenFor("connectionToken"),
        ...(websocket ? { websocket } : {}),
      });
      const conn = { client, active: true, endpoint: session.endpoint, channel: session.channel };
      current = conn;
      const drop = (report: () => void) => {
        conn.active = false;
        client.disconnect();
        current = null;
        report();
      };

      client.on("connecting", (ctx) => {
        if (conn.active && ctx.code !== connectingCodes.connectCalled) hooks.reconnecting();
      });
      // `disconnected` means the SDK will not reconnect by itself: the server
      // sent a no-reconnect code, or getToken said the feed is over.
      client.on("disconnected", (ctx) => {
        if (conn.active) drop(() => hooks.disconnected(ctx.code));
      });
      client.on("error", (ctx) => {
        // Token errors come from our own getToken, and the feed has reported those already.
        if (!conn.active || TOKEN_ERRORS.has(ctx.type)) return;
        hooks.error(redactedError(ctx.error.message, `centrifugo ${ctx.type} error`));
      });

      // Fossil delta needs a positioned, recoverable subscription.
      const sub = client.newSubscription(session.channel, {
        token: session.subscriptionToken,
        getToken: () => tokenFor("subscriptionToken"),
        delta: "fossil",
        positioned: true,
        recoverable: true,
      });
      sub.on("subscribed", () => {
        if (conn.active) hooks.live();
      });
      sub.on("subscribing", (ctx) => {
        if (conn.active && ctx.code !== subscribingCodes.subscribeCalled) hooks.reconnecting();
      });
      // The SDK resubscribes by itself where it can; `unsubscribed` from the server is final.
      sub.on("unsubscribed", (ctx) => {
        if (!conn.active || ctx.code === unsubscribedCodes.unsubscribeCalled) return;
        drop(() =>
          ctx.code === SERVER_UNSUBSCRIBE ? hooks.unsubscribed() : hooks.disconnected(ctx.code),
        );
      });
      sub.on("publication", (ctx) => {
        if (conn.active) hooks.publication(ctx.data);
      });

      sub.subscribe();
      client.connect();
    };

    // New tokens reach the SDK through getToken, so a refresh is normally a no-op.
    // A new endpoint or channel cannot: rebuild the client (open() closes the old one first).
    const refreshed = (session: Session) => {
      if (
        current &&
        (current.endpoint !== session.endpoint || current.channel !== session.channel)
      ) {
        open(session);
      }
    };

    return { open, refreshed, close };
  };
}
