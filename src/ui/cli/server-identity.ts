/**
 * Whether the web server answering on a port is THIS distribution's.
 *
 * Several distributions can run a Den web server on one machine (each with
 * its own root), so something answering on the configured port is not
 * proof it is ours: `<cli> web up` once printed "already running" for
 * another distribution's server, and `web down` could have signalled it.
 * /api/server-info names the distribution root it serves and the product
 * (since 0.2.6); every command that acts on "our" server asks this module
 * first and refuses to act on a foreign one.
 *
 * A server from before 0.2.6 has no `root`. It does report its pid, and it
 * runs with its distribution root as its working directory (`web up` and
 * the launchd service both start it there), so that decides instead.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { CLI_SPAWN_TIMEOUT_MS } from "../../shared/constants.js";
import { getDistRoot } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import {
  readWebAuthConfig,
  WEB_READY_PROBE_SECONDS,
  WEB_START_WAIT_SECONDS,
  WEB_TOOLS_PROBE_SECONDS,
} from "../../shared/web-session.js";

/** The distribution a command acts for. */
export interface OwnServer {
  root: string;
  product: string;
}

/** What answers on a port, from this distribution's point of view. */
export type ServerIdentity =
  /** Nothing listens there. */
  | { kind: "none" }
  /** Something accepted the connection but sent no answer: `why`, after `waitedMs`. */
  | {
      kind: "unresponsive";
      why?: "timeout" | "error" | "empty";
      code?: string;
      waitedMs?: number;
    }
  /**
   * `pid`: the server's own pid (server-info reports it). Identity is what
   * makes it ours, so a stop signals this pid even when its command line
   * names no entry point we recognise (an older Den installed elsewhere, a
   * hand-started server).
   */
  | { kind: "ours"; version?: string; pid?: number }
  /** Someone else's server. `who` reads "acme-ops at /srv/acme-ops". */
  | { kind: "foreign"; who: string };

/**
 * den#143: `web up`'s waits, read now: one readiness probe's
 * (web.ready_probe_seconds) and the whole start's (web.start_wait_seconds),
 * in ms. Settings with permissive defaults, never a fixed number: a busy
 * machine answers late, and a cold tsx start is slow. The defaults when
 * the config can't be read.
 */
export function webReadyWaits(): {
  probeMs: number;
  startMs: number;
  toolsProbeMs: number;
} {
  try {
    const c = readWebAuthConfig(getDistRoot(), product().configFile);
    return {
      probeMs: c.readyProbeSeconds * 1000,
      startMs: c.startWaitSeconds * 1000,
      toolsProbeMs: c.toolsProbeSeconds * 1000,
    };
  } catch {
    return {
      probeMs: WEB_READY_PROBE_SECONDS * 1000,
      startMs: WEB_START_WAIT_SECONDS * 1000,
      toolsProbeMs: WEB_TOOLS_PROBE_SECONDS * 1000,
    };
  }
}

/** This distribution: its root and product name. */
export function ownServer(): OwnServer {
  return { root: getDistRoot(), product: product().name };
}

function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

/** A process's working directory (lsof), or null when it can't be read. */
export function processCwd(pid: number): string | null {
  const r = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf-8",
    timeout: CLI_SPAWN_TIMEOUT_MS,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}

/**
 * Classify a parsed /api/server-info body. `cwdOf` reads a pid's working
 * directory, for servers from before `root` was reported.
 */
