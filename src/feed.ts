import { Emitter } from "./emitter.js";
import {
  API_KEY_PREFIX,
  DEFAULT_BASE_URL,
  FEED_TOKEN_PREFIX,
  FeedError,
  FeedHttpError,
  type FetchLike,
  checkBaseUrl,
  checkEndpoint,
  feedUrl,
  redactedError,
  request,
} from "./http.js";
import { sdkTransport } from "./transports/sdk.js";
import { sseTransport } from "./transports/sse.js";
import { tokensProblem } from "./validate.js";
import type { Transport as TransportImpl, TransportHooks } from "./transports/types.js";
import type {
  EndReason,
  FeedInfo,
  FeedMachinesChange,
  FeedStatus,
  FeedTokens,
  FeedUpdate,
  Transport,
} from "./types.js";

// Local pacing after a failure. These are not feed timers: every feed timer
// (the refresh interval, the token lifetime) comes from the server. The cap
// sits far below any token lifetime, so an outage gets many attempts first.
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
// A connection must stay live this long before a drop counts as a fresh
// failure (refresh at once) rather than part of a reconnect storm (back off).
const STABLE_MS = 30_000;

const TERMINAL: Partial<Record<number, EndReason>> = {
  401: "unauthorized",
  403: "withdrawn",
  404: "ended",
};

/** Centrifugo: 3000-3499 and 4000-4499 ask the client to reconnect; other codes do not. */
function reconnectable(code: number | undefined): boolean {
  return code === undefined || (code >= 3000 && code < 3500) || (code >= 4000 && code < 4500);
}

const backoff = (attempt: number) => Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);

export interface AttachOptions {
  feedId: string;
  /** The `sbf_` feed token. The only credential that is safe in a browser. */
  feedToken: string;
  /** Defaults to the production API, `https://api.scorbit.io`. Must be https, except on localhost. */
  baseUrl?: string;
  /**
   * The transport the feed was created with. Advisory: the server's answer
   * (or the token shape it returns) wins.
   */
  transport?: Transport;
  /**
   * The Centrifugo endpoint (`ws_endpoint` or `sse_endpoint` from create).
   * The heartbeat response does not include the endpoint yet, so attaching
   * without `initialTokens` needs this.
   */
  endpoint?: string;
  /** Tokens already in hand, e.g. the create response: connect without a first heartbeat. */
  initialTokens?: FeedTokens | FeedInfo;
  /** A fetch implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** A WebSocket constructor for the sdk transport, for a runtime without a global `WebSocket`. */
  websocket?: unknown;
}

export interface FeedEvents {
  update: FeedUpdate;
  /** Emitted before the `update` that changed the set. */
  machines: FeedMachinesChange;
  status: FeedStatus;
  ended: { reason: EndReason };
  error: Error;
}

export interface StopOptions {
  /** DELETE the feed on the server as well as disconnecting. Default true. */
  deleteFeed?: boolean;
}

/** A live attachment to one data feed. Create it with {@link attachFeed}. */
export class Feed extends Emitter<FeedEvents> {
  readonly feedId: string;
  private readonly feedToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly websocket: unknown;
  private readonly initialTokens: FeedTokens | undefined;

  private currentStatus: FeedStatus = "idle";
  private tokens: FeedTokens | undefined;
  private endpoint: string | undefined;
  private transportName: Transport | undefined;
  private transport: TransportImpl | undefined;
  private opened = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<boolean> | undefined;
  // Sticky until a heartbeat succeeds: a dropped connection is reopened by
  // whichever refresh lands next, scheduled or already in flight.
  private reopenPending = false;
  private refreshAttempts = 0;
  private dropAttempts = 0;
  private liveSince: number | undefined;
  private started = false;
  private finished = false;
  private endReason: EndReason | undefined;
  // Set once end() has delivered `ended`: nothing is delivered after that.
  private silenced = false;
  private deletion: Promise<void> | undefined;
  // Never assumed fixed: every update is compared against the last set seen.
  private machineSet: string[];

  /**
   * Same as {@link attachFeed}. The checks run here, so no way of constructing
   * a Feed can skip them: an `sbf_` token only, and https URLs.
   */
  constructor(options: AttachOptions) {
    super();
    checkAttachOptions(options);
    this.feedId = options.feedId;
    this.feedToken = options.feedToken;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.websocket = options.websocket;
    this.initialTokens = options.initialTokens;
    this.endpoint =
      options.endpoint ?? options.initialTokens?.ws_endpoint ?? options.initialTokens?.sse_endpoint;
    this.transportName = options.transport;
    const initial = options.initialTokens;
    this.machineSet =
      initial && "machines" in initial ? initial.machines.map((machine) => machine.uuid) : [];
  }

  /** The machine uuids the feed currently carries, in order. */
  get machines(): string[] {
    return [...this.machineSet];
  }

  get status(): FeedStatus {
    return this.currentStatus;
  }

