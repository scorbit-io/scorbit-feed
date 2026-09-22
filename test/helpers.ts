import type { FetchLike } from "../src/http.js";

export interface Call {
  key: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Result = Response | Error | ((init: RequestInit | undefined) => Response | Promise<Response>);

export const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function keyOf(method: string, url: string): string {
  if (url.includes("/connection/")) return "sse";
  if (url.endsWith("/heartbeat/")) return "heartbeat";
  if (method === "DELETE") return "delete";
  if (method === "POST") return "create";
  return `${method} ${url}`;
}

/** A fake `fetch` that answers from per-route queues and records every call. */
export function fakeApi() {
  const queues = new Map<string, Result[]>();
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const key = keyOf(method, url);
    calls.push({
      key,
      url,
      method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = queues.get(key)?.shift();
    if (next === undefined) throw new Error(`unexpected ${key} call`);
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(init);
    return next;
  };
  return {
    fetch,
    calls,
    count: (key: string) => calls.filter((call) => call.key === key).length,
    queue(key: string, ...results: Result[]) {
      queues.set(key, [...(queues.get(key) ?? []), ...results]);
    },
  };
}

/** A promise you resolve by hand, to hold a request in flight. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A hand-driven SSE response body. Aborting the request errors the stream, as fetch does. */
export function sseStream({ ignoreAbort = false } = {}) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let signal: AbortSignal | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const stream = {
    aborted: false,
    respond: (init: RequestInit | undefined, status = 200) => {
      signal = init?.signal ?? undefined;
      if (!ignoreAbort)
        signal?.addEventListener("abort", () => {
          stream.aborted = true;
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            // already closed
          }
        });
      return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
    },
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    pushBytes: (bytes: Uint8Array) => controller.enqueue(bytes),
    close: () => controller.close(),
    fail: (err: Error) => controller.error(err),
  };
  return stream;
}

/** Let pending promise callbacks run without advancing fake timers. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
