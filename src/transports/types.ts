/** What a transport needs to connect once. */
export interface Session {
  endpoint: string;
  channel: string;
  connectionToken: string;
  subscriptionToken?: string;
}

/** How a transport reports back to the feed that owns it. */
export interface TransportHooks {
  /** A publication's data, unvalidated: the feed checks it before anything reads it. */
  publication(data: unknown): void;
  live(): void;
  reconnecting(): void;
  /** The server closed the connection with a Centrifugo disconnect code. */
  disconnected(code?: number): void;
  /** The server unsubscribed the connection from the feed's channel, which may mean the feed is over. */
  unsubscribed(): void;
  /** The connection failed or ended without a disconnect code. */
  lost(error: Error): void;
  error(error: Error): void;
  /** The newest tokens the feed holds. */
  latest(): { connectionToken: string; subscriptionToken?: string };
  /** Heartbeat now; resolves false once the feed has ended or been stopped. */
  refreshNow(): Promise<boolean>;
}

export interface Transport {
  open(session: Session): void;
  /** New tokens arrived from a scheduled refresh. */
  refreshed(session: Session): void;
  close(): void;
}

export type TransportFactory = (hooks: TransportHooks) => Transport;
