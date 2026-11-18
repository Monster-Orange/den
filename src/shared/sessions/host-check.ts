/**
 * Issue 500: how the terminal host is doing, for doctor, the page and the
 * update's replacement of an older host:
 *
 *   none     nothing serves on the socket (it starts with the first shell)
 *   ok       it answered: its version, pid and how many shells run there
 *   failing  it answered, but its last start failed (why)
 *   stuck    it took the connection and didn't answer within the wait, or
 *            refused the hello; its version from sessions.host.json
 *
 * And restartHost: stop the host (shutdown, which every version takes)
 * and start one of this version.
 */
import * as fs from "fs";
import * as path from "path";
import semver from "semver";
import { connectHost, noHost, type HostClient } from "./client.js";
import { frame, PROTOCOL_VERSION } from "./protocol.js";

export type HostCheck =
  | { state: "none" }
  | {
      state: "ok";
      version: string | null;
      pid: number;
      startedAt: string;
      /** Shells running there now. */
      live: number;
    }
  | {
      state: "failing";
      version: string | null;
      pid: number;
      live: number;
      reason: string;
    }
  | {
      state: "stuck";
      version: string | null;
      pid?: number;
      reason: string;
    };

/** What a host wrote when it began to serve (sessions.host.json). */
export function readHostFile(
  file: string,
): { pid?: number; version: string | null } | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      pid?: unknown;
      version?: unknown;
    };
    return {
      ...(typeof v.pid === "number" ? { pid: v.pid } : {}),
      version: typeof v.version === "string" ? v.version : null,
    };
  } catch {
    return null;
  }
}

export async function checkHost(o: {
  socket: string;
  timeoutMs: number;
  /** sessions.host.json (default: beside the socket). */
  hostFile?: string;
}): Promise<HostCheck> {
  const hostFile =
    o.hostFile ?? path.join(path.dirname(o.socket), "sessions.host.json");
  let c: HostClient;
  try {
    c = await connectHost(o.socket, { timeoutMs: o.timeoutMs });
  } catch (e) {
    if (noHost(e)) return { state: "none" };
    const rec = readHostFile(hostFile);
    return {
      state: "stuck",
      version: rec?.version ?? null,
      ...(rec?.pid !== undefined ? { pid: rec.pid } : {}),
      reason: (e as Error).message,
    };
  }
  try {
    let live: number;
    try {
      live = (await c.list({ timeoutMs: o.timeoutMs })).filter(
        (s) => !s.exited,
      ).length;
    } catch (e) {
      return {
        state: "stuck",
        version: c.hostVersion,
        pid: c.hostPid,
        reason: (e as Error).message,
      };
    }
    if (c.hostStartError)
      return {
        state: "failing",
        version: c.hostVersion,
        pid: c.hostPid,
        live,
        reason: c.hostStartError.error,
      };
    return {
      state: "ok",
      version: c.hostVersion,
      pid: c.hostPid,
      startedAt: c.hostStartedAt,
      live,
    };
  } finally {
    c.close();
  }
}

/**
 * Whether a host of `host` is older than Den's `den`. A host that doesn't
 * say (null: from before issue 500) is older; an unreadable version of
 * either is not judged.
 */
export function hostIsOlder(
  host: string | null,
  den: string | undefined,
): boolean {
  if (!den || !semver.valid(den)) return false;
  if (host === null) return true;
  return !!semver.valid(host) && semver.lt(host, den);
}

/**
 * Stop the host on `socket` (its shells end) and start one of this
 * version with `start` (spawned, or the launchd job brings it back).
 * Resolves once the old one is gone and `start` has resolved.
 */
export async function restartHost(o: {
  socket: string;
  timeoutMs: number;
  start: () => Promise<void>;
}): Promise<void> {
  let c: HostClient | null = null;
  try {
    c = await connectHost(o.socket, { timeoutMs: o.timeoutMs });
  } catch (e) {
    if (!noHost(e)) {
      // Stuck: a host that doesn't say hello may still take shutdown.
      await rawShutdown(o.socket, o.timeoutMs);
    }
  }
  if (c) {
    const closed = new Promise<void>((r) => c!.once("close", () => r()));
    await c.shutdown().catch(() => undefined);
    await Promise.race([
      closed,
      new Promise((r) => setTimeout(r, o.timeoutMs)),
    ]);
    c.close();
  }
  const deadline = Date.now() + o.timeoutMs;
  while (fs.existsSync(o.socket) && Date.now() < deadline) {
    if (!(await answers(o.socket))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await o.start();
}

/** Sends `shutdown` without waiting for a hello. */
async function rawShutdown(socket: string, ms: number): Promise<void> {
  const net = await import("net");
  await new Promise<void>((resolve) => {
    const s = net.connect(socket);
    const t = setTimeout(() => {
      s.destroy();
      resolve();
    }, ms);
    s.once("error", () => {
      clearTimeout(t);
      resolve();
    });
    s.once("connect", () => {
      s.write(frame({ v: PROTOCOL_VERSION, id: 1, op: "shutdown" }));
    });
    s.once("close", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function answers(socket: string): Promise<boolean> {
  const { socketAnswers } = await import("./host.js");
  return socketAnswers(socket, 200);
}
