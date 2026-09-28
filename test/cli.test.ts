import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type AgentHandle, type CliDeps, USAGE, main } from "../src/cli.js";
import { FakeCentrifuge } from "./fake-centrifuge.js";
import {
  API_KEY,
  BASE_URL,
  CREATED_SDK,
  CREATED_SSE,
  ERRORS,
  FEED_ID,
  FEED_TOKEN,
  MACHINE_A,
  SCOPE_VENUES,
  SSE_ENDPOINT,
  heartbeatSse,
} from "./fixtures/api.js";
import { CONNECT_FRAME, DISCONNECT_FRAME, UPDATE, pubFrame } from "./fixtures/messages.js";
import { fakeApi, flush, json, sseStream } from "./helpers.js";

vi.mock("centrifuge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("centrifuge")>();
  const { FakeCentrifuge } = await import("./fake-centrifuge.js");
  return { ...actual, Centrifuge: FakeCentrifuge };
});

const TEMPLATES = fileURLToPath(new URL("../templates/overlay", import.meta.url));
const SECRETS = [
  API_KEY,
  FEED_TOKEN,
  CREATED_SSE.connection_token,
  CREATED_SDK.connection_token,
  CREATED_SDK.subscription_token!,
];

const handles: AgentHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.shutdown()));
});

function harness(env: Record<string, string | undefined> = {}, extra: Partial<CliDeps> = {}) {
  const api = fakeApi();
  const lines: string[] = [];
  const output: string[] = [];
  const exits: number[] = [];
  const signals = new EventEmitter();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  const deps: CliDeps = {
    env,
    log: (line) => lines.push(line),
    out: (text) => output.push(text),
    exit: (code) => {
      exits.push(code);
      resolveExit(code);
    },
    signals,
    fetch: api.fetch,
    ...extra,
  };
  const run = async (argv: string[]) => {
    const handle = await main(argv, deps);
    if (handle) handles.push(handle);
    return handle;
  };
  const noSecrets = () => {
    const text = lines.join("\n");
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  };
  return { api, lines, output, exits, signals, exited, run, noSecrets };
}

const base = ["--port", "0", "--base-url", BASE_URL];

describe("scorbit-feed argument handling", () => {
  it("prints usage for --help", async () => {
    const h = harness();
    expect(await h.run(["--help"])).toBeUndefined();
    expect(h.lines).toEqual([USAGE]);
    expect(h.exits).toEqual([0]);
  });

  it("describes the refresh interval without a frozen number", () => {
    expect(USAGE).toMatch(/interval the server sets/);
    expect(USAGE).not.toMatch(/\b(600|720|480|900)\b/);
  });

  it.each([
    [["--api-key", API_KEY], /Unknown option '--api-key'/],
    [["--transport", "grpc"], /--transport must be sdk or sse/],
    [["--port", "70000"], /--port must be an integer/],
    [["--port", "abc"], /--port must be an integer/],
    [["--static", "/definitely/not/here"], /is not a directory/],
    [["--static", fileURLToPath(import.meta.url)], /is not a directory/],
    [["stray"], /Unexpected argument/],
    [["--machines", " , "], /--machines is empty/],
  ])("exits 2 for %j", async (argv, message) => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    expect(await h.run(argv)).toBeUndefined();
    expect(h.exits).toEqual([2]);
    expect(h.lines[0]).toMatch(message);
    h.noSecrets();
  });

  it.each([
    [{}, [], /set SCORBIT_API_KEY/],
    [{ SCORBIT_API_KEY: API_KEY }, ["--feed-id", FEED_ID], /needs SCORBIT_FEED_TOKEN/],
  ])("exits 2 without the credentials it needs (%j %j)", async (env, argv, message) => {
    const h = harness(env);
    await h.run([...base, ...argv]);
    expect(h.exits).toEqual([2]);
    expect(h.lines[0]).toMatch(message);
    expect(h.api.calls).toHaveLength(0);
  });

  it("exits 1 when the feed token is not an sbf_ token, before any request", async () => {
    const h = harness({ SCORBIT_FEED_TOKEN: API_KEY });
    await h.run([...base, "--feed-id", FEED_ID]);
    expect(h.exits).toEqual([1]);
    expect(h.lines[0]).toMatch(/sb_live_ API key/);
    expect(h.api.calls).toHaveLength(0);
    h.noSecrets();
  });

  it("omits machines to stream everything in the key's scope", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(201, CREATED_SSE));
    h.api.queue("sse", (init) => sseStream().respond(init));
    await h.run([...base, "--transport", "sse"]);
    expect(h.api.calls[0]!.body).toEqual({ transport: "sse" });
  });

  it("exits 1 when the API refuses the create", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(403, ERRORS.machinesUnavailable));
    await h.run([...base, "--machines", MACHINE_A]);
    expect(h.exits).toEqual([1]);
    expect(h.lines[0]).toMatch(/403: One or more machines/);
    h.noSecrets();
  });
});

