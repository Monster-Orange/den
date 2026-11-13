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
 */
import * as fs from "fs";
import { spawnSync } from "child_process";
import { lookup, LookupTimeoutError } from "../ui/cli/proc-lookup.js";

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
 * port is `port` (the server sees it as the socket's remotePort). Null:
 * none found, more than one, or this platform can't tell.
 */
export function loopbackPeerPid(port: number, d: PeerDeps = {}): number | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const o = defaults(d);
  try {
    if (o.platform === "darwin") return darwinPeer(port, o);
    if (o.platform === "linux") return linuxPeer(port, o);
  } catch {
    return null;
  }
  return null;
}

function darwinPeer(
  port: number,
  o: ReturnType<typeof defaults>,
): number | null {
  const out = o.run(DARWIN_LSOF, [
    "-nP",
    "-w",
    `-iTCP:${port}`,
    "-sTCP:ESTABLISHED",
    "-a",
    "-Fpn",
  ]);
  // -F: "p<pid>" starts a process, "n<local>-><remote>" each of its files.
  const found = new Set<number>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) {
      const local = line.slice(1).split("->")[0] ?? "";
      if (isLoopbackEnd(local, port) && pid !== o.self) found.add(pid);
    }
  }
  return found.size === 1 ? [...found][0] : null;
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
  o: ReturnType<typeof defaults>,
): number | null {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
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
      inodes.add(c[9]);
    }
  }
  if (inodes.size !== 1) return null;
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
  return found.size === 1 ? [...found][0] : null;
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
    if (o.platform === "linux") {
      parent = (p) => {
        const s = o.read(`/proc/${p}/stat`);
        // pid (comm) state ppid …: comm may hold spaces and parens.
        const rest = s.slice(s.lastIndexOf(")") + 2).split(" ");
        const pp = Number(rest[1]);
        return Number.isInteger(pp) ? pp : null;
      };
    } else if (o.platform === "darwin") {
      const table = new Map<number, number>();
      for (const line of o.run(DARWIN_PS, ["-axo", "pid=,ppid="]).split("\n")) {
        const [a, b] = line.trim().split(/\s+/).map(Number);
        if (a > 0 && Number.isInteger(b)) table.set(a, b);
      }
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
