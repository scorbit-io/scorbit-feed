import { realpath, stat } from "node:fs/promises";
import { parseArgs } from "node:util";

import { AgentServer, isLoopbackHost } from "./agent/server.js";
import { openFeed } from "./create.js";
import { type Feed, attachFeed } from "./feed.js";
import { type FetchLike, redact } from "./http.js";
import type { Transport } from "./types.js";

export const USAGE = `scorbit-feed: a local agent that holds a Scorbit data feed open and serves it to your overlay.

Create a feed (the agent deletes it again on exit):
  SCORBIT_API_KEY=sb_live_... scorbit-feed [--machines <uuid,uuid,...>]

Attach to an existing feed (never deleted on exit):
  SCORBIT_FEED_TOKEN=sbf_... scorbit-feed --feed-id <f_...> --endpoint <url>

Credentials are read from the environment only, never from arguments.

Options:
  --machines <uuid,...>    narrow the feed to these VenueMachine uuids, in order;
                           omit to stream everything in the key's scope
                           (scoped keys: planned server support)
  --feed-id <id>           attach to this feed instead of creating one
  --endpoint <url>         Centrifugo endpoint for an attached feed (the create
                           response's ws_endpoint or sse_endpoint); needed
                           because the heartbeat response does not include it yet
  --transport sdk|sse      default sdk
  --port <n>               default 8787
  --host <addr>            default 127.0.0.1
  --static <dir>           also serve overlay files from this directory
  --cors-origin <origin>   allow another browser origin (repeatable);
                           http://localhost / 127.0.0.1 on any port are allowed
  --allow-file-origin      let a page opened from file:// (Origin: null) read
                           /state and /events; off by default because sandboxed
                           iframes on any website also send Origin: null
  --base-url <url>         Scorbit API base URL, default https://api.scorbit.io
  -h, --help               show this help

Routes: GET /state (latest state per machine), GET /events (Server-Sent
Events: "status" and "state"), GET /healthz.

Tokens are refreshed on the interval the server sets for each feed, and the
feed stays alive for as long as the agent stays subscribed.`;

export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface CliDeps {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  exit: (code: number) => void;
  signals: SignalSource;
  fetch?: FetchLike;
}

export interface AgentHandle {
  feed: Feed;
  server: AgentServer;
  url: string;
  shutdown: () => Promise<void>;
}

class UsageError extends Error {}

function parse(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      machines: { type: "string" },
      "feed-id": { type: "string" },
      endpoint: { type: "string" },
      transport: { type: "string", default: "sdk" },
      port: { type: "string", default: "8787" },
      host: { type: "string", default: "127.0.0.1" },
      static: { type: "string" },
      "cors-origin": { type: "string", multiple: true, default: [] },
      "allow-file-origin": { type: "boolean", default: false },
      "base-url": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const transport = values.transport;
  if (transport !== "sdk" && transport !== "sse") {
    throw new UsageError("--transport must be sdk or sse");
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError("--port must be an integer from 0 to 65535");
  }
  const machines = (values.machines ?? "")
    .split(",")
    .map((uuid) => uuid.trim())
    .filter(Boolean);
  // An empty list must not silently widen the feed to the key's whole scope.
  if (values.machines !== undefined && machines.length === 0) {
    throw new UsageError("--machines is empty; omit it to stream everything in the key's scope");
  }
  return { ...values, transport: transport as Transport, port, machines };
}

async function staticRoot(dir: string): Promise<string> {
  try {
    const root = await realpath(dir);
    if ((await stat(root)).isDirectory()) return root;
  } catch {
    // Reported below.
  }
  throw new UsageError(`--static ${dir} is not a directory`);
}

/** Server- or user-supplied text in a log line: control characters (newlines, ANSI escapes) become "?". */
function clean(text: string): string {
  return Array.from(text, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "?" : c;
  }).join("");
}

const messageOf = (err: unknown) => clean((err as Error).message);