describe("scorbit-feed agent (create mode)", () => {
  async function running(extraArgs: string[] = []) {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(201, CREATED_SSE));
    const stream = sseStream();
    h.api.queue("sse", (init) => stream.respond(init));
    const handle = (await h.run([
      ...base,
      "--machines",
      `${MACHINE_A}, `,
      "--transport",
      "sse",
      ...extraArgs,
    ]))!;
    await flush();
    return { h, stream, handle };
  }

  it("creates the feed from the environment key, serves it, and never exposes a token", async () => {
    const { h, stream, handle } = await running(["--static", TEMPLATES]);
    expect(h.api.calls[0]!.body).toEqual({ machines: [MACHINE_A], transport: "sse" });
    expect(h.lines).toContain(`created feed ${FEED_ID} (sse) over Monster Bash`);
    expect(
      h.lines.some((l) => l.startsWith(`serving on ${handle.url}`) && l.includes("static files")),
    ).toBe(true);

    stream.push(CONNECT_FRAME + pubFrame(UPDATE));
    await flush();
    expect(h.lines).toContain("feed live");

    const state = await (await fetch(`${handle.url}/state`)).text();
    expect(JSON.parse(state)).toMatchObject({ status: "live", machines: UPDATE.payload.machines });
    const health = await (await fetch(`${handle.url}/healthz`)).text();
    const overlay = await (await fetch(`${handle.url}/`)).text();
    expect(overlay).toContain('alt="Powered by Scorbit"');
    const logo = await fetch(`${handle.url}/scorbit_lockup-horizontal_multi.svg`);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(await logo.text()).toContain("<svg");
    for (const body of [state, health, overlay]) {
      for (const secret of SECRETS) expect(body).not.toContain(secret);
    }
    h.noSecrets();
  });

  it("on SIGINT stops, deletes the feed it created, closes the server and exits 0", async () => {
    const { h, handle } = await running();
    h.api.queue("delete", new Response(null, { status: 204 }));
    h.signals.emit("SIGINT");
    expect(await h.exited).toBe(0);
    const del = h.api.calls.find((c) => c.key === "delete")!;
    expect(del.url).toBe(`${BASE_URL}/api/v2/data-feeds/${FEED_ID}/`);
    expect(del.headers.Authorization).toBe(`Bearer ${FEED_TOKEN}`);
    expect(h.lines).toContain("stopping; deleting the feed this agent created");
    await expect(fetch(`${handle.url}/healthz`)).rejects.toThrow();
    // A second signal or shutdown is the same shutdown.
    await handle.shutdown();
    expect(h.api.count("delete")).toBe(1);
    h.noSecrets();
  });

  it("logs, and still exits, when deleting the feed fails", async () => {
    const { h } = await running();
    h.api.queue("delete", json(500));
    h.signals.emit("SIGTERM");
    expect(await h.exited).toBe(0);
    expect(h.lines).toContain("could not delete feed: Scorbit API answered 500");
  });

  it("exits 1 when the server ends the feed", async () => {
    const { h, stream } = await running();
    h.api.queue("heartbeat", json(404, ERRORS.notFound));
    stream.push(DISCONNECT_FRAME);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await h.exited).toBe(1);
    expect(h.lines).toContain("feed ended: ended");
    expect(h.api.count("delete")).toBe(0);
  });

  it("logs machines joining and leaving a live feed, and /state drops the leavers", async () => {
    const { h, stream, handle } = await running();
    const [a, b] = UPDATE.payload.machines;
    stream.push(pubFrame({ ...UPDATE, payload: { machines: [a, b] } }));
    await flush();
    expect(h.lines).toContain(`machines joined: ${b!.machine_uuid}`);
    stream.push(pubFrame({ ...UPDATE, payload: { machines: [b] } }));
    await flush();
    expect(h.lines).toContain(`machines left: ${a!.machine_uuid}`);
    const state = await (await fetch(`${handle.url}/state`)).json();
    expect(state.machines.map((m: { machine_uuid: string }) => m.machine_uuid)).toEqual([
      b!.machine_uuid,
    ]);
  });

  it("streams machine-set changes over /events, down to an empty feed", async () => {
    const { stream, handle } = await running();
    const [a] = UPDATE.payload.machines;
    const events = await fetch(`${handle.url}/events`);
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        text += decoder.decode(value);
      }
    };
    await until("event: state");
    stream.push(pubFrame({ ...UPDATE, payload: { machines: [] } }));
    await until("event: machines");
    await until('"machines":[]}\n\n');
    const frame = `event: machines\ndata: ${JSON.stringify({ added: [], removed: [a!.machine_uuid], machines: [] })}`;
    expect(text).toContain(frame);
    await reader.cancel();
    expect((await (await fetch(`${handle.url}/state`)).json()).machines).toEqual([]);
  });

  it("says so when a following feed starts with no machines", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(201, { ...CREATED_SSE, machines: [] }));
    h.api.queue("sse", (init) => sseStream().respond(init));
    await h.run([...base, "--transport", "sse"]);
    expect(h.api.calls[0]!.body).toEqual({ transport: "sse" });
    expect(h.lines).toContain(`created feed ${FEED_ID} (sse) over no machines yet`);
  });

  it("logs transport warnings without tokens", async () => {
    const { h, stream } = await running();
    stream.fail(new Error(`boom ${CREATED_SSE.connection_token}`));
    await flush();
    expect(
      h.lines.some((l) => l.startsWith("warning: SSE connection failed: boom [redacted]")),
    ).toBe(true);
    h.noSecrets();
  });

  it("warns when listening beyond loopback", async () => {
    const { h, handle } = await running(["--host", "0.0.0.0"]);
    expect(h.lines).toContain(
      "warning: listening on 0.0.0.0, so other machines on the network can read this feed",
    );
    expect(handle.url).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/);
  });

  it("brackets an IPv6 address in the URL", async () => {
    const { handle } = await running(["--host", "::1"]);
    expect(handle.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
  });

  it("exits 1, deleting the feed it just made, when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = String((blocker.address() as { port: number }).port);
    try {
      const h = harness({ SCORBIT_API_KEY: API_KEY });
      h.api.queue("create", json(201, CREATED_SSE));
      // Even a failed delete must not stop the agent from exiting.
      h.api.queue("delete", json(500));
      await h.run(["--base-url", BASE_URL, "--port", port, "--machines", MACHINE_A]);
      expect(h.exits).toEqual([1]);
      expect(h.lines.some((l) => /cannot listen on 127.0.0.1:\d+: .*EADDRINUSE/.test(l))).toBe(
        true,
      );
      expect(h.lines).not.toContain("feed ended: stopped");
      expect(h.api.count("delete")).toBe(1);
    } finally {
      blocker.close();
    }
  });
});

