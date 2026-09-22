/* A stand-in for the `centrifuge` client: records what the transport asked for and lets a test emit SDK events. */

type Handler = (ctx: never) => void;

class Events {
  private handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  emit(event: string, ctx: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) (handler as (c: unknown) => void)(ctx);
  }
}

export interface FakeSubscriptionOptions {
  token?: string;
  getToken?: () => Promise<string>;
  delta?: string;
  positioned?: boolean;
  recoverable?: boolean;
}

export class FakeSubscription extends Events {
  subscribeCalls = 0;
  constructor(
    readonly channel: string,
    readonly options: FakeSubscriptionOptions,
  ) {
    super();
  }

  subscribe(): void {
    this.subscribeCalls += 1;
  }
}

export interface FakeClientOptions {
  token: string;
  getToken: () => Promise<string>;
  websocket?: unknown;
}

export class FakeCentrifuge extends Events {
  static instances: FakeCentrifuge[] = [];
  readonly subs: FakeSubscription[] = [];
  connectCalls = 0;
  disconnectCalls = 0;

  constructor(
    readonly endpoint: string,
    readonly options: FakeClientOptions,
  ) {
    super();
    FakeCentrifuge.instances.push(this);
  }

  static get last(): FakeCentrifuge {
    const last = FakeCentrifuge.instances.at(-1);
    if (!last) throw new Error("no Centrifuge client was created");
    return last;
  }

  get sub(): FakeSubscription {
    return this.subs[0]!;
  }

  newSubscription(channel: string, options: FakeSubscriptionOptions): FakeSubscription {
    const sub = new FakeSubscription(channel, options);
    this.subs.push(sub);
    return sub;
  }

  connect(): void {
    this.connectCalls += 1;
  }

  // The real client emits `disconnected` (code 0) on a local disconnect() too.
  disconnect(): void {
    this.disconnectCalls += 1;
    this.emit("disconnected", { code: 0, reason: "disconnect called" });
  }
}
