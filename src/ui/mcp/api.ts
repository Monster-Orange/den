/**
 * The MCP server's client for the running web server's HTTP API. The MCP
 * server holds no state of its own: agents and the web UI share the server's
 * state and its guards. This client can reach only the routes below, and it
 * sends the agent's audit headers (see shared/agent-actor.ts) on every call.
 *
 * With `identity`, it first makes sure the server on the port is this
 * distribution's (server-identity.ts): another distribution's server (or an
 * older Den from another root) on the configured port gets no request, and
 * every tool says whose server it is instead of serving its data.
 */
import { product } from "../../shared/product.js";
import {
  foreignServerMessage,
  identifyServer,
  type OwnServer,
  type ServerIdentity,
} from "../cli/server-identity.js";
import { LIFECYCLE_CMDS, Refusal } from "./guards.js";

export type Query = Record<string, string | string[] | undefined>;

/** The web server isn't answering; the message names the start command. */
export class DenWebDown extends Error {
  constructor(baseUrl: string, cli: string) {
    super(
      `The ${product().title} web server is not running at ${baseUrl}. ` +
        `Start it with \`${cli} web up\` (the MCP server never starts it for you).`,
    );
    this.name = "DenWebDown";
  }
}

/** Another distribution's server answers on the port: no data from it. */
export class ForeignWebServer extends Error {
  constructor(
    readonly port: number,
    readonly who: string,
  ) {
    super(
      `${foreignServerMessage(port, who)}; not this distribution's server. ` +
        `Nothing was read from it. Point web.port (or --port) at this distribution's server.`,
    );
    this.name = "ForeignWebServer";
  }
}

/** Something answers on the port but would not say whose server it is. */
export class UnidentifiedWebServer extends Error {
  constructor(readonly port: number) {
    super(
      `the server on port ${port} did not answer /api/server-info in time, ` +
        `so it is not known to be this distribution's; nothing was read from it. Try again.`,
    );
    this.name = "UnidentifiedWebServer";
  }
}

/** How long a positive identity check is trusted. */
export const IDENTITY_TTL_MS = 30_000;
/** The identity probe's budget: longer than the CLI's, a busy server is ours too. */
export const IDENTITY_TIMEOUT_MS = 5_000;

export interface IdentityCheck {
  /** This distribution: its root and product. */
  own: OwnServer;
  /** Default identifyServer. */
  identify?: (port: number, own: OwnServer) => Promise<ServerIdentity>;
  /** Default IDENTITY_TTL_MS. */
  ttlMs?: number;
  /** Default Date.now. */
  now?: () => number;
}