describe("scorbit-feed agent cleanup", () => {
  it("deletes, with the key, a feed whose create response it cannot use, and exits 1", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue(
      "create",
      json(201, { ...CREATED_SSE, sse_endpoint: "http://centrifugo.example/uni_sse" }),
    );
    h.api.queue("delete", new Response(null, { status: 204 }));
    await h.run([...base, "--transport", "sse"]);
    expect(await h.exited).toBe(1);
    expect(h.lines[0]).toBe("error: malformed create response: bad sse_endpoint");
    const del = h.api.calls.find((c) => c.key === "delete")!;
    expect(del.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(h.api.count("delete")).toBe(1);
    h.noSecrets();
  });

  it("deletes a feed it created that the agent ends locally, once, then exits 1", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(201, CREATED_SSE));
    h.api.queue("delete", new Response(null, { status: 204 }));
    // The transport cannot even be opened: the feed ends locally with reason "stopped".
    h.api.queue("sse", () => {
      throw new Error("unreachable");
    });
    const { Feed } = await import("../src/feed.js");
    const target = Feed.prototype as unknown as { createTransport: () => unknown };
    const spy = vi.spyOn(target, "createTransport").mockImplementationOnce(() => {
      throw new Error("no transport");
    });
    await h.run([...base, "--transport", "sse"]);
    expect(await h.exited).toBe(1);
    expect(h.lines).toContain("feed ended: stopped");
    expect(h.api.count("delete")).toBe(1);
    h.signals.emit("SIGINT");
    await flush();
    expect(h.api.count("delete")).toBe(1);
    spy.mockRestore();
    h.noSecrets();
  });

  it.each([
    ["succeeds", 204],
    ["fails", 500],
  ])(
    "deletes the feed it just created if anything fails before the agent starts (delete %s)",
    async (_label, deleteStatus) => {
      const h = harness({ SCORBIT_API_KEY: API_KEY });
      const deps = h as unknown as { lines: string[] };
      h.api.queue("create", json(201, CREATED_SSE));
      h.api.queue(
        "delete",
        deleteStatus === 204 ? new Response(null, { status: 204 }) : json(deleteStatus),
      );
      // A log sink that fails on the "created feed" line.
      const original = deps.lines.push.bind(deps.lines);
      deps.lines.push = (...items: string[]) => {
        if (items.some((line) => line.startsWith("created feed"))) throw new Error("log sink down");
        return original(...items);
      };
      await h.run([...base, "--transport", "sse"]);
      expect(h.exits).toEqual([1]);
      expect(h.lines).toContain("error: log sink down");
      const del = h.api.calls.find((c) => c.key === "delete")!;
      expect(del.headers.Authorization).toBe(`Bearer ${FEED_TOKEN}`);
      expect(h.api.count("sse")).toBe(0);
      h.noSecrets();
    },
  );

  it("does not warn about the network for an upper-case loopback host", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(201, CREATED_SSE));
    h.api.queue("sse", (init) => sseStream().respond(init));
    await h.run([...base, "--host", "LOCALHOST", "--transport", "sse"]);
    expect(h.lines.some((l) => l.includes("other machines on the network"))).toBe(false);
  });
});