/** Run the agent. Resolves once it is serving, or `undefined` if it exited early. */
export async function main(argv: string[], deps: CliDeps): Promise<AgentHandle | undefined> {
  const log = (line: string) => deps.log(redact(line));

  let options: ReturnType<typeof parse>;
  let root: string | undefined;
  try {
    options = parse(argv);
    if (options.help) {
      log(USAGE);
      deps.exit(0);
      return undefined;
    }
    if (options.static !== undefined) root = await staticRoot(options.static);
  } catch (err) {
    log(`error: ${messageOf(err)}\n\n${USAGE}`);
    deps.exit(2);
    return undefined;
  }

  const apiKey = deps.env.SCORBIT_API_KEY;
  const feedToken = deps.env.SCORBIT_FEED_TOKEN;
  let feed: Feed | undefined;
  let created = false;
  // The server once it is listening: only then does finish() close it.
  const up: { server?: AgentServer } = {};

  // Every exit goes through finish(): once only, whoever calls first decides
  // the exit code, and it exits only after the feed is stopped (and deleted,
  // if this agent created it) and the server is closed.
  let cleaned: Promise<void> | undefined;
  const cleanup = (): Promise<void> =>
    (cleaned ??=
      feed?.stop({ deleteFeed: created }).catch((err: unknown) => {
        log(`could not delete feed: ${messageOf(err)}`);
      }) ?? Promise.resolve());
  let finishing: Promise<void> | undefined;
  let finishStarted = false;
  const finish = (code: number, line: string): Promise<void> => {
    // Set before the body runs: stopping the feed emits `ended` synchronously,
    // and that re-entrant call must not start a second finish.
    if (finishStarted) return finishing ?? Promise.resolve();
    finishStarted = true;
    finishing = (async () => {
      log(line);
      await cleanup();
      await up.server?.close();
      deps.exit(code);
    })();
    return finishing;
  };
  const stopLine = () => (created ? "stopping; deleting the feed this agent created" : "stopping");

  // Registered before anything is created, and kept for the agent's lifetime:
  // a signal during the create is recorded and acted on once the feed exists,
  // and a second signal cannot fall through to the default handler and kill
  // the process before the feed is deleted.
  let ready = false;
  let stopRequested = false;
  const onSignal = () => {
    stopRequested = true;
    if (ready) void finish(0, stopLine());
  };
  deps.signals.on("SIGINT", onSignal);
  deps.signals.on("SIGTERM", onSignal);

  try {
    if (options["feed-id"] !== undefined) {
      if (!feedToken) throw new UsageError("--feed-id needs SCORBIT_FEED_TOKEN in the environment");
      feed = attachFeed({
        feedId: options["feed-id"],
        feedToken,
        endpoint: options.endpoint,
        transport: options.transport,
        baseUrl: options["base-url"],
        fetch: deps.fetch,
      });
      log(`attaching to feed ${clean(options["feed-id"])}`);
    } else {
      if (!apiKey) {
        throw new UsageError(
          "set SCORBIT_API_KEY to create a feed, or pass --feed-id with SCORBIT_FEED_TOKEN",
        );
      }
      const opened = await openFeed({
        apiKey,
        machines: options.machines.length ? options.machines : undefined,
        transport: options.transport,
        baseUrl: options["base-url"],
        fetch: deps.fetch,
      });
      feed = opened.feed;
      // Set at once: anything that fails from here on must delete the feed.
      created = true;
      const names = opened.created.machines.map((m) => m.game_name).join(", ");
      log(`created feed ${clean(feed.feedId)} (${opened.created.transport}) over ${clean(names)}`);
    }
  } catch (err) {
    await finish(err instanceof UsageError ? 2 : 1, `error: ${messageOf(err)}`);
    return undefined;
  }
  if (stopRequested) {
    // A signal arrived while the feed was being created.
    await finish(0, stopLine());
    return undefined;
  }

  const agentFeed = feed;
  const agentServer = new AgentServer({
    host: options.host,
    port: options.port,
    staticDir: root,
    corsOrigins: options["cors-origin"],
    allowFileOrigin: options["allow-file-origin"],
  });

  agentFeed.on("update", (update) => agentServer.publishUpdate(update));
  agentFeed.on("status", (status) => {
    agentServer.publishStatus(status);
    log(`feed ${status}`);
  });
  agentFeed.on("machines", ({ added, removed }) => {
    if (added.length) log(`machines joined: ${clean(added.join(", "))}`);
    if (removed.length) log(`machines left: ${clean(removed.join(", "))}`);
  });
  agentFeed.on("error", (err) => log(`warning: ${messageOf(err)}`));
  // Also fires, synchronously, when finish() stops the feed: finish is once-only.
  agentFeed.on("ended", ({ reason }) => void finish(1, `feed ended: ${reason}`));

  let address;
  try {
    address = await agentServer.listen();
  } catch (err) {
    await finish(
      1,
      `error: cannot listen on ${clean(options.host)}:${options.port}: ${messageOf(err)}`,
    );
    return undefined;
  }
  up.server = agentServer;
  const url = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  if (!isLoopbackHost(options.host)) {
    log(
      `warning: listening on ${options.host}, so other machines on the network can read this feed`,
    );
  }
  log(`serving on ${url} (GET /state, /events, /healthz${root ? ", and static files" : ""})`);

  ready = true;
  if (stopRequested) {
    // A signal arrived while the server was starting.
    await finish(0, stopLine());
    return undefined;
  }
  agentFeed.start();
  return { feed: agentFeed, server: agentServer, url, shutdown: () => finish(0, stopLine()) };
}
