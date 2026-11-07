/**
 * Polling-loop warning (den#5) for `<cli> doctor`: one command, run from
 * one place, more than POLL_LIMIT times in any POLL_WINDOW_MS window looks
 * like an agent polling it. Local only: it reads the tail of the local
 * .dev-metrics/events.jsonl and sends nothing anywhere.
 *
 * A line's place is its `cwd` (emit.ts). An older line has none, so it is
 * keyed by its `repo` instead.
 */
import * as fs from "fs";

/** More calls than this in one window is a polling loop. */
export const POLL_LIMIT = 600;
/** The window: an hour. */
export const POLL_WINDOW_MS = 60 * 60 * 1000;
/** At most this much of the file's end is read, however big it is. */
export const TAIL_BYTES = 8 * 1024 * 1024;

/**
 * The file's last `max` bytes as whole lines: a line cut by the start of
 * the slice is dropped. A missing or unreadable file is no lines.
 */
export function readTailLines(
  file: string,
  max: number = TAIL_BYTES,
): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, size - len + got);
      if (n <= 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString("utf-8").split("\n");
    if (len < size) lines.shift();
    return lines.filter((l) => l.trim());
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface PollingLoop {
  command: string;
  /** Where: the line's cwd, or `repo <name>` for an older line. */
  where: string;
  /** Calls in the busiest window. */
  calls: number;
  /** The busiest window's first and last call (ISO, no millis). */
  from: string;
  to: string;
}

const iso = (ms: number): string =>
  new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/**
 * Every command+place with more than `limit` calls in some `windowMs`
 * window, with its busiest window. Lines that aren't JSON, or have no
 * command or time, are skipped.
 */
export function findPollingLoops(
  lines: string[],
  limit: number = POLL_LIMIT,
  windowMs: number = POLL_WINDOW_MS,
): PollingLoop[] {
  const byKey = new Map<
    string,
    { command: string; where: string; times: number[] }
  >();
  for (const line of lines) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const command = typeof o.command === "string" ? o.command : "";
    const t = typeof o.ts === "string" ? Date.parse(o.ts) : NaN;
    if (!command || Number.isNaN(t)) continue;
    const where =
      typeof o.cwd === "string" && o.cwd
        ? o.cwd
        : `repo ${typeof o.repo === "string" && o.repo ? o.repo : "?"}`;
    const key = `${command}\u0000${where}`;
    let e = byKey.get(key);
    if (!e) byKey.set(key, (e = { command, where, times: [] }));
    e.times.push(t);
  }
  const out: PollingLoop[] = [];
  for (const { command, where, times } of byKey.values()) {
    if (times.length <= limit) continue;
    times.sort((a, b) => a - b);
    let best = 0;
    let bi = 0;
    let bj = 0;
    for (let i = 0, j = 0; j < times.length; j++) {
      while (times[j] - times[i] >= windowMs) i++;
      if (j - i + 1 > best) {
        best = j - i + 1;
        bi = i;
        bj = j;
      }
    }
    if (best > limit)
      out.push({
        command,
        where,
        calls: best,
        from: iso(times[bi]),
        to: iso(times[bj]),
      });
  }
  return out.sort((a, b) => b.calls - a.calls);
}

/** One warning line, as doctor prints it. */
export function pollingWarning(p: PollingLoop): string {
  return `looks like a polling loop: ${p.command} in ${p.where}, ${p.calls} calls in an hour (${p.from}–${p.to})`;
}

/** doctor's warnings for this events file (none when it is fine or absent). */
export function pollingWarnings(
  file: string,
  max: number = TAIL_BYTES,
): string[] {
  return findPollingLoops(readTailLines(file, max)).map(pollingWarning);
}