describe("scorbit-feed machines", () => {
  const MACHINES_URL = `${BASE_URL}/api/v2/data-feeds/machines/`;

  it("writes what the key covers to stdout as plain JSON, and exits 0", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue(`GET ${MACHINES_URL}`, json(200, SCOPE_VENUES));
    expect(await h.run(["machines", "--base-url", BASE_URL])).toBeUndefined();
    expect(h.exits).toEqual([0]);
    expect(h.output).toEqual([JSON.stringify(SCOPE_VENUES, null, 2)]);
    expect(JSON.parse(h.output[0]!)).toEqual(SCOPE_VENUES);
    expect(h.lines).toEqual([]);
    expect(h.api.calls.map((c) => [c.method, c.url])).toEqual([["GET", MACHINES_URL]]);
    h.noSecrets();
  });

  it("escapes control characters in server text", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    const machine = { ...SCOPE_VENUES.machines[0]!, game_name: "Evil\u001b[2J\nX" };
    h.api.queue(`GET ${MACHINES_URL}`, json(200, { ...SCOPE_VENUES, machines: [machine] }));
    await h.run(["machines", "--base-url", BASE_URL]);
    expect(h.output[0]).toContain('"game_name": "Evil\\u001b[2J\\nX"');
    // eslint-disable-next-line no-control-regex
    expect(h.output[0]).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
  });

  it("prints server text as it is, even text shaped like a token", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    const name = "Pinball.Wizard2000.Deluxe-Ed";
    const machine = { ...SCOPE_VENUES.machines[0]!, game_name: name };
    h.api.queue(`GET ${MACHINES_URL}`, json(200, { ...SCOPE_VENUES, machines: [machine] }));
    await h.run(["machines", "--base-url", BASE_URL]);
    expect(JSON.parse(h.output[0]!).machines[0].game_name).toBe(name);
  });

  it("prints usage for --help", async () => {
    const h = harness();
    await h.run(["machines", "--help"]);
    expect(h.exits).toEqual([0]);
    expect(h.lines).toEqual([USAGE]);
  });

  it.each([
    [{}, [], /set SCORBIT_API_KEY to list its machines/],
    [{ SCORBIT_API_KEY: API_KEY }, ["--machines", MACHINE_A], /Unknown option '--machines'/],
    [{ SCORBIT_API_KEY: API_KEY }, ["extra"], /Unexpected argument/],
  ])("exits 2 on a usage error (%j %j)", async (env, argv, message) => {
    const h = harness(env);
    await h.run(["machines", ...argv]);
    expect(h.exits).toEqual([2]);
    expect(h.lines[0]).toMatch(message);
    expect(h.output).toEqual([]);
    expect(h.api.calls).toHaveLength(0);
  });

  it.each([
    ["a refusal", json(403, ERRORS.suspended), /Scorbit API answered 403: Data-feed access/],
    ["a feed token", undefined, /listMachines needs an sb_live_ API key/],
  ])("exits 1 on %s, without the credential", async (_label, answer, message) => {
    const h = harness({ SCORBIT_API_KEY: answer ? API_KEY : FEED_TOKEN });
    if (answer) h.api.queue(`GET ${MACHINES_URL}`, answer);
    await h.run(["machines", "--base-url", BASE_URL]);
    expect(h.exits).toEqual([1]);
    expect(h.lines[0]).toMatch(message);
    h.noSecrets();
  });
});

