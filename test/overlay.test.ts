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

const HTML = readFileSync(
  fileURLToPath(new URL("../templates/overlay/index.html", import.meta.url)),
  "utf8",
);

/** Run the overlay against the agent's origin and hand back its status element and event source. */
async function overlayPage() {
  type Listener = (event: { data: string }) => void;
  const elements: Record<
    string,
    { dataset: Record<string, string>; title: string; textContent: string }
  > = {};
  const element = (id: string) =>
    (elements[id] ??= {
      dataset: {},
      title: "",
      textContent: "",
      ...{ replaceChildren() {}, append() {} },
    });
  const sources: { listeners: Record<string, Listener>; onerror?: () => void }[] = [];
  runInNewContext(SCRIPT, {
    window: { location: { href: "http://127.0.0.1:8787/", protocol: "http:", search: "" } },
    document: { getElementById: element, createElement: () => element(`new-${Math.random()}`) },
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    fetch: agentHealth,
    EventSource: class {
      listeners: Record<string, Listener> = {};
      onerror?: () => void;
      constructor() {
        sources.push(this);
      }
      addEventListener(name: string, listener: Listener) {
        this.listeners[name] = listener;
      }
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const source = sources[0]!;
  const send = (status: string) => source.listeners.status!({ data: JSON.stringify({ status }) });
  return { status: elements.status!, text: elements["status-text"]!, source, send };
}

describe("overlay connection status", () => {
  it("is a polite live region with a text label, not colour alone", () => {
    expect(HTML).toMatch(/id="status"[^>]*role="status"/);
    expect(HTML).toMatch(/id="status"[^>]*aria-live="polite"/);
    expect(HTML).toMatch(/<span class="status-dot" aria-hidden="true"><\/span>/);
    expect(HTML).toMatch(
      /<span id="status-text" class="visually-hidden">Connecting to the live feed<\/span>/,
    );
  });

  it("updates its text, title and state on connect, reconnect and end", async () => {
    const { status, text, source, send } = await overlayPage();
    send("live");
    expect(text.textContent).toBe("Live");
    expect(status.title).toBe("Live");
    expect(status.dataset.status).toBe("live");

    source.onerror!();
    expect(text.textContent).toBe("Reconnecting to the live feed");
    expect(status.dataset.status).toBe("reconnecting");

    send("live");
    expect(text.textContent).toBe("Live");

    send("ended");
    expect(text.textContent).toBe("Live feed ended");
    expect(status.dataset.status).toBe("ended");
  });

  it("does not re-announce a status that has not changed", async () => {
    const { text, send } = await overlayPage();
    send("live");
    let writes = 0;
    let value = text.textContent;
    Object.defineProperty(text, "textContent", {
      get: () => value,
      set: (next: string) => {
        writes += 1;
        value = next;
      },
    });
    send("live");
    send("live");
    expect(writes).toBe(0);
    send("reconnecting");
    expect(writes).toBe(1);
  });

  it("labels an unknown status as text, safely", async () => {
    const { text, send } = await overlayPage();
    send("constructor");
    expect(text.textContent).toBe("Live feed status: constructor");
  });
});
