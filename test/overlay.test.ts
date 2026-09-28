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

/** Just enough DOM for the overlay's tiles: parents, children, moves and removal. */
class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | undefined;
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  title = "";
  hidden = false;
  constructor(readonly tag: string) {}
  append(...nodes: FakeElement[]) {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeElement[]) {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
}

async function tilePage() {
  const byId: Record<string, FakeElement> = {};
  const getElementById = (id: string) => (byId[id] ??= new FakeElement(id));
  // As in index.html: the empty state starts hidden, until the first state arrives.
  getElementById("empty").hidden = true;
  let state!: (event: { data: string }) => void;
  runInNewContext(SCRIPT, {
    window: { location: { href: "http://127.0.0.1:8787/", protocol: "http:", search: "" } },
    document: { getElementById, createElement: (tag: string) => new FakeElement(tag) },
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    fetch: agentHealth,
    EventSource: class {
      addEventListener(name: string, listener: (event: { data: string }) => void) {
        if (name === "state") state = listener;
      }
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const machines = byId.machines!;
  const machine = (uuid: string, score: number) => ({
    machine_uuid: uuid,
    game_name: `Game ${uuid}`,
    game_in_progress: false,
    game_ended: false,
    scores: [{ position: 1, player: null, score, modes: [], is_nfc_verified: false }],
  });
  return {
    send: (list: unknown[], updatedAt: string | null = "2026-09-28T12:00:00Z") =>
      state({ data: JSON.stringify({ status: "live", updated_at: updatedAt, machines: list }) }),
    machine,
    tiles: () => machines.children.map((card) => card.dataset.machine),
    tile: (uuid: string) => machines.children.find((card) => card.dataset.machine === uuid)!,
    empty: byId.empty!,
  };
}

describe("overlay tiles", () => {
  it("adds, updates, reorders and removes tiles keyed by machine_uuid", async () => {
    const page = await tilePage();
    page.send([page.machine("a", 10), page.machine("b", 20)]);
    expect(page.tiles()).toEqual(["a", "b"]);
    const tileA = page.tile("a");

    // A new machine joins, first in the feed's order: a is updated in place, not rebuilt.
    page.send([page.machine("c", 30), page.machine("a", 11)]);
    expect(page.tiles()).toEqual(["c", "a"]);
    expect(page.tile("a")).toBe(tileA);
    expect(tileA.children[0]!.textContent).toBe("Game a");
    expect(tileA.children[2]!.children[0]!.children[1]!.textContent).toBe((11).toLocaleString());
    expect(page.empty.hidden).toBe(true);
  });

  it("shows the empty state when the last machine leaves, and hides it when one joins", async () => {
    const page = await tilePage();
    expect(page.empty.hidden).toBe(true);
    page.send([]);
    expect(page.tiles()).toEqual([]);
    expect(page.empty.hidden).toBe(false);
    page.send([page.machine("a", 1)]);
    expect(page.tiles()).toEqual(["a"]);
    expect(page.empty.hidden).toBe(true);
    page.send([]);
    expect(page.tiles()).toEqual([]);
    expect(page.empty.hidden).toBe(false);
  });

  it("shows no empty state before the first publication, only once one says there are none", async () => {
    const page = await tilePage();
    // The agent's state before any publication: no machines, updated_at null.
    page.send([], null);
    expect(page.empty.hidden).toBe(true);
    page.send([]);
    expect(page.empty.hidden).toBe(false);
    expect(HTML).toMatch(/<p id="empty" class="empty" hidden>/);
  });
});