describe("scorbit-feed agent (attach mode)", () => {
  it("attaches with the env feed token, and on SIGTERM never deletes the feed", async () => {
    const h = harness({ SCORBIT_FEED_TOKEN: FEED_TOKEN });
    h.api.queue("heartbeat", json(200, heartbeatSse(2)));
    const stream = sseStream();
    h.api.queue("sse", (init) => stream.respond(init));
    await h.run([...base, "--feed-id", FEED_ID, "--transport", "sse"]);
    await flush();
    expect(h.lines[0]).toBe(`attaching to feed ${FEED_ID}`);
    // The first heartbeat supplies the endpoint.
    expect(h.api.calls.map((c) => [c.key, c.url])).toEqual([
      ["heartbeat", `${BASE_URL}/api/v2/data-feeds/${FEED_ID}/heartbeat/`],
      ["sse", SSE_ENDPOINT],
    ]);

    h.signals.emit("SIGTERM");
    expect(await h.exited).toBe(0);
    expect(h.api.count("delete")).toBe(0);
    expect(h.lines).toContain("stopping");
    h.noSecrets();
  });

  it("leaves the sdk transport on the runtime's global WebSocket", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(201, CREATED_SDK));
    await h.run([...base, "--machines", MACHINE_A]);
    expect("websocket" in FakeCentrifuge.last.options).toBe(false);
    expect(typeof WebSocket).toBe("function");
  });

  it("no longer takes --endpoint: every heartbeat carries it", async () => {
    const a = harness({ SCORBIT_FEED_TOKEN: FEED_TOKEN });
    await a.run([...base, "--feed-id", FEED_ID, "--endpoint", SSE_ENDPOINT]);
    expect(a.exits).toEqual([2]);
    expect(a.lines[0]).toMatch(/Unknown option '--endpoint'/);
    expect(a.api.calls).toHaveLength(0);
  });

  it("refuses a plain-http --base-url before any request", async () => {
    const b = harness({ SCORBIT_API_KEY: API_KEY });
    await b.run(["--port", "0", "--base-url", "http://api.test.invalid"]);
    expect(b.exits).toEqual([1]);
    expect(b.lines[0]).toMatch(/baseUrl must use https:/);
    expect(b.api.calls).toHaveLength(0);
  });
});

