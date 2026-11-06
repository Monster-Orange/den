/**
 * Records from before 0.3.0-dev.37 (0.3.0-dev.38, a consumer's dev.37
 * finding). A daemon record written before `up` recorded process groups has
 * no pgid, and often no pid either, while the service it describes may still
 * be running (a vite on its strict port). `up` and `down` decide what such a
 * record means through adoptLegacyProcess, once:
 *
 *   1. port first: when the service has a known port (servicePort), the
 *      process listening on it, if its cwd is inside the record's repoPath,
 *      is the service. Den adopts its process group: the listener's pgid
 *      and the group leader's start time (the listener's own when the
 *      leader has gone).
 *   2. else a recorded pid that is alive, when every token of the
 *      configured up command (leading VAR=value assignments and an `npx` /
 *      `npm exec` prefix stripped) appears in the argv of some process in
 *      that pid's group: adopted the same way.
 *   3. else the record is stale: nothing is signalled. A listener on the
 *      port from outside repoPath is reported (`busy`), never touched.
 *
 * Nothing here signals a process. `ps` and `lsof` run under LC_ALL=C.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { RecordedProcessGroup } from "./process-group.js";

const C_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      env: C_ENV,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch (e) {
    // lsof and ps exit 1 when nothing matches; what they printed still counts.
    const out = (e as { stdout?: unknown }).stdout;
    return typeof out === "string" ? out : null;
  }
}

/** The host tools, injectable for tests of the decision alone. */
export interface LegacyProbe {
  /** Pids listening on TCP `port`. */
  listeners(port: number): number[];
  /** A process's cwd, or null. */
  cwd(pid: number): string | null;
  /** Every live process: pid, pgid, start time, argv (one line). */
  processes(): ProcRow[];
}

export interface ProcRow {
  pid: number;
  pgid: number;
  lstart: string;
  command: string;
}

export const hostProbe: LegacyProbe = {
  listeners(port) {
    const out = run("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"]) ?? "";
    return out
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  },
  cwd(pid) {
    const out = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = out?.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  },
  processes() {
    // lstart is five words in the C locale: "Thu Nov  5 10:00:00 2026".
    const out = run("ps", ["-A", "-o", "pid=,pgid=,stat=,lstart=,command="]);
    const rows: ProcRow[] = [];
    for (const line of (out ?? "").split("\n")) {
      const m = line
        .trim()
        .match(
          /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/,
        );
      if (!m || m[3].startsWith("Z")) continue;
      rows.push({
        pid: Number(m[1]),
        pgid: Number(m[2]),
        lstart: m[4].replace(/\s+/g, " "),
        command: m[5],
      });
    }
    return rows;
  },
};