  /** Connect, and keep the tokens fresh on the server's schedule until stopped or ended. */
  start(): void {
    if (this.started || this.finished) return;
    this.started = true;
    if (!this.setStatus("connecting")) return;
    if (
      this.initialTokens &&
      !tokensProblem(this.initialTokens) &&
      this.apply(this.initialTokens)
    ) {
      return;
    }
    this.reopenPending = true;
    void this.refresh();
  }

  /** Disconnect, stop refreshing, and (by default) delete the feed on the server. */
  /**
   * Idempotent: safe to call again after the feed ended locally (for example
   * on a bad endpoint), and it still deletes the feed then. After the server
   * ended it (`withdrawn`, `ended`, `unauthorized`) there is nothing to delete.
   */
  async stop({ deleteFeed = true }: StopOptions = {}): Promise<void> {
    this.end("stopped");
    if (!deleteFeed || this.endReason !== "stopped") return;
    this.deletion ??= this.deleteOnServer().catch((err: unknown) => {
      this.deletion = undefined; // a failed delete may be retried
      throw err;
    });
    return this.deletion;
  }

  private async deleteOnServer(): Promise<void> {
    try {
      await request(this.fetchImpl, feedUrl(this.baseUrl, this.feedId), "DELETE", this.feedToken);
    } catch (err) {
      // Already gone is the outcome stop() wanted.
      if (!(err instanceof FeedHttpError && err.status === 404)) throw err;
    }
  }

  // A throwing listener must not break the lifecycle: report it, redacted, as an error event.
  protected override listenerFailed(event: keyof FeedEvents, err: unknown): void {
    // After the end there is no error event to carry it: re-throw it outside instead.
    if (event === "error" || this.finished) super.listenerFailed(event, err);
    else this.emit("error", redactedError(err));
  }

  protected override deliverable(): boolean {
    return !this.silenced;
  }

  // --- lifecycle --------------------------------------------------------------

  /**
   * Every emit inside the feed goes through here. A listener may call stop()
   * synchronously, so the caller must do nothing more when this returns false.
   */
  private emitAlive<K extends keyof FeedEvents>(event: K, value: FeedEvents[K]): boolean {
    this.emit(event, value);
    return !this.finished;
  }

  /** False once the feed has finished during the emit. */
  private setStatus(status: FeedStatus): boolean {
    if (status === this.currentStatus) return true;
    this.currentStatus = status;
    return this.emitAlive("status", status);
  }