describe("scorbit-feed signals and log hygiene", () => {
  it("deletes the feed when a signal arrives while it is being created", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    let answer!: (response: Response) => void;
    h.api.queue("create", () => new Promise<Response>((resolve) => (answer = resolve)));
    h.api.queue("delete", new Response(null, { status: 204 }));
    const running = h.run([...base, "--transport", "sse"]);
    await flush();
    h.signals.emit("SIGINT");
    answer(json(201, CREATED_SSE));
    expect(await running).toBeUndefined();
    expect(h.exits).toEqual([0]);
    const del = h.api.calls.find((c) => c.key === "delete")!;
    expect(del.headers.Authorization).toBe(`Bearer ${FEED_TOKEN}`);
    // It never started serving or connecting.
    expect(h.api.count("sse")).toBe(0);
    expect(h.lines.some((l) => l.startsWith("serving on"))).toBe(false);
    h.noSecrets();
  });

  it("stops retrying the create on a signal, and exits without a feed to delete", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness({ SCORBIT_API_KEY: API_KEY });
      h.api.queue("create", json(503, ERRORS.switchedOff), json(201, CREATED_SSE));
      const running = h.run([...base, "--transport", "sse"]);
      await vi.advanceTimersByTimeAsync(10);
      expect(h.api.count("create")).toBe(1);
      h.signals.emit("SIGINT");
      expect(await running).toBeUndefined();
      expect(h.exits).toEqual([0]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.api.count("create")).toBe(1);
      expect(h.api.count("delete")).toBe(0);
      expect(h.lines).toEqual(["stopping"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exits on a second signal while the delete is being retried, saying the feed may linger", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(201, CREATED_SSE));
    h.api.queue("sse", (init) => sseStream().respond(init));
    await h.run([...base, "--transport", "sse"]);
    h.api.queue("delete", json(503, ERRORS.deleteUnavailable), json(503), json(503), json(503));
    h.signals.emit("SIGTERM");
    await flush();
    expect(h.api.count("delete")).toBe(1);
    h.signals.emit("SIGINT");
    expect(await h.exited).toBe(0);
    expect(h.api.count("delete")).toBe(1);
    expect(h.lines).toContain(
      "exiting without waiting for the delete; the feed may linger until its TTL",
    );
    expect(h.lines).toContain("could not delete feed: aborted");
  });

  it("logs, and still exits, when that delete fails", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    let answer!: (response: Response) => void;
    h.api.queue("create", () => new Promise<Response>((resolve) => (answer = resolve)));
    h.api.queue("delete", json(500));
    const running = h.run([...base, "--transport", "sse"]);
    await flush();
    h.signals.emit("SIGTERM");
    answer(json(201, CREATED_SSE));
    await running;
    expect(h.exits).toEqual([0]);
    expect(h.lines).toContain("could not delete feed: Scorbit API answered 500");
  });

  it("shuts down, without deleting an attached feed, on a signal while the server starts", async () => {
    const h = harness({ SCORBIT_FEED_TOKEN: FEED_TOKEN });
    const running = h.run([...base, "--feed-id", FEED_ID]);
    h.signals.emit("SIGINT");
    expect(await running).toBeUndefined();
    expect(h.exits).toEqual([0]);
    expect(h.api.calls).toHaveLength(0);
  });

  it("strips control characters from server-supplied text in log lines", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue(
      "create",
      json(201, {
        ...CREATED_SSE,
        machines: [{ uuid: MACHINE_A, game_name: "Evil\u001b[2J\nFAKE: all clear\u0007\u007f" }],
      }),
    );
    h.api.queue("sse", (init) => sseStream().respond(init));
    await h.run([...base, "--transport", "sse"]);
    const line = h.lines.find((l) => l.startsWith("created feed"))!;
    expect(line).toBe(`created feed ${FEED_ID} (sse) over Evil?[2J?FAKE: all clear??`);
    const controls = (l: string) =>
      [...l].some((c) => c.charCodeAt(0) === 0x7f || (c.charCodeAt(0) < 0x20 && c !== "\n"));
    expect(h.lines.some(controls)).toBe(false);
  });

  it("strips control characters from server error details", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(403, { detail: "no\r\n\u001b[31mred" }));
    await h.run([...base]);
    expect(h.lines[0]).toBe("error: Scorbit API answered 403: no???[31mred");
  });
});

