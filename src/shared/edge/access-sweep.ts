/**
 * #63: Den's side of the edge's access log. Traefik appends raw JSON lines
 * to `<edge state dir>/access/access.json` (0600, in a 0700 dir); Den's
 * server sweeps it every second: each line masked (access-log.ts) into
 * `edge-access.log` (0600, rotated past `edge.access_log.max_mb`), then
 * the raw file emptied. Lines that aren't Traefik's are dropped, never kept.
 *
 * The raw file holds unmasked one-time tokens until a sweep, so the server
 * sweeps it before anything else at startup, and `rawAccessWarning` tells
 * doctor and `edge status` when sweeps have stopped. Issue 637: each sweep
 * touches access/swept (its heartbeat), so doctor, in another process,
 * can tell "busy" from "not swept": nothing masks the lines only when no
 * sweep ran within 10 s (or ever). Size alone (edge.access_log.raw_warn_kb)
 * says the file is large, never that nothing masks it.
 */
import * as fs from "fs";
import * as path from "path";
import { product } from "../product.js";
import {
  maskAccessLine,
  RAW_WARN_KB_DEFAULT,
  type AccessLogConfig,
} from "./access-log.js";

export const RAW_STALE_MS = 10_000;

export function accessPaths(stateDir: string): {
  dir: string;
  raw: string;
  log: string;
  swept: string;
} {
  const dir = path.join(stateDir, "access");
  return {
    dir,
    raw: path.join(dir, "access.json"),
    log: path.join(stateDir, "edge-access.log"),
    // Issue 637: the sweep's heartbeat (its mtime), empty.
    swept: path.join(dir, "swept"),
  };
}

/** Issue 637: the sweep's heartbeat touched (made empty, 0600, if none). */
function touchSwept(file: string): void {
  try {
    fs.closeSync(fs.openSync(file, "a", 0o600));
    const t = new Date();
    fs.utimesSync(file, t, t);
  } catch {
    /* the dir went: no access log, nothing to say */
  }
}

