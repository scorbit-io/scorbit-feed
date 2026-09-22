/* The starter overlay's choice of agent URL, run in a VM with a stubbed page. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

const SCRIPT = readFileSync(
  fileURLToPath(new URL("../templates/overlay/overlay.js", import.meta.url)),
  "utf8",
);

async function agentUrlFor(href: string, healthz?: () => Promise<Response>) {
  const opened: string[] = [];
  const fetchCalls: string[] = [];
  const warn = vi.fn();
  const element = () => ({ dataset: {}, replaceChildren() {}, append() {} });
  const page = new URL(href);
  runInNewContext(SCRIPT, {
    window: { location: { href, protocol: page.protocol, search: page.search } },
    document: { getElementById: element, createElement: element },
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { warn },
    fetch: (url: string) => {
      fetchCalls.push(url);
      return healthz ? healthz() : Promise.reject(new Error("offline"));
    },
    EventSource: class {
      constructor(url: string) {
        opened.push(url);
      }
      addEventListener() {}
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { opened, fetchCalls, warn };
}

const agentHealth = () =>
  Promise.resolve(Response.json({ ok: true, status: "live", agent: "scorbit-feed" }));

describe("overlay agent URL", () => {
  it("uses its own origin when the page was served by the agent", async () => {
    const { opened, fetchCalls } = await agentUrlFor("http://127.0.0.1:8787/", agentHealth);
    expect(fetchCalls).toEqual(["/healthz"]);
    expect(opened).toEqual(["/events"]);
  });

  it.each([
    ["a /healthz that is not the agent's", () => Promise.resolve(Response.json({ ok: true }))],
    ["a /healthz that is not JSON", () => Promise.resolve(new Response("<html>"))],
    ["no /healthz at all", () => Promise.reject(new Error("404"))],
  ])("falls back to the default agent on a web server with %s", async (_label, healthz) => {
    const { opened } = await agentUrlFor("https://overlays.example.com/scores/", healthz);
    expect(opened).toEqual(["http://127.0.0.1:8787/events"]);
  });

  it("uses the default agent from disk, without probing", async () => {
    const { opened, fetchCalls } = await agentUrlFor("file:///Users/me/overlay/index.html");
    expect(fetchCalls).toEqual([]);
    expect(opened).toEqual(["http://127.0.0.1:8787/events"]);
  });

  it.each([
    ["http://192.168.1.20:9000/", "http://192.168.1.20:9000/events"],
    ["https://agent.example//", "https://agent.example/events"],
    ["https://agent.example/prefix///", "https://agent.example/prefix/events"],
  ])("normalises ?agent=%s", async (agent, expected) => {
    const { opened } = await agentUrlFor(`file:///x/index.html?agent=${encodeURIComponent(agent)}`);
    expect(opened).toEqual([expected]);
  });

  it.each(["javascript:alert(1)", "not a url", "ftp://agent.example/"])(
    "ignores ?agent=%s and warns",
    async (agent) => {
      const { opened, warn } = await agentUrlFor(
        `file:///x/index.html?agent=${encodeURIComponent(agent)}`,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(opened).toEqual(["http://127.0.0.1:8787/events"]);
    },
  );
});