  private end(reason: EndReason): void {
    // Once only; and finished first, so nothing a listener does below can restart any work.
    if (this.finished) return;
    this.finished = true;
    this.endReason = reason;
    this.clearTimer();
    this.transport?.close();
    this.currentStatus = "ended";
    this.emit("status", "ended");
    this.emit("ended", { reason });
    this.silenced = true;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, ms);
  }

  // A failed refresh leaves the status alone: a live connection stays live on the tokens it holds.
  private fail(error: Error, retryAfterMs = 0): void {
    if (!this.emitAlive("error", error)) return;
    this.refreshAttempts += 1;
    this.schedule(Math.max(backoff(this.refreshAttempts), retryAfterMs));
  }

  /** The connection dropped. Reopen at once only after a stable session; otherwise back off. */
  private dropped(code: number | undefined, error?: Error): void {
    if (error && !this.emitAlive("error", error)) return;
    if (!this.setStatus("reconnecting")) return;
    const stable = this.liveSince !== undefined && Date.now() - this.liveSince >= STABLE_MS;
    this.liveSince = undefined;
    if (stable) this.dropAttempts = 0;
    this.reopenPending = true;
    if (!reconnectable(code)) {
      // The server said not to reconnect: back off hard, and let the heartbeat settle whether the feed is over.
      this.dropAttempts += 1;
      this.schedule(RETRY_MAX_MS);
    } else if (stable) {
      void this.refresh();
    } else {
      this.dropAttempts += 1;
      this.schedule(backoff(this.dropAttempts));
    }
  }

  /** One heartbeat at a time; a second caller shares the one in flight. Never rejects. */
  private refresh(): Promise<boolean> {
    if (this.finished) return Promise.resolve(false);
    if (this.inflight) return this.inflight;
    this.clearTimer();
    this.inflight = this.heartbeat()
      .catch((err: unknown) => this.emitAlive("error", redactedError(err)))
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /** Resolves false once the feed has ended or been stopped. */
  private async heartbeat(): Promise<boolean> {
    let tokens: FeedTokens;
    try {
      tokens = await request<FeedTokens>(
        this.fetchImpl,
        feedUrl(this.baseUrl, this.feedId, "heartbeat"),
        "POST",
        this.feedToken,
        {},
      );
    } catch (err) {
      if (this.finished) return false;
      const reason = err instanceof FeedHttpError ? TERMINAL[err.status] : undefined;
      if (reason) {
        this.end(reason);
        return false;
      }
      const retryAfter = err instanceof FeedHttpError ? (err.retryAfter ?? 0) : 0;
      this.fail(redactedError(err, "heartbeat failed"), retryAfter * 1000);
      return true;
    }
    if (this.finished) return false;
    // A malformed answer is a failed refresh, retried with backoff, never trusted.
    const problem =
      tokensProblem(tokens) ??
      (this.opened &&
      this.transportName === "sdk" &&
      !tokens.transport &&
      !tokens.subscription_token
        ? "subscription_token"
        : undefined);
    if (problem) this.fail(new FeedError(`malformed heartbeat response: bad ${problem}`));
    else this.apply(tokens);
    return !this.finished;
  }

  /** Adopt a validated token set: (re)connect as needed and schedule the next refresh. */
  private apply(tokens: FeedTokens): boolean {
    // Server-supplied and per-feed: never a compiled-in constant.
    const interval = tokens.heartbeat_interval;
    this.tokens = tokens;
    this.refreshAttempts = 0;
    // The heartbeat response may not carry the endpoint yet: keep the last known one.
    this.endpoint = tokens.ws_endpoint ?? tokens.sse_endpoint ?? this.endpoint;
    const name: Transport = tokens.transport ?? (tokens.subscription_token ? "sdk" : "sse");
    try {
      if (!this.endpoint) {
        throw new FeedError(
          "No Centrifugo endpoint for this feed: pass `endpoint` (the ws_endpoint or sse_endpoint from create) to attachFeed",
        );
      }
      const session = {
        endpoint: checkEndpoint(this.endpoint),
        channel: tokens.channel ?? `data_feed:${this.feedId}`,
        connectionToken: tokens.connection_token,
        subscriptionToken: tokens.subscription_token,
      };
      if (!this.transport || name !== this.transportName) {
        this.transport?.close();
        this.transport = this.createTransport(name);
        this.transportName = name;
        this.opened = false;
      }
      if (this.reopenPending || !this.opened) this.transport.open(session);
      else this.transport.refreshed(session);
    } catch (err) {
      // A connection that cannot even be attempted ends the feed locally; the server keeps it.
      if (this.emitAlive("error", redactedError(err))) this.end("stopped");
      return true;
    }
    // Opening may have emitted synchronously, and a listener may have stopped the feed.
    if (this.finished) return true;
    this.opened = true;
    this.reopenPending = false;
    this.schedule(interval * 1000);
    return true;
  }

  private trackMachines(update: FeedUpdate): boolean {
    const next = update.payload.machines.map((machine) => machine.machine_uuid);
    const before = new Set(this.machineSet);
    const after = new Set(next);
    const added = next.filter((uuid) => !before.has(uuid));
    const removed = this.machineSet.filter((uuid) => !after.has(uuid));
    this.machineSet = next;
    if (!added.length && !removed.length) return true;
    return this.emitAlive("machines", { added, removed, machines: next });
  }

  private createTransport(name: Transport): TransportImpl {
    const hooks: TransportHooks = {
      // Transports stop calling these once closed, and end() closes the transport.
      update: (update) => {
        if (this.trackMachines(update)) this.emitAlive("update", update);
      },
      live: () => {
        if (this.currentStatus !== "live") this.liveSince = Date.now();
        this.setStatus("live");
      },
      reconnecting: () => {
        this.liveSince = undefined;
        this.setStatus("reconnecting");
      },
      disconnected: (code) => this.dropped(code),
      lost: (error) => this.dropped(undefined, error),
      error: (error) => this.emitAlive("error", redactedError(error)),
      latest: () => {
        // apply() stores the tokens before it creates a transport.
        const tokens = this.tokens as FeedTokens;
        return {
          connectionToken: tokens.connection_token,
          subscriptionToken: tokens.subscription_token,
        };
      },
      refreshNow: () => this.refresh(),
    };
    return name === "sdk"
      ? sdkTransport(this.websocket)(hooks)
      : sseTransport(this.fetchImpl)(hooks);
  }
}

/**
 * Attach to an existing feed with its `sbf_` feed token. Browser-safe. Nothing
 * connects until `start()`.
 */
export function attachFeed(options: AttachOptions): Feed {
  return new Feed(options);
}

function checkAttachOptions(options: AttachOptions): void {
  const token = String(options.feedToken ?? "");
  if (token.startsWith(API_KEY_PREFIX)) {
    throw new FeedError(
      "attachFeed was given an sb_live_ API key. The API key is a server-side secret: create the feed on a server and pass only its sbf_ feed token here.",
    );
  }
  if (!token.startsWith(FEED_TOKEN_PREFIX)) {
    throw new FeedError("attachFeed needs the sbf_ feed token returned when the feed was created.");
  }
  if (!options.feedId) throw new FeedError("attachFeed needs a feedId.");
  checkBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  if (options.endpoint !== undefined) checkEndpoint(options.endpoint);
}