export function classifyServerInfo(
  body: unknown,
  own: OwnServer,
  cwdOf: (pid: number) => string | null = processCwd,
): ServerIdentity {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return { kind: "foreign", who: "a non-Den server" };
  const info = body as Record<string, unknown>;
  const version = typeof info.version === "string" ? info.version : undefined;
  const prod = typeof info.product === "string" ? info.product : undefined;
  const pid =
    typeof info.pid === "number" && Number.isInteger(info.pid) && info.pid > 0
      ? info.pid
      : undefined;
  const ours = (): ServerIdentity => ({
    kind: "ours",
    ...(version !== undefined ? { version } : {}),
    ...(pid !== undefined ? { pid } : {}),
  });

  if (typeof info.root === "string" && info.root) {
    if (
      samePath(info.root, own.root) &&
      (prod === undefined || prod === own.product)
    )
      return ours();
    return {
      kind: "foreign",
      who: `${prod ?? "another server"} at ${info.root}`,
    };
  }

  if (pid !== undefined) {
    const cwd = cwdOf(pid);
    if (cwd && samePath(cwd, own.root)) return ours();
  }
  if (version === undefined && info.pid === undefined)
    return { kind: "foreign", who: "a non-Den server" };
  return {
    kind: "foreign",
    who: `another server${version ? ` (Den ${version})` : ""}`,
  };
}

/** Classify a raw /api/server-info answer (status and body text). */
export function classifyServerInfoResponse(
  statusCode: number,
  text: string,
  own: OwnServer,
  cwdOf?: (pid: number) => string | null,
): ServerIdentity {
  // A server still starting answers 200 with an empty body: not up yet.
  if (statusCode >= 200 && statusCode < 300 && text.trim() === "")
    return { kind: "unresponsive", why: "empty" };
  if (statusCode < 200 || statusCode >= 300)
    return { kind: "foreign", who: "a non-Den server" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "foreign", who: "a non-Den server" };
  }
  return classifyServerInfo(body, own, cwdOf);
}

/** GET /api/server-info on `port` (at `host`) and say whose server answered. */
export function identifyServer(
  port: number,
  own: OwnServer = ownServer(),
  timeoutMs: number = webReadyWaits().probeMs,
  host: string = "127.0.0.1",
): Promise<ServerIdentity> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: ServerIdentity): void => {
      if (settled) return;
      settled = true;
      resolve(
        v.kind === "unresponsive" ? { ...v, waitedMs: Date.now() - t0 } : v,
      );
    };
    const failed = (e: NodeJS.ErrnoException): ServerIdentity => ({
      kind: "unresponsive",
      why: "error",
      ...(e.code ? { code: e.code } : {}),
    });
    const req = http.get(
      {
        host,
        port,
        path: "/api/server-info",
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 1024 * 1024) {
            req.destroy();
            finish({ kind: "foreign", who: "a non-Den server" });
          }
        });
        res.on("end", () =>
          finish(classifyServerInfoResponse(res.statusCode ?? 0, text, own)),
        );
        res.on("error", (e) => finish(failed(e)));
      },
    );
    req.on("timeout", () => {
      finish({ kind: "unresponsive", why: "timeout" });
      req.destroy();
    });
    req.on("error", (e: NodeJS.ErrnoException) =>
      finish(e.code === "ECONNREFUSED" ? { kind: "none" } : failed(e)),
    );
  });
}

/** "port 7001 is in use by acme-ops at /srv/acme-ops". */
export function foreignServerMessage(port: number, who: string): string {
  return `port ${port} is in use by ${who}`;
}

/** How to get out of the way: another port, for once or for good. */
export function pickAnotherPortHint(cli: string = product().cli): string {
  return (
    `pick another port: \`${cli} web up --port <n>\` for once, or set ` +
    `web.port in config/local/user.yml (yours) or ${product().configFile} (the team's)`
  );
}

/** The error a command raises instead of acting on a foreign server. */
export class ForeignServerError extends Error {
  constructor(
    readonly port: number,
    readonly who: string,
  ) {
    super(
      `${foreignServerMessage(port, who)}\n  Hint: ${pickAnotherPortHint()}`,
    );
    this.name = "ForeignServerError";
  }
}

/** Throw ForeignServerError when `port` is served by another distribution. */
export async function refuseForeignServer(
  port: number,
  own: OwnServer = ownServer(),
): Promise<ServerIdentity> {
  const id = await identifyServer(port, own);
  if (id.kind === "foreign") throw new ForeignServerError(port, id.who);
  return id;
}
