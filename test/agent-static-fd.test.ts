/* serveStatic must never leak a file handle, whatever fails and whenever the client goes. */
import type { FileHandle } from "node:fs/promises";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Every handle the server opens, with a hook to make it misbehave.
const opened: { handle: FileHandle; closed: Promise<void> }[] = [];
const sabotage: { stat?: boolean; close?: boolean } = {};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      // A FileHandle is an EventEmitter that emits `close` once its fd is released.
      const events = handle as unknown as NodeJS.EventEmitter;
      const closed = new Promise<void>((resolve) => events.once("close", () => resolve()));
      opened.push({ handle, closed });
      if (sabotage.stat) {
        handle.stat = async () => {
          throw new Error("EIO: stat failed");
        };
      }
      if (sabotage.close) {
        const realClose = handle.close.bind(handle);
        handle.close = async () => {
          await realClose();
          throw new Error("close failed");
        };
      }
      return handle;
    },
  };
});

const { AgentServer } = await import("../src/agent/server.js");

let root: string;
const servers: InstanceType<typeof AgentServer>[] = [];

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "scorbit-feed-fd-")));
  await writeFile(path.join(root, "index.html"), "<p>hi</p>");
  await writeFile(path.join(root, "big.js"), "x".repeat(16 * 1024 * 1024));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(async () => {
  opened.length = 0;
  sabotage.stat = sabotage.close = false;
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start() {
  const server = new AgentServer({ host: "127.0.0.1", port: 0, staticDir: root });
  servers.push(server);
  return (await server.listen()).port;
}

function get(port: number, route: string) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: route }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

const settled = (closed: Promise<void>) =>
  Promise.race([closed.then(() => "closed"), new Promise((r) => setTimeout(() => r("open"), 500))]);

describe("serveStatic file handles", () => {
  it("closes the handle when stat fails after open", async () => {
    const port = await start();
    sabotage.stat = true;
    expect(await get(port, "/index.html")).toBe(404);
    expect(opened).toHaveLength(1);
    expect(await settled(opened[0]!.closed)).toBe("closed");
  });

  it("still answers 404 when closing that handle fails too", async () => {
    const port = await start();
    sabotage.stat = true;
    sabotage.close = true;
    expect(await get(port, "/index.html")).toBe(404);
    expect(await settled(opened[0]!.closed)).toBe("closed");
  });

  it("closes the handle after a file is served", async () => {
    const port = await start();
    expect(await get(port, "/index.html")).toBe(200);
    expect(await settled(opened[0]!.closed)).toBe("closed");
  });

  it("closes the handle when the client aborts mid-stream", async () => {
    const port = await start();
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/big.js" }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => undefined);
      req.end();
      setTimeout(() => reject(new Error("no data")), 2_000);
    });
    expect(opened).toHaveLength(1);
    expect(await settled(opened[0]!.closed)).toBe("closed");
  });
});