describe("scorbit-feed shutdown races", () => {
  async function serving(extraArgs: string[] = []) {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(201, CREATED_SSE));
    const stream = sseStream();
    h.api.queue("sse", (init) => stream.respond(init));
    const handle = (await h.run([...base, "--transport", "sse", ...extraArgs]))!;
    await flush();
    return { h, stream, handle };
  }
  const held = () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => (release = resolve));
    return { response, release };
  };

  it("a second signal during the DELETE neither deletes twice nor exits before it settles", async () => {
    const { h, handle } = await serving();
    const del = held();
    h.api.queue("delete", () => del.response);
    h.signals.emit("SIGINT");
    await flush();
    h.signals.emit("SIGINT");
    h.signals.emit("SIGTERM");
    await flush();
    expect(h.exits).toEqual([]);
    del.release(new Response(null, { status: 204 }));
    expect(await h.exited).toBe(0);
    await flush();
    expect(h.exits).toEqual([0]);
    expect(h.api.count("delete")).toBe(1);
    await expect(fetch(`${handle.url}/healthz`)).rejects.toThrow();
  });

  it("keeps listening for signals, so a second one cannot fall through and kill the process", async () => {
    const { h } = await serving();
    h.api.queue("delete", new Response(null, { status: 204 }));
    h.signals.emit("SIGINT");
    expect(h.signals.listenerCount("SIGINT")).toBeGreaterThan(0);
    expect(h.signals.listenerCount("SIGTERM")).toBeGreaterThan(0);
    await h.exited;
  });

  it("a signal after the server ended the feed keeps exit code 1, and exits once", async () => {
    const { h, stream } = await serving();
    h.api.queue("heartbeat", json(404, ERRORS.notFound));
    stream.push(DISCONNECT_FRAME);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    h.signals.emit("SIGINT");
    expect(await h.exited).toBe(1);
    await flush();
    expect(h.exits).toEqual([1]);
    expect(h.api.count("delete")).toBe(0);
    expect(h.lines).not.toContain("stopping; deleting the feed this agent created");
  });

  it("a signal during a feed-ended cleanup keeps its code, and the DELETE is awaited", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(201, CREATED_SSE));
    const del = held();
    h.api.queue("delete", () => del.response);
    // The transport cannot be opened, so the feed ends locally: cleanup must delete it.
    const { Feed } = await import("../src/feed.js");
    const target = Feed.prototype as unknown as { createTransport: () => unknown };
    const spy = vi.spyOn(target, "createTransport").mockImplementationOnce(() => {
      throw new Error("no transport");
    });
    await h.run([...base, "--transport", "sse"]);
    await flush();
    h.signals.emit("SIGINT");
    await flush();
    expect(h.exits).toEqual([]);
    del.release(new Response(null, { status: 204 }));
    expect(await h.exited).toBe(1);
    await flush();
    expect(h.exits).toEqual([1]);
    expect(h.api.count("delete")).toBe(1);
    spy.mockRestore();
  });

  it("a signal during create, then a second one, deletes once and exits once", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    const create = held();
    h.api.queue("create", () => create.response);
    const del = held();
    h.api.queue("delete", () => del.response);
    const running = h.run([...base, "--transport", "sse"]);
    await flush();
    h.signals.emit("SIGINT");
    h.signals.emit("SIGINT");
    create.release(json(201, CREATED_SSE));
    await flush();
    h.signals.emit("SIGTERM");
    expect(h.exits).toEqual([]);
    del.release(new Response(null, { status: 204 }));
    expect(await running).toBeUndefined();
    expect(h.exits).toEqual([0]);
    expect(h.api.count("delete")).toBe(1);
  });

  it("a signal while the port is found taken exits 1 once, after the DELETE", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = String((blocker.address() as { port: number }).port);
    try {
      const h = harness({ SCORBIT_API_KEY: API_KEY });
      h.api.queue("create", json(201, CREATED_SSE));
      const del = held();
      h.api.queue("delete", () => del.response);
      const running = h.run(["--base-url", BASE_URL, "--port", port, "--transport", "sse"]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      h.signals.emit("SIGINT");
      expect(h.exits).toEqual([]);
      del.release(new Response(null, { status: 204 }));
      await running;
      expect(h.exits).toEqual([1]);
      expect(h.api.count("delete")).toBe(1);
    } finally {
      blocker.close();
    }
  });

  it("the handle's shutdown and a signal together finish once", async () => {
    const { h, handle } = await serving();
    h.api.queue("delete", new Response(null, { status: 204 }));
    const first = handle.shutdown();
    h.signals.emit("SIGTERM");
    await first;
    await handle.shutdown();
    expect(h.exits).toEqual([0]);
    expect(h.api.count("delete")).toBe(1);
  });
});

describe("scorbit-feed exits last", () => {
  it("exits only after the server has closed", async () => {
    const order: string[] = [];
    let done!: () => void;
    const exited = new Promise<void>((resolve) => (done = resolve));
    const h = harness(
      { SCORBIT_API_KEY: API_KEY },
      {
        exit: (code) => {
          order.push(`exit ${code}`);
          done();
        },
      },
    );
    h.api.queue("create", json(201, CREATED_SSE));
    h.api.queue("sse", (init) => sseStream().respond(init));
    h.api.queue("delete", new Response(null, { status: 204 }));
    const handle = (await h.run([...base, "--transport", "sse"]))!;
    handle.server.server.on("close", () => order.push("server closed"));
    h.signals.emit("SIGINT");
    await exited;
    expect(order).toEqual(["server closed", "exit 0"]);
  });
});
