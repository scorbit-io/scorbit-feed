import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ServerResponse } from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AgentServer, isAllowedOrigin, isLoopbackHost } from "../src/agent/server.js";
import { UPDATE } from "./fixtures/messages.js";

let tmp: string;
let root: string;

beforeAll(async () => {
  // The agent resolves --static with realpath; so must the test (macOS /var is a symlink).
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), "scorbit-feed-")));
  root = path.join(tmp, "overlay");
  await mkdir(path.join(root, "sub"), { recursive: true });
  await mkdir(path.join(root, "empty"));
  await mkdir(path.join(root, "trap", "index.html"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "<h1>overlay</h1>");
  await writeFile(path.join(root, "style.css"), "body{}");
  await writeFile(path.join(root, "blob.bin"), "xx");
  await writeFile(path.join(root, ".env"), "SCORBIT_API_KEY=sb_live_TESTKEY_dotfile");
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "config.json"), "{}");
  await symlink(path.join(root, ".env"), path.join(root, "innocent.js"));
  await writeFile(path.join(root, "locked.html"), "<p>locked</p>");
  await chmod(path.join(root, "locked.html"), 0o000);
  await writeFile(path.join(root, "big.js"), "x".repeat(8 * 1024 * 1024));
  await writeFile(path.join(root, "sub", "index.html"), "<p>sub</p>");
  await writeFile(path.join(tmp, "secret.txt"), "top secret");
  await symlink(path.join(tmp, "secret.txt"), path.join(root, "escape.txt"));
  await symlink(path.join(root, "style.css"), path.join(root, "alias.css"));
});

afterAll(async () => {
  await chmod(path.join(root, "locked.html"), 0o644);
  await rm(tmp, { recursive: true, force: true });
});

const servers: AgentServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(options: Partial<ConstructorParameters<typeof AgentServer>[0]> = {}) {
  const server = new AgentServer({ host: "127.0.0.1", port: 0, ...options });
  servers.push(server);
  const address = await server.listen();
  return { server, port: address.port, base: `http://127.0.0.1:${address.port}` };
}

/** A raw request, so the path reaches the server exactly as written (fetch would normalise it). */
function raw(port: number, rawPath: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: rawPath, method, headers },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

/** Read an SSE response until `count` events have arrived. */
async function readEvents(response: Response, count: number) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const events: { event: string; data: unknown }[] = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = text.indexOf("\n\n")) >= 0) {
      const block = text.slice(0, end);
      text = text.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)![1]!;
      const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]!);
      events.push({ event, data });
    }
  }
  return { events, reader };
}

describe("isAllowedOrigin", () => {
  it.each([
    ["null", false],
    ["http://localhost", true],
    ["http://localhost:3000", true],
    ["http://127.0.0.1:5173", true],
    ["http://[::1]:8080", true],
    ["https://localhost:3000", false],
    ["http://localhost.evil.example", false],
    ["http://127.0.0.1.evil.example", false],
    ["https://evil.example", false],
  ])("%s -> %s", (origin, allowed) => {
    expect(isAllowedOrigin(origin)).toBe(allowed);
  });

  it("allows configured origins", () => {
    expect(isAllowedOrigin("https://obs.example", ["https://obs.example"])).toBe(true);
  });
});

