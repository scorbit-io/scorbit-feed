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
  FEED_ID,
  FEED_TOKEN,
  MACHINE_A,
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
  const exits: number[] = [];
  const signals = new EventEmitter();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  const deps: CliDeps = {
    env,
    log: (line) => lines.push(line),
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
  return { api, lines, exits, signals, exited, run, noSecrets };
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

  it("omits machines to stream everything in the key's scope (pending server support)", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue("create", json(201, CREATED_SSE));
    h.api.queue("sse", (init) => sseStream().respond(init));
    await h.run([...base, "--transport", "sse"]);
    expect(h.api.calls[0]!.body).toEqual({ transport: "sse" });
  });

  it("exits 1 when the API refuses the create", async () => {
    const h = harness({ SCORBIT_API_KEY: API_KEY });
    h.api.queue(
      "create",
      json(403, { detail: "One or more machines are not available to this account." }),
    );
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
    expect(overlay).toContain("Powered by Scorbit");
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
    h.api.queue("heartbeat", json(404, { detail: "Feed not found." }));
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

describe("scorbit-feed agent (attach mode)", () => {
  it("attaches with the env feed token, and on SIGTERM never deletes the feed", async () => {
    const h = harness({ SCORBIT_FEED_TOKEN: FEED_TOKEN });
    h.api.queue("heartbeat", json(200, heartbeatSse(2)));
    const stream = sseStream();
    h.api.queue("sse", (init) => stream.respond(init));
    await h.run([...base, "--feed-id", FEED_ID, "--endpoint", SSE_ENDPOINT, "--transport", "sse"]);
    await flush();
    expect(h.lines[0]).toBe(`attaching to feed ${FEED_ID}`);
    expect(h.api.calls.map((c) => c.key)).toEqual(["heartbeat", "sse"]);

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

  it("refuses a bad --endpoint or a plain-http --base-url before any request", async () => {
    const a = harness({ SCORBIT_FEED_TOKEN: FEED_TOKEN });
    await a.run([...base, "--feed-id", FEED_ID, "--endpoint", "ftp://x.test/"]);
    expect(a.exits).toEqual([1]);
    expect(a.lines[0]).toMatch(/endpoint must use https:/);
    const b = harness({ SCORBIT_API_KEY: API_KEY });
    await b.run(["--port", "0", "--base-url", "http://api.test.invalid"]);
    expect(b.exits).toEqual([1]);
    expect(b.lines[0]).toMatch(/baseUrl must use https:/);
    expect([...a.api.calls, ...b.api.calls]).toHaveLength(0);
  });
});
