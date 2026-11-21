/**
 * #70 (SEC-3 T8): which local process is on the other end of a loopback
 * TCP connection, and whether it runs inside a given process tree.
 *
 * An agent's token is only good from its own agent's processes: the
 * server finds the caller's pid from the connection and walks its parents
 * up to the agent's session. macOS: `lsof` (the row whose local end is the
 * caller's port), then one `ps` snapshot for the parents. Linux: /proc
 * (the socket's inode in /proc/net/tcp{,6}, the pid holding it, each
 * pid's parent in /proc/<pid>/stat). Anything else, or a lookup that
 * can't tell: null, which callers treat as "not proved", never as "yes".
 *
 * A connection is its two ends, not the client's port alone: Linux reuses
 * an ephemeral port for a connect() to another destination, so two live
 * loopback connections can share the client port (issue 196). Given the
 * server's port, only the row to it counts.
 */
import * as fs from "fs";
import { execFile, spawnSync } from "child_process";
import {
  lookup,
  lookupTimeouts,
  LookupTimeoutError,
} from "../ui/cli/proc-lookup.js";

/**
 * By path: a service's PATH (launchd's, a test server's) may not have
 * /usr/sbin, and then every agent call would read as "couldn't tell".
 */
export const DARWIN_LSOF = "/usr/sbin/lsof";
export const DARWIN_PS = "/bin/ps";

export interface PeerDeps {
  platform?: NodeJS.Platform;
  /** Runs a lookup command (stdout, "" when it found nothing). */
  run?: (cmd: string, args: string[]) => string;
  /** Reads a file under /proc (tests use a fake tree). */
  read?: (p: string) => string;
  readlink?: (p: string) => string;
  readdir?: (p: string) => string[];
  /** This process: never its own peer. */
  self?: number;
}

const defaults = (d: PeerDeps) => ({
  platform: d.platform ?? process.platform,
  run:
    d.run ??
    ((cmd: string, args: string[]) => {
      try {
        return lookup(cmd, args, spawnSync);
      } catch (e) {
        if (e instanceof LookupTimeoutError) return "";
        throw e;
      }
    }),
  read: d.read ?? ((p: string) => fs.readFileSync(p, "utf8")),
  readlink: d.readlink ?? ((p: string) => fs.readlinkSync(p)),
  readdir: d.readdir ?? ((p: string) => fs.readdirSync(p)),
  self: d.self ?? process.pid,
});

/**
 * The pid holding the client end of the loopback connection whose client
 * port is `port` (the server sees it as the socket's remotePort) and, when
 * given, whose server port is `to` (the socket's localPort). Null: none
 * found, more than one, or this platform can't tell.
 */
export function loopbackPeerPid(
  port: number,
  d: PeerDeps = {},
  to?: number,
): number | null {
  if (!validPort(port)) return null;
  if (to !== undefined && !validPort(to)) return null;
  const o = defaults(d);
  try {
    if (o.platform === "darwin") return darwinPeer(port, to, o);
    if (o.platform === "linux") return linuxPeer(port, to, o);
  } catch {
    return null;
  }
  return null;
}

const validPort = (p: number) => Number.isInteger(p) && p > 0 && p <= 65535;

const lsofArgs = (port: number) => [
  "-nP",
  "-w",
  `-iTCP:${port}`,
  "-sTCP:ESTABLISHED",
  "-a",
  "-Fpn",
];

function darwinPeer(
  port: number,
  to: number | undefined,
  o: ReturnType<typeof defaults>,
): number | null {
  return one(lsofPids(o.run(DARWIN_LSOF, lsofArgs(port)), port, to, o.self));
}

/** The one pid of `found`, else null. */
const one = (found: Set<number>): number | null =>
  found.size === 1 ? [...found][0] : null;

/** lsof -F's answer: the pids whose client end is `port` (to `to`). */
function lsofPids(
  out: string,
  port: number,
  to: number | undefined,
  self: number,
): Set<number> {
  // -F: "p<pid>" starts a process, "n<local>-><remote>" each of its files.
  const found = new Set<number>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) {
      const [local = "", remote = ""] = line.slice(1).split("->");
      if (
        isLoopbackEnd(local, port) &&
        (to === undefined || isLoopbackEnd(remote, to)) &&
        pid !== self
      )
        found.add(pid);
    }
  }
  return found;
}

/** "127.0.0.1:52922" or "[::1]:52922" with that port. */
function isLoopbackEnd(end: string, port: number): boolean {
  const m = /^(.*):(\d+)$/.exec(end);
  if (!m || Number(m[2]) !== port) return false;
  const host = m[1].replace(/^\[|\]$/g, "");
  return (
    host === "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === "::ffff:127.0.0.1"
  );
}

function linuxPeer(
  port: number,
  to: number | undefined,
  o: ReturnType<typeof defaults>,
): number | null {
  const f = linuxPids(port, to, o);
  return f.miss ? null : one(f.pids);
}

/**
 * The pids holding the client end of `port` (to `to`) in /proc; `miss`
 * when there was no single socket to look for.
 */