/** The web server answered with an error status. */
export class DenHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body}`);
    this.name = "DenHttpError";
  }
}

/** Read routes: GET only. */
const READ_ROUTES = new Set([
  "/api/health",
  "/api/services",
  "/api/applications",
  "/api/graph",
  "/api/workspaces",
  "/api/environments",
  "/api/logs/search",
  "/api/service/taillog",
  "/api/service/logs",
  "/api/modules",
  "/api/test-sources",
  "/api/security/latest",
  "/api/security/plan",
  "/api/release/status",
  "/api/release/runs",
  "/api/manifest/validate",
  "/api/stacks",
  "/api/edge",
  "/api/server-info",
]);

/** Action routes and their method. Anything else is never reached. */
const ACTION_ROUTES: Record<string, string> = {
  // A refusal report: appends one entry to the activity trail, nothing more.
  "/api/activity": "POST",
  "/api/service/exec": "GET",
  "/api/run": "GET",
  "/api/workspace/sync": "POST",
};

/**
 * Throws a Refusal unless (method, path) is an allowed route. Never reached:
 * sudo-password, aws/login, terminal/open, editor/open, workspace/exec,
 * settings writes, workspace create/rename/mode, server-log, config, deploys.
 * service/exec is allowed only for up/down/restart with env=local.
 */
export function assertAllowedRequest(
  method: string,
  path: string,
  query: Query,
): void {
  const ok =
    (READ_ROUTES.has(path) &&
      (method === "GET" ||
        (method === "POST" && path === "/api/manifest/validate"))) ||
    ACTION_ROUTES[path] === method;
  if (!ok) throw new Refusal(`${method} ${path} is not exposed to agents.`);
  if (path === "/api/service/exec") {
    const cmd = String(query.cmd ?? "");
    if (!(LIFECYCLE_CMDS as readonly string[]).includes(cmd))
      throw new Refusal(
        `service/exec "${cmd}" refused: only ${LIFECYCLE_CMDS.join(", ")}.`,
      );
    if (query.env !== "local")
      throw new Refusal("service/exec refused: env=local only.");
  }
}

export interface SseEvent {
  type?: string;
  text?: string;
  exitCode?: number;
  [k: string]: unknown;
}

export interface StreamOpts {
  method?: "GET" | "POST";
  /** Stop after this many output lines (a follow stream never ends itself). */
  maxLines: number;
  /** Stop after this long, whatever is happening. */
  timeoutMs: number;
  /** Stop once nothing has arrived for this long (for log tails). */
  idleMs?: number;
  /** Stop when this event arrives (e.g. a detached `up` handing off). */
  stopOn?: (e: SseEvent) => boolean;
}

export interface StreamResult {
  events: SseEvent[];
  lines: string[];
  ended: "done" | "closed" | "limit" | "timeout" | "idle" | "stopped";
  exitCode?: number;
}

export interface DenApi {
  baseUrl: string;
  /** A JSON route. */
  get(
    path: string,
    query?: Query,
    method?: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown>;
  /** An SSE route, read to a bound; the connection is closed after. */
  stream(path: string, query: Query, opts: StreamOpts): Promise<StreamResult>;
}

function buildUrl(base: string, path: string, query: Query = {}): string {
  const u = new URL(path, base);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) u.searchParams.append(k, one);
  }
  return u.toString();
}

function isConnectionError(e: unknown): boolean {
  const err = e as { name?: string; cause?: { code?: string } };
  if (err?.name === "AbortError") return false;
  const code = err?.cause?.code ?? "";
  return (
    err?.name === "TypeError" ||
    ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH"].includes(code)
  );
}

const OUTPUT_TYPES = new Set(["line", "cmd", "error"]);

export function createDenApi(opts: {
  baseUrl: string;
  cli: string;
  headers: () => Record<string, string>;
  /** Check whose server it is before any request (the MCP server does). */
  identity?: IdentityCheck;
}): DenApi {
  const { baseUrl, cli } = opts;
  const { hostname } = new URL(baseUrl);
  const port = Number(new URL(baseUrl).port) || 80;
  let vouchedAt: number | null = null;
  let checking: Promise<void> | null = null;

  /** Throws unless the server on the port is ours (cached briefly). */
  async function ensureOurs(): Promise<void> {
    const check = opts.identity;
    if (!check) return;
    const now = check.now ?? Date.now;
    if (
      vouchedAt !== null &&
      now() - vouchedAt < (check.ttlMs ?? IDENTITY_TTL_MS)
    )
      return;
    checking ??= (async () => {
      const id = await (
        check.identify ??
        ((p: number, o: OwnServer) =>
          identifyServer(p, o, IDENTITY_TIMEOUT_MS, hostname))
      )(port, check.own);
      if (id.kind === "ours") {
        vouchedAt = now();
        return;
      }
      vouchedAt = null;
      if (id.kind === "foreign") throw new ForeignWebServer(port, id.who);
      if (id.kind === "none") throw new DenWebDown(baseUrl, cli);
      throw new UnidentifiedWebServer(port);
    })().finally(() => {
      checking = null;
    });
    return checking;
  }

  async function request(
    method: string,
    path: string,
    query: Query,
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    assertAllowedRequest(method, path, query);
    await ensureOurs();
    try {
      const res = await fetch(buildUrl(baseUrl, path, query), {
        method,
        headers: {
          ...opts.headers(),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 2000);
        throw new DenHttpError(method, path, res.status, text);
      }
      return res;
    } catch (e) {
      if (isConnectionError(e)) {
        // Whatever answers next on the port is checked again.
        vouchedAt = null;
        throw new DenWebDown(baseUrl, cli);
      }
      throw e;
    }
  }

  return {
    baseUrl,

    async get(path, query = {}, method = "GET", body) {
      const res = await request(method, path, query, undefined, body);
      const text = await res.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    },

    async stream(path, query, s) {
      const ac = new AbortController();
      const res = await request(s.method ?? "GET", path, query, ac.signal);
      const events: SseEvent[] = [];
      const lines: string[] = [];
      let exitCode: number | undefined;
      let ended: StreamResult["ended"] = "closed";
      let stop = false;

      const finish = (why: StreamResult["ended"]): void => {
        if (stop) return;
        stop = true;
        ended = why;
        ac.abort();
      };
      const overall = setTimeout(() => finish("timeout"), s.timeoutMs);
      let idle: ReturnType<typeof setTimeout> | undefined;
      const bumpIdle = (): void => {
        if (!s.idleMs) return;
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => finish("idle"), s.idleMs);
      };
      bumpIdle();

      const onEvent = (e: SseEvent): void => {
        events.push(e);
        if (OUTPUT_TYPES.has(String(e.type)) && typeof e.text === "string") {
          for (const l of e.text.replace(/\n+$/, "").split("\n")) {
            if (lines.length >= s.maxLines) return finish("limit");
            lines.push(l);
          }
          if (lines.length >= s.maxLines) return finish("limit");
        }
        if (e.type === "done") {
          if (typeof e.exitCode === "number") exitCode = e.exitCode;
          return finish("done");
        }
        if (s.stopOn?.(e)) finish("stopped");
      };

      try {
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (reader && !stop) {
          const { value, done } = await reader.read();
          if (done) break;
          bumpIdle();
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while (!stop && (i = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            try {
              onEvent(JSON.parse(data) as SseEvent);
            } catch {
              onEvent({ type: "line", text: data });
            }
          }
        }
      } catch (e) {
        if (!stop) throw e;
      } finally {
        clearTimeout(overall);
        if (idle) clearTimeout(idle);
        if (!stop) ac.abort();
      }
      return {
        events,
        lines,
        ended,
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
    },
  };
}