describe("AgentServer routes", () => {
  it("serves state, health and a 404 for anything else", async () => {
    const { server, base } = await start();
    expect(await (await fetch(`${base}/state`)).json()).toEqual({
      status: "idle",
      updated_at: null,
      machines: [],
    });

    server.publishStatus("live");
    server.publishUpdate(UPDATE);
    const state = await (await fetch(`${base}/state`)).json();
    expect(state).toEqual({
      status: "live",
      updated_at: UPDATE.metadata.updated_at,
      machines: UPDATE.payload.machines,
    });

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, status: "live" });
    server.publishStatus("ended");
    expect((await fetch(`${base}/healthz`)).status).toBe(503);

    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("drops machines that leave a live feed from /state", async () => {
    const { server, base } = await start();
    const [a, b] = UPDATE.payload.machines;
    server.publishUpdate({ ...UPDATE, payload: { machines: [a!, b!] } });
    server.publishUpdate({ ...UPDATE, payload: { machines: [b!] } });
    const state = await (await fetch(`${base}/state`)).json();
    expect(state.machines).toEqual([b]);
  });

  it("tolerates an update without metadata", async () => {
    const { server, base } = await start();
    server.publishUpdate({ ...UPDATE, metadata: undefined as never });
    expect((await (await fetch(`${base}/state`)).json()).updated_at).toBeNull();
  });

  it("streams status and state over /events, then updates as they arrive", async () => {
    const { server, base } = await start();
    server.publishStatus("live");
    const response = await fetch(`${base}/events`);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const first = await readEvents(response, 2);
    expect(first.events).toEqual([
      { event: "status", data: { status: "live" } },
      { event: "state", data: { status: "live", updated_at: null, machines: [] } },
    ]);
    first.reader.releaseLock();

    server.publishUpdate(UPDATE);
    server.publishStatus("reconnecting");
    const next = await readEvents(response, 2);
    expect(next.events[0]).toEqual({
      event: "state",
      data: {
        status: "live",
        updated_at: UPDATE.metadata.updated_at,
        machines: UPDATE.payload.machines,
      },
    });
    expect(next.events[1]).toEqual({ event: "status", data: { status: "reconnecting" } });
    await next.reader.cancel();
  });

  it("forgets an events client that disconnects, and ends the rest on close", async () => {
    const { server, base } = await start();
    const gone = await fetch(`${base}/events`);
    await (await readEvents(gone, 2)).reader.cancel();
    const staying = await fetch(`${base}/events`);
    const { reader } = await readEvents(staying, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.publishStatus("live");
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain('"status":"live"');
  });

  it("rejects a port already in use", async () => {
    const { port } = await start();
    const second = new AgentServer({ host: "127.0.0.1", port });
    await expect(second.listen()).rejects.toThrow(/EADDRINUSE/);
  });
});

describe("AgentServer CORS", () => {
  it("answers without CORS headers when there is no Origin", async () => {
    const { port } = await start();
    const res = await raw(port, "/state");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:5173", "https://obs.example"])(
    "allows %s",
    async (origin) => {
      const { port } = await start({ corsOrigins: ["https://obs.example"] });
      const res = await raw(port, "/state", { Origin: origin });
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers.vary).toBe("Origin");
    },
  );

  it.each(["https://evil.example", "http://localhost.evil.example"])(
    "refuses %s",
    async (origin) => {
      const { server, port } = await start();
      server.publishUpdate(UPDATE);
      for (const route of ["/state", "/events", "/healthz"]) {
        const res = await raw(port, route, { Origin: origin });
        expect(res.status).toBe(403);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        expect(res.body).not.toContain(UPDATE.payload.machines[0]!.machine_uuid);
      }
    },
  );

  it("answers a preflight and refuses writes", async () => {
    const { port } = await start();
    const pre = await raw(port, "/state", { Origin: "http://localhost:3000" }, "OPTIONS");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-methods"]).toBe("GET, OPTIONS");
    expect((await raw(port, "/state", {}, "POST")).status).toBe(405);
  });
});

describe("AgentServer static files", () => {
  it("serves files with a content type, and index.html for directories", async () => {
    const { base } = await start({ staticDir: root });
    const index = await fetch(`${base}/`);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toBe("<h1>overlay</h1>");
    expect(await (await fetch(`${base}/sub/`)).text()).toBe("<p>sub</p>");
    const css = await fetch(`${base}/style.css`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect((await fetch(`${base}/alias.css`)).status).toBe(200);
    // Only known file types are served.
    expect((await fetch(`${base}/blob.bin`)).status).toBe(404);
    // API routes win over files.
    expect((await fetch(`${base}/state`)).headers.get("content-type")).toContain(
      "application/json",
    );
  });

  it.each([
    ["/missing.html", 404],
    ["/empty/", 404],
    ["/trap/", 404],
    ["/%E0%A4%A", 400],
    ["/index.html%00.png", 400],
  ])("answers %s with %i", async (rawPath, status) => {
    const { port } = await start({ staticDir: root });
    expect((await raw(port, rawPath)).status).toBe(status);
  });

  it.each([
    "/..%2fsecret.txt",
    "/..%2F..%2F..%2Fetc%2Fpasswd",
    "/sub/..%2f..%2fsecret.txt",
    "/%2e%2e%2fsecret.txt",
  ])("refuses path traversal %s", async (rawPath) => {
    const { port } = await start({ staticDir: root });
    const res = await raw(port, rawPath);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("top secret");
  });

  it("normalises a literal ../ back inside the root", async () => {
    const { port } = await start({ staticDir: root });
    const res = await raw(port, "/../secret.txt");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("top secret");
  });

  it("refuses a symlink that points outside the root", async () => {
    const { port } = await start({ staticDir: root });
    const res = await raw(port, "/escape.txt");
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("top secret");
  });
});

/** Send raw bytes and collect the reply, for requests no HTTP client would send. */
function rawSocket(port: number, text: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (reply += chunk));
    socket.on("close", () => resolve(reply));
    socket.on("error", () => undefined);
    void reject;
  });
}

