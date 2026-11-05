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

/** The distribution a command acts for. */
export interface OwnServer {
  root: string;
  product: string;
}

/** What answers on a port, from this distribution's point of view. */
export type ServerIdentity =
  /** Nothing listens there. */
  | { kind: "none" }
  /** Something accepted the connection but sent no answer in time. */
  | { kind: "unresponsive" }
  | { kind: "ours"; version?: string }
  /** Someone else's server. `who` reads "acme-ops at /srv/acme-ops". */
  | { kind: "foreign"; who: string };

/** How long one probe of /api/server-info may take. */
export const SERVER_INFO_TIMEOUT_MS = 1_500;

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

function samePath(a: string, b: string): boolean {
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

  if (typeof info.root === "string" && info.root) {
    if (
      samePath(info.root, own.root) &&
      (prod === undefined || prod === own.product)
    )
      return { kind: "ours", version };
    return {
      kind: "foreign",
      who: `${prod ?? "another server"} at ${info.root}`,
    };
  }

  const pid = info.pid;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    const cwd = cwdOf(pid);
    if (cwd && samePath(cwd, own.root)) return { kind: "ours", version };
  }
  if (version === undefined && pid === undefined)
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
    return { kind: "unresponsive" };
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

/** GET /api/server-info on `port` and say whose server answered. */
export function identifyServer(
  port: number,
  own: OwnServer = ownServer(),
  timeoutMs: number = SERVER_INFO_TIMEOUT_MS,
): Promise<ServerIdentity> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: ServerIdentity): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = http.get(
      {
        host: "127.0.0.1",
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
        res.on("error", () => finish({ kind: "unresponsive" }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish({ kind: "unresponsive" });
    });
    req.on("error", (e: NodeJS.ErrnoException) =>
      finish(
        e.code === "ECONNREFUSED" ? { kind: "none" } : { kind: "unresponsive" },
      ),
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
