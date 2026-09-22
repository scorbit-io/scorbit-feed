import { open, realpath, stat } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { FeedMachineState, FeedStatus, FeedUpdate } from "../types.js";

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
// Routes a page opened from file:// may read when --allow-file-origin is set.
const FILE_ORIGIN_ROUTES = new Set(["/state", "/events"]);

// Only these are served; anything else under --static is a 404.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export interface AgentServerOptions {
  host: string;
  port: number;
  /** A directory of overlay files to serve. Already resolved by the caller. */
  staticDir?: string;
  /** Extra origins allowed besides loopback http origins. */
  corsOrigins?: string[];
  /**
   * Let `Origin: null` (a page opened from file://) read /state and /events.
   * Off by default: sandboxed iframes on any website also send `Origin: null`.
   */
  allowFileOrigin?: boolean;
}

/** Loopback http origins on any port, and the configured list. `null` is handled per route. */
export function isAllowedOrigin(origin: string, configured: readonly string[] = []): boolean {
  return LOCAL_ORIGIN.test(origin) || configured.includes(origin);
}

/** localhost, any 127.0.0.0/8 address, or ::1 (also IPv4-mapped); any case, brackets optional. */
export function isLoopbackHost(host: string): boolean {
  const name = host
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  const v4 = name.replace(/^::ffff:/, "");
  return (
    name === "localhost" ||
    name === "::1" ||
    name === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
  );
}

/** The hostname part of a Host header, brackets kept for IPv6. */
function hostnameOf(header: string): string {
  const match = /^(\[[^\]]*\]|[^:]*)(:\d+)?$/.exec(header);
  return (match?.[1] ?? "").toLowerCase();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The agent's local HTTP surface. It holds only feed *data* (machine state and
 * status); no credential ever reaches it, so none can leak through it.
 */
export class AgentServer {
  readonly server: Server;
  private readonly options: AgentServerOptions;
  private readonly clients = new Set<ServerResponse>();
  private machines: FeedMachineState[] = [];
  private updatedAt: string | null = null;
  private status: FeedStatus = "idle";

  constructor(options: AgentServerOptions) {
    this.options = options;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        else res.destroy();
      });
    });
  }

  listen(): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve(this.server.address() as AddressInfo);
      });
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.end();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  snapshot() {
    return { status: this.status, updated_at: this.updatedAt, machines: this.machines };
  }

  /** Replaces the whole state: a machine missing from the update has left the feed. */
  publishUpdate(update: FeedUpdate): void {
    this.machines = update.payload.machines;
    this.updatedAt = update.metadata?.updated_at ?? null;
    this.broadcast(sseFrame("state", this.snapshot()));
  }

  publishStatus(status: FeedStatus): void {
    this.status = status;
    this.broadcast(sseFrame("status", { status }));
  }

  private broadcast(frame: string): void {
    for (const client of this.clients) client.write(frame);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a loopback agent answers only to loopback host names.
    if (isLoopbackHost(this.options.host) && !isLoopbackHost(hostnameOf(req.headers.host ?? ""))) {
      return sendJson(res, 403, { error: "host not allowed" });
    }
    let pathname: string;
    try {
      pathname = new URL(String(req.url), "http://agent.invalid").pathname;
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }

    const origin = req.headers.origin;
    if (origin !== undefined) {
      const allowed =
        origin === "null"
          ? this.options.allowFileOrigin === true && FILE_ORIGIN_ROUTES.has(pathname)
          : isAllowedOrigin(origin, this.options.corsOrigins);
      if (!allowed) return sendJson(res, 403, { error: "origin not allowed" });
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET, OPTIONS" });
      res.end();
      return;
    }
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });

    if (pathname === "/state") return sendJson(res, 200, this.snapshot());
    if (pathname === "/healthz") {
      const ok = this.status !== "ended";
      return sendJson(res, ok ? 200 : 503, { ok, status: this.status });
    }
    if (pathname === "/events") return this.openEvents(req, res);
    if (this.options.staticDir) return this.serveStatic(this.options.staticDir, pathname, res);
    sendJson(res, 404, { error: "not found" });
  }

  private openEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(sseFrame("status", { status: this.status }));
    res.write(sseFrame("state", this.snapshot()));
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  private async serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
    let relative: string;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      return sendJson(res, 400, { error: "bad path" });
    }
    if (relative.includes("\0")) return sendJson(res, 400, { error: "bad path" });

    // Resolve, then re-check after following symlinks: both must stay under root.
    const inside = (candidate: string) =>
      candidate === root || candidate.startsWith(root + path.sep);
    // No dotfiles or dot-directories (.env, .git), and only known file types.
    const servable = (candidate: string) =>
      !path
        .relative(root, candidate)
        .split(path.sep)
        .some((segment) => segment.startsWith(".")) &&
      path.extname(candidate).toLowerCase() in CONTENT_TYPES;

    let target = path.resolve(root, `.${path.sep}${relative}`);
    if (!inside(target)) return sendJson(res, 403, { error: "forbidden" });
    let file;
    try {
      if ((await stat(target)).isDirectory()) target = path.join(target, "index.html");
      target = await realpath(target);
      if (!inside(target)) return sendJson(res, 403, { error: "forbidden" });
      if (!servable(target)) return sendJson(res, 404, { error: "not found" });
      // Opened before any header is sent, so an unreadable file is still a clean 404.
      file = await open(target, "r");
      if (!(await file.stat()).isFile()) {
        await file.close();
        return sendJson(res, 404, { error: "not found" });
      }
    } catch {
      return sendJson(res, 404, { error: "not found" });
    }
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(target).toLowerCase()],
      "Cache-Control": "no-cache",
    });
    // pipeline closes the file and destroys the response on a read error.
    await pipeline(file.createReadStream(), res).catch(() => undefined);
  }
}