describe("AgentServer hardening", () => {
  it("answers a malformed request URL with 400 and keeps serving", async () => {
    const { port, base } = await start();
    const reply = await rawSocket(
      port,
      "GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it.each(["evil.example", "evil.example:8787", "127.0.0.1.evil.example", "a:b:c"])(
    "refuses Host %j on a loopback agent (DNS rebinding)",
    async (host) => {
      const { port } = await start();
      const res = await raw(port, "/state", { Host: host });
      expect(res.status).toBe(403);
      expect(res.body).toContain("host not allowed");
    },
  );

  it("refuses a request with no Host at all", async () => {
    const { port } = await start();
    expect(await rawSocket(port, "GET /state HTTP/1.0\r\n\r\n")).toMatch(/^HTTP\/1\.1 403 /);
  });

  it.each(["localhost", "localhost:8787", "127.0.0.1:1", "[::1]:8787", "LOCALHOST"])(
    "accepts Host %j on a loopback agent",
    async (host) => {
      const { port } = await start();
      expect((await raw(port, "/state", { Host: host })).status).toBe(200);
    },
  );

  it("does not check Host when deliberately bound beyond loopback", async () => {
    const server = new AgentServer({ host: "0.0.0.0", port: 0 });
    servers.push(server);
    const { port } = await server.listen();
    expect((await raw(port, "/state", { Host: "overlay.lan:8787" })).status).toBe(200);
  });

  it("answers 500 if a route throws before responding, and drops the socket if after", async () => {
    const { server, port } = await start();
    const target = server as unknown as { openEvents: (req: unknown, res: ServerResponse) => void };
    const spy = vi.spyOn(target, "openEvents");
    spy.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect((await raw(port, "/events")).status).toBe(500);
    spy.mockImplementationOnce((_req, res) => {
      res.writeHead(200);
      res.write("partial");
      throw new Error("boom");
    });
    const reply = await rawSocket(port, "GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n");
    expect(reply).toContain("partial");
    expect((await raw(port, "/state")).status).toBe(200);
  });
});

describe("AgentServer file:// origin", () => {
  it("refuses Origin: null unless --allow-file-origin", async () => {
    const { port } = await start({ staticDir: root });
    for (const route of ["/state", "/events", "/healthz", "/"]) {
      expect((await raw(port, route, { Origin: "null" })).status).toBe(403);
    }
  });

  it("with --allow-file-origin, lets Origin: null read /state and /events only", async () => {
    const { port } = await start({ staticDir: root, allowFileOrigin: true });
    const state = await raw(port, "/state", { Origin: "null" });
    expect(state.status).toBe(200);
    expect(state.headers["access-control-allow-origin"]).toBe("null");
    const events = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/events", headers: { Origin: "null" } },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.destroy();
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(events).toBe(200);
    for (const route of ["/healthz", "/", "/index.html"]) {
      expect((await raw(port, route, { Origin: "null" })).status).toBe(403);
    }
  });
});

describe("AgentServer static hardening", () => {
  it.each(["/.env", "/.git/config.json", "/%2eenv", "/innocent.js", "/sub/../.env"])(
    "never serves a dotfile (%s)",
    async (rawPath) => {
      const { port } = await start({ staticDir: root });
      const res = await raw(port, rawPath);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain("sb_live_");
    },
  );

  it("answers 404, and keeps running, for a file it cannot read", async () => {
    const { port } = await start({ staticDir: root });
    expect((await raw(port, "/locked.html")).status).toBe(404);
    expect((await raw(port, "/index.html")).status).toBe(200);
  });

  it("survives a client that goes away mid-file", async () => {
    const { port } = await start({ staticDir: root });
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/big.js" }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => undefined);
      req.on("close", () => undefined);
      req.end();
      setTimeout(() => reject(new Error("no data")), 2_000);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await raw(port, "/index.html")).status).toBe(200);
  });
});

describe("isLoopbackHost", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "LocalHost.",
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "[::FFFF:127.0.0.9]",
  ])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "::",
    "192.168.1.10",
    "127.0.0.1.evil.example",
    "localhost.evil",
    "128.0.0.1",
  ])("%s is not loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  it("keeps the rebinding check when bound with an upper-case host name", async () => {
    const server = new AgentServer({ host: "LOCALHOST", port: 0 });
    servers.push(server);
    const { port, address } = await server.listen();
    const res = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: address, port, path: "/state", headers: { Host: "evil.example" } },
        (r) => {
          resolve(r.statusCode ?? 0);
          r.resume();
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res).toBe(403);
  });
});