/** A shell command's words, quotes removed (enough to compare, not to run). */
export function shellWords(cmd: string): string[] {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The tokens a running up must show: the up command's words without the
 * leading VAR=value assignments and an `npx` / `npm exec` prefix (npm runs
 * the binary under its own name, `node …/.bin/vite`).
 */
export function upTokens(upCommand: string): string[] {
  const words = shellWords(upCommand);
  let i = 0;
  while (i < words.length && ASSIGN.test(words[i])) i++;
  if (words[i] === "npx") {
    i++;
    // npx's own flags (`npx --yes vite`) are npx's, not the service's.
    while (i < words.length && words[i].startsWith("-")) i++;
  } else if (words[i] === "npm" && words[i + 1] === "exec") i += 2;
  return words.slice(i);
}

/** Whether `token` is one of the argv words of `command` (or its basename). */
function inArgv(token: string, command: string): boolean {
  if (/\s/.test(token)) return command.includes(token);
  return shellWords(command).some(
    (w) => w === token || w.endsWith(`/${token}`) || w === `--${token}`,
  );
}

/**
 * A service's known port, the first found of: an explicit `port`, the port
 * in its health URL (localhost or 127.0.0.1 forms), a `--port N`,
 * `--port=N` or `-p N` in its up command.
 */
export function servicePort(svc: {
  port?: unknown;
  healthUrl?: string | null;
  upCommand?: string | null;
}): number | null {
  const ok = (n: number): number | null =>
    Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  if (svc.port !== undefined && svc.port !== null) {
    const p = ok(Number(svc.port));
    if (p) return p;
  }
  if (svc.healthUrl) {
    try {
      const u = new URL(svc.healthUrl);
      if (u.port) {
        const p = ok(Number(u.port));
        if (p) return p;
      }
    } catch {
      /* not a URL */
    }
  }
  const words = shellWords(svc.upCommand ?? "");
  for (let i = 0; i < words.length; i++) {
    const eq = words[i].match(/^--port=(\d+)$/);
    if (eq) return ok(Number(eq[1]));
    if ((words[i] === "--port" || words[i] === "-p") && words[i + 1]) {
      const p = ok(Number(words[i + 1]));
      if (p) return p;
    }
  }
  return null;
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function inside(dir: string, root: string): boolean {
  const d = realOrSelf(dir);
  const r = realOrSelf(root);
  return d === r || d.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

export type LegacyVerdict =
  | {
      kind: "adopted";
      group: RecordedProcessGroup;
      /** The listener (port) or the recorded pid. */
      pid: number;
      port: number | null;
    }
  | {
      kind: "stale";
      /** A listener on the port Den won't adopt: left alone. */
      busy?: LegacyBusy;
    };

/**
 * A listener on the service's port that is not adopted: its cwd is outside
 * repoPath ("outside"), or it is in the repo but in Den's own process group
 * ("own-group": stopping that group would stop Den) or in init's ("init").
 */
export interface LegacyBusy {
  port: number;
  pid: number;
  cwd: string | null;
  reason: "outside" | "own-group" | "init";
}

/** Why a busy port's listener is not `address`, for a warning line. */
export function busyListenerText(
  busy: LegacyBusy,
  repoPath: string,
  address: string,
): string {
  const head =
    `port ${busy.port} is in use by pid ${busy.pid}` +
    (busy.cwd ? ` (cwd ${busy.cwd})` : "");
  if (busy.reason === "own-group")
    return `${head}, in Den's own process group; not adopted`;
  if (busy.reason === "init")
    return `${head}, in process group 1 (init); not adopted`;
  return `${head}, outside ${repoPath}: not ${address}, left alone`;
}

/** The group of `member`, as `down` records one: leader's start, else its own. */
function groupOf(
  member: ProcRow,
  rows: ProcRow[],
): RecordedProcessGroup | null {
  // Never adopt Den's own group or init's.
  if (member.pgid <= 1) return null;
  const own = rows.find((r) => r.pid === process.pid);
  if (own && own.pgid === member.pgid) return null;
  const leader = rows.find((r) => r.pid === member.pgid);
  if (!leader) {
    // The leader is gone: the group is recorded by the member that leads it
    // now in the record's sense (classifyGroup accepts any live member).
    return { pgid: member.pgid, startedAt: member.lstart };
  }
  return { pgid: member.pgid, startedAt: leader.lstart };
}

export function adoptLegacyProcess(
  rec: {
    repoPath: string;
    pid?: number;
    port: number | null;
    upCommand: string | null;
  },
  probe: LegacyProbe = hostProbe,
): LegacyVerdict {
  let rows: ProcRow[] | null = null;
  const procs = (): ProcRow[] => (rows ??= probe.processes());
  let busy: LegacyBusy | undefined;

  if (rec.port) {
    for (const pid of probe.listeners(rec.port)) {
      const cwd = probe.cwd(pid);
      const row = procs().find((r) => r.pid === pid);
      let reason: LegacyBusy["reason"] = "outside";
      if (cwd && row && inside(cwd, rec.repoPath)) {
        const group = groupOf(row, procs());
        if (group) return { kind: "adopted", group, pid, port: rec.port };
        reason = row.pgid <= 1 ? "init" : "own-group";
      }
      busy ??= { port: rec.port, pid, cwd, reason };
    }
  }

  if (typeof rec.pid === "number" && rec.pid > 0 && rec.upCommand) {
    const row = procs().find((r) => r.pid === rec.pid);
    const tokens = upTokens(rec.upCommand);
    if (row && tokens.length) {
      const members = procs().filter((r) => r.pgid === row.pgid);
      if (tokens.every((t) => members.some((m) => inArgv(t, m.command)))) {
        const group = groupOf(row, procs());
        if (group) return { kind: "adopted", group, pid: row.pid, port: null };
      }
    }
  }

  return busy ? { kind: "stale", busy } : { kind: "stale" };
}