/** When the last sweep ran (ms), or null: never, or unreadable. */
function lastSweep(stateDir: string): number | null {
  try {
    return fs.statSync(accessPaths(stateDir).swept).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The raw file made before the edge starts, so Den owns it at 0600 (else
 * Traefik makes it, as root, readable by all) in a 0700 dir.
 */
export function prepareAccessRaw(stateDir: string): void {
  const p = accessPaths(stateDir);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.dir, 0o700);
  fs.closeSync(fs.openSync(p.raw, "a", 0o600));
  fs.chmodSync(p.raw, 0o600);
}

function appendKept(file: string, text: string, maxMb: number): void {
  try {
    if (fs.statSync(file).size + text.length > maxMb * 1024 * 1024)
      fs.renameSync(file, `${file}.1`);
  } catch {
    /* none yet */
  }
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Where the unswept lines start. Emptied under it, Traefik keeps writing at
 * its own offset when the file reaches it through a Docker VM's file share
 * (Docker Desktop, OrbStack): the file then starts with a hole of NULs as
 * long as what was swept. On a native Linux Docker it writes from 0 again.
 * `hint` is where the last sweep emptied it; else the hole is scanned.
 */
const lastCut = new Map<string, number>();
function dataStart(fd: number, size: number, hint = 0): number {
  const one = Buffer.alloc(1);
  const at = (i: number) => (fs.readSync(fd, one, 0, 1, i) === 1 ? one[0] : -1);
  if (size === 0 || at(0) !== 0) return 0;
  if (hint > 0 && hint <= size && at(hint - 1) === 0 && at(hint) !== 0)
    return hint;
  const chunk = Buffer.alloc(64 * 1024);
  for (let pos = 0; pos < size; pos += chunk.length) {
    const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
    for (let i = 0; i < n; i++) if (chunk[i] !== 0) return pos + i;
    if (n === 0) break;
  }
  return size;
}

/**
 * One sweep: the raw file's lines masked into edge-access.log, then the
 * raw file emptied. Emptied only when its size is still what was read
 * (else read again: Traefik wrote meanwhile), and only after a whole line
 * (a part line means Traefik is mid-write: the next sweep takes it).
 */
export function sweepAccessLog(
  stateDir: string,
  cfg: Pick<AccessLogConfig, "maskQuery" | "maskPaths" | "maxMb">,
): { kept: number; dropped: number } {
  const p = accessPaths(stateDir);
  let fd: number;
  try {
    fd = fs.openSync(p.raw, "r+");
  } catch {
    return { kept: 0, dropped: 0 }; // no raw file: the access log is off
  }
  let kept = 0;
  let dropped = 0;
  try {
    for (let pass = 0; pass < 5; pass++) {
      const size = fs.fstatSync(fd).size;
      if (size === 0) break;
      const start = dataStart(fd, size, lastCut.get(p.raw));
      const buf = Buffer.alloc(size - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      // NULs never belong to a line: a hole left by an earlier empty.
      const text = buf.subarray(0, n).toString("utf-8").replace(/\0+/g, "");
      if (text && !text.endsWith("\n")) break;
      if (fs.fstatSync(fd).size !== size && pass < 4) continue;
      const out: string[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const m = maskAccessLine(line, cfg);
        if (m === null) dropped++;
        else out.push(m);
      }
      if (out.length) appendKept(p.log, out.join("\n") + "\n", cfg.maxMb);
      kept += out.length;
      fs.ftruncateSync(fd, 0);
      lastCut.set(p.raw, size);
      break;
    }
  } finally {
    fs.closeSync(fd);
  }
  touchSwept(p.swept);
  return { kept, dropped };
}

/** Bytes of unswept lines in the raw file (its NUL hole not counted). */
function unsweptBytes(file: string): number {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return 0;
  }
  try {
    const size = fs.fstatSync(fd).size;
    return size - dataStart(fd, size, lastCut.get(file));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A warning when the raw file is not being swept, or (issue 637) is
 * larger than `rawWarnKb` while it is. Null when it's empty or absent.
 * Not swept: unmasked lines, and no sweep within RAW_STALE_MS, or never.
 */
export function rawAccessWarning(
  stateDir: string,
  now: number = Date.now(),
  rawWarnKb: number = RAW_WARN_KB_DEFAULT,
): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(accessPaths(stateDir).raw);
  } catch {
    return null;
  }
  const bytes = st.size && unsweptBytes(accessPaths(stateDir).raw);
  if (bytes === 0) return null;
  const swept = lastSweep(stateDir);
  const ago = (t: number) =>
    `${Math.max(0, Math.round((now - t) / 1000))} s ago`;
  if (swept !== null && now - swept <= RAW_STALE_MS) {
    if (bytes <= rawWarnKb * 1024) return null;
    return (
      `the edge's raw access log holds ${Math.round(bytes / 1024)} KB of unmasked lines, over edge.access_log.raw_warn_kb (${rawWarnKb}). ` +
      `${product().title} is sweeping it (last sweep ${ago(swept)}); lines arrive faster than one sweep a second empties them. ` +
      `If this edge is this busy, raise edge.access_log.raw_warn_kb.`
    );
  }
  return (
    `the edge's raw access log has ${bytes} bytes of unmasked lines` +
    (swept === null ? ", never swept" : `, last swept ${ago(swept)}`) +
    `: nothing is masking it. Start ${product().title} (${product().cli} web up); it masks and empties the file first.`
  );
}

/**
 * Doctor's and `edge status`'s access-log warnings: an `edge.args`
 * `--accesslog` (Traefik's own log: every path and query, unmasked, past
 * Den), and the raw file not being swept.
 */
/**
 * #63: doctor's line when the access log is on and nothing is wrong with
 * it (no warnings): where the masked log is. Null otherwise.
 */
export function edgeAccessHealthy(
  cfg: {
    args: string[];
    stateDir: string;
    accessLog?: { enabled: boolean; rawWarnKb?: number };
  },
  now: number = Date.now(),
): string | null {
  if (cfg.accessLog?.enabled !== true) return null;
  if (edgeAccessWarnings(cfg, now).length) return null;
  const log = `access log on: masked into ${accessPaths(cfg.stateDir).log}`;
  // Issue 637: when the server is sweeping, say so, with the last sweep.
  const swept = lastSweep(cfg.stateDir);
  if (swept === null) return `${log}, and kept up with`;
  const ago = `${Math.max(0, Math.round((now - swept) / 1000))} s ago`;
  return now - swept <= RAW_STALE_MS
    ? `${log}; ${product().title} is sweeping it (last sweep ${ago})`
    : `${log}, and kept up with (last sweep ${ago})`;
}

export function edgeAccessWarnings(
  cfg: {
    args: string[];
    stateDir: string;
    accessLog?: { rawWarnKb?: number };
  },
  now: number = Date.now(),
): string[] {
  const out: string[] = [];
  if (cfg.args.some((a) => /^--accesslog(\.|=|$)/i.test(a)))
    out.push(
      "edge.args sets --accesslog: Traefik then logs every path and query as is, one-time tokens included, where Den can't mask them. Remove it and set edge.access_log: true; Den keeps a masked edge-access.log.",
    );
  const raw = rawAccessWarning(cfg.stateDir, now, cfg.accessLog?.rawWarnKb);
  if (raw) out.push(raw);
  return out;
}