function linuxPids(
  port: number,
  to: number | undefined,
  o: ReturnType<typeof defaults>,
): { pids: Set<number>; miss?: "none" | "several" } {
  const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  const hex = hex4(port);
  const toHex = to === undefined ? undefined : hex4(to);
  const inodes = new Set<string>();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = o.read(f);
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      // sl local rem st … inode (index 9); st 01 = ESTABLISHED.
      if (c.length < 10 || c[3] !== "01") continue;
      const [addr, p] = c[1].split(":");
      if (p !== hex || !linuxLoopback(addr)) continue;
      if (toHex !== undefined) {
        const [raddr, rp] = c[2].split(":");
        if (rp !== toHex || !linuxLoopback(raddr)) continue;
      }
      inodes.add(c[9]);
    }
  }
  if (inodes.size !== 1)
    return { pids: new Set(), miss: inodes.size ? "several" : "none" };
  const want = `socket:[${[...inodes][0]}]`;
  const found = new Set<number>();
  for (const name of o.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === o.self) continue;
    let fds: string[];
    try {
      fds = o.readdir(`/proc/${name}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (o.readlink(`/proc/${name}/fd/${fd}`) === want) {
          found.add(pid);
          break;
        }
      } catch {
        /* closed meanwhile */
      }
    }
  }
  return { pids: found };
}

/** /proc/net/tcp's hex address: 127.x.x.x (little-endian), ::1, ::ffff:127.0.0.1. */
function linuxLoopback(addr: string): boolean {
  if (addr.length === 8) return addr.endsWith("7F");
  return (
    addr === "00000000000000000000000001000000" ||
    /^0000000000000000FFFF0000[0-9A-F]{6}7F$/.test(addr)
  );
}

/**
 * Whether `pid` is `root` or runs under it (its parents, up to init).
 * False when a parent can't be read: not proved.
 */
export function descendsFrom(
  pid: number,
  root: number,
  d: PeerDeps = {},
): boolean {
  if (!(pid > 0) || !(root > 0)) return false;
  const o = defaults(d);
  let parent: (p: number) => number | null;
  try {
    if (o.platform === "linux") parent = procParent(o);
    else if (o.platform === "darwin") {
      const table = psTable(o.run(DARWIN_PS, ["-axo", "pid=,ppid="]));
      parent = (p) => table.get(p) ?? null;
    } else return false;
    let p: number | null = pid;
    for (let i = 0; i < 64 && p !== null && p > 1; i++) {
      if (p === root) return true;
      p = parent(p);
    }
    return p === root;
  } catch {
    return false;
  }
}

/**
 * `pid` and every parent up to init, or null when any of them can't be
 * read (or this platform can't tell): a line that is whole or nothing.
 */
export function parentLine(pid: number, d: PeerDeps = {}): number[] | null {
  if (!(pid > 0)) return null;
  const o = defaults(d);
  try {
    let parent: (p: number) => number | null;
    if (o.platform === "linux") parent = procParent(o);
    else if (o.platform === "darwin") {
      const table = psTable(o.run(DARWIN_PS, PS_ARGS));
      if (!table.has(pid)) return null;
      parent = (p) => table.get(p) ?? null;
    } else return null;
    const line = [pid];
    let p = pid;
    for (let i = 0; i < 64; i++) {
      if (p <= 1) return line;
      const q = parent(p);
      if (q === null || !(q >= 0)) return null;
      if (q > 0) line.push(q);
      p = q;
    }
    return null;
  } catch {
    return null;
  }
}

/** A pid's parent from /proc/<pid>/stat. */
const procParent =
  (o: { read: (p: string) => string }) =>
  (p: number): number | null => {
    const s = o.read(`/proc/${p}/stat`);
    // pid (comm) state ppid …: comm may hold spaces and parens.
    const rest = s.slice(s.lastIndexOf(")") + 2).split(" ");
    const pp = Number(rest[1]);
    return Number.isInteger(pp) ? pp : null;
  };

/** `ps -axo pid=,ppid=` as pid → parent. */
function psTable(out: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of out.split("\n")) {
    const [a, b] = line.trim().split(/\s+/).map(Number);
    if (a > 0 && Number.isInteger(b)) table.set(a, b);
  }
  return table;
}

/** `pid` and its parents, up to init (at most 64). */
function lineOf(pid: number, parent: (p: number) => number | null): number[] {
  const line = [pid];
  let p: number | null = pid;
  for (let i = 0; i < 64 && p !== null && p > 1; i++) {
    try {
      p = parent(p);
    } catch {
      p = null;
    }
    if (p !== null && p > 0) line.push(p);
  }
  return line;
}

const PS_ARGS = ["-axo", "pid=,ppid="];
let PS: { at: number; out: Promise<string> } | null = null;

/**
 * One `ps` snapshot for every lookup asked at or before it started: a
 * burst of connections (agents restarting together) shares it. The
 * caller was connected when it was asked, so it is in the snapshot.
 */
function sharedPs(asked: number): Promise<string> {
  if (PS && PS.at >= asked) return PS.out;
  PS = { at: Date.now(), out: runAsync(DARWIN_PS, PS_ARGS) };
  return PS.out;
}

export interface AsyncPeerDeps extends Omit<PeerDeps, "run"> {
  /** Runs a lookup command without holding the event loop ("" for nothing). */
  run?: (cmd: string, args: string[]) => Promise<string>;
}

/**
 * Issue 242: a lookup that never holds the event loop. Each try has the
 * lookup timeouts' limit; a lookup that ran and found nothing, failed or
 * still timed out: "".
 */
export async function runAsync(
  cmd: string,
  args: string[],
  timeouts: readonly number[] = lookupTimeouts(),
): Promise<string> {
  for (const timeout of timeouts) {
    const r = await new Promise<{ out: string; timedOut: boolean }>((res) => {
      execFile(cmd, args, { encoding: "utf8", timeout }, (err, stdout) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        res({
          out: e ? "" : stdout,
          timedOut: !!e && (e.killed === true || e.code === "ETIMEDOUT"),
        });
      });
    });
    if (!r.timedOut) return r.out;
  }
  return "";
}

/**
 * Issue 609: runAsync that tells why it has no answer: throws
 * LookupTimeoutError when every try timed out, and the error when the
 * command couldn't run. A command that ran and exited non-zero (lsof's
 * "no match") answers its output, "" for nothing.
 */
export async function runAsyncStrict(
  cmd: string,
  args: string[],
  timeouts: readonly number[] = lookupTimeouts(),
): Promise<string> {
  for (const timeout of timeouts) {
    const r = await new Promise<
      { out: string } | { timedOut: true } | { error: Error }
    >((res) => {
      execFile(cmd, args, { encoding: "utf8", timeout }, (err, stdout) => {
        if (!err) return res({ out: stdout });
        const { killed, code } = err as { killed?: boolean; code?: unknown };
        if (killed === true || code === "ETIMEDOUT")
          return res({ timedOut: true });
        // It ran and said no (an exit status): its output.
        if (typeof code === "number") return res({ out: stdout ?? "" });
        res({ error: err });
      });
    });
    if ("out" in r) return r.out;
    if ("error" in r) throw r.error;
  }
  throw new LookupTimeoutError(cmd);
}

/**
 * Issue 609: why no single caller was found. timeout: the lookup took too
 * long; failed: it couldn't run; none: no connection matched (the caller
 * had closed it, or never held it); several: more than one did.
 */
export type LookupMiss = "timeout" | "failed" | "none" | "several";

/** A caller's line of parents, or why there is none. */
export type PeerFind = { line: number[] } | { miss: LookupMiss };

const missOf = (e: unknown): LookupMiss =>
  e instanceof LookupTimeoutError ? "timeout" : "failed";

/**
 * Issue 242: loopbackPeerPid without holding the event loop, and with the
 * caller's line of parents taken at the same moment: [pid, its parent, …].
 * Run when the connection arrives, the caller is still there; its line
 * then answers "inside this session?" however late the request is read.
 * Issue 609: with no single caller, why (LookupMiss).
 */
export async function loopbackPeerFind(
  port: number,
  to: number | undefined,
  d: AsyncPeerDeps = {},
): Promise<PeerFind> {
  if (!validPort(port)) return { miss: "none" };
  if (to !== undefined && !validPort(to)) return { miss: "none" };
  const platform = d.platform ?? process.platform;
  const self = d.self ?? process.pid;
  const asked = Date.now();
  if (platform === "darwin") {
    const run = d.run ?? ((c: string, a: string[]) => runAsyncStrict(c, a));
    let pids: Set<number>;
    try {
      pids = lsofPids(await run(DARWIN_LSOF, lsofArgs(port)), port, to, self);
    } catch (e) {
      return { miss: missOf(e) };
    }
    if (pids.size !== 1) return { miss: pids.size ? "several" : "none" };
    const pid = [...pids][0];
    try {
      const table = psTable(
        await (d.run ? run(DARWIN_PS, PS_ARGS) : sharedPs(asked)),
      );
      return { line: lineOf(pid, (p) => table.get(p) ?? null) };
    } catch {
      // The caller is known; its parents are checked when judged.
      return { line: [pid] };
    }
  }
  if (platform === "linux") {
    try {
      // /proc reads: quick, and done at once, while the caller is there.
      const o = defaults({ ...d, run: () => "" });
      const f = linuxPids(port, to, o);
      if (f.miss) return { miss: f.miss };
      if (f.pids.size !== 1) return { miss: f.pids.size ? "several" : "none" };
      return { line: lineOf([...f.pids][0], procParent(o)) };
    } catch {
      return { miss: "failed" };
    }
  }
  return { miss: "failed" };
}

/** loopbackPeerFind's line, or null when no single caller was found. */
export async function loopbackPeerLine(
  port: number,
  to: number | undefined,
  d: AsyncPeerDeps = {},
): Promise<number[] | null> {
  const f = await loopbackPeerFind(port, to, d);
  return "line" in f ? f.line : null;
}
