/**
 * Reading a session's name from what a runtime writes (AG-4b), without
 * ever reading a whole file at once:
 *
 *   - transcriptTitle(file): the latest `{"type":"custom-title",
 *     "customTitle":…}` record in a JSON-lines transcript (Claude Code's
 *     `/rename`). Each ask reads on from where the last one stopped, at
 *     most FOLLOW_MAX_BYTES, so a long transcript is caught up over a few
 *     asks; a file that got shorter is read again from the start. Only
 *     lines that mention "custom-title" are parsed. Any failure is null.
 *   - transcriptCompactions(file, readMaxBytes) (issue 278): the
 *     compactions Claude Code recorded (its compact_boundary records),
 *     followed the same way, starting near the end of a long transcript.
 *   - oscTitles(chunk, carry): the terminal titles (OSC 0 and OSC 2) in a
 *     PTY's output, for runtimes the catalog marks `titleFromOsc`.
 *
 * A name is cleaned for the page: control, format and line-separator
 * characters go, spaces are squeezed, and it is cut at MAX_NAME.
 */
import * as fs from "fs";

/** The most one ask reads of a transcript. */
export const FOLLOW_MAX_BYTES = 1024 * 1024;
const CHUNK = 64 * 1024;
/** A line longer than this is no record Den reads here: skipped to its end. */
const MAX_LINE = 64 * 1024;
/** The longest name kept. */
export const MAX_NAME = 80;
const FOLLOW_CACHE_BYTES = 64 * 1024 * 1024;

interface Follow<T> {
  offset: number;
  state: T;
  /** The start of a line whose newline hasn't come yet. */
  rest: Buffer;
  /** Inside a line too long to be a record Den reads: drop bytes to its newline. */
  skipping: boolean;
  bytes: number;
}

/** One kind of record followed through transcripts: its files and how far each is read. */
interface Follower<T> {
  files: Map<string, Follow<T>>;
  bytes: number;
  /** Only lines with this in them are parsed. */
  needle: string;
  init: () => T;
  /** The state after `line` (one whole line, without its newline). */
  onLine: (line: Buffer, state: T) => T;
}

const titles: Follower<string | null> = {
  files: new Map(),
  bytes: 0,
  needle: "custom-title",
  init: () => null,
  onLine: (line, state) => titleOf(line) ?? state,
};

/** A name as the page may show it, or null when nothing is left. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return [...s].slice(0, MAX_NAME).join("").trim() || null;
}

function titleOf(line: Buffer): string | undefined {
  try {
    const rec = JSON.parse(line.toString("utf-8")) as {
      type?: unknown;
      customTitle?: unknown;
    };
    if (rec?.type !== "custom-title") return undefined;
    return cleanName(rec.customTitle) ?? undefined;
  } catch {
    return undefined;
  }
}

function unfollow<T>(f: Follower<T>, file: string): void {
  const s = f.files.get(file);
  if (!s) return;
  f.bytes -= s.bytes;
  f.files.delete(file);
}

/**
 * Reads `file` on from where `f` last stopped (at most `maxBytes` per ask;
 * a first ask starts `startBack` bytes from the end, or at the start), and
 * returns the follower's state for it, or null on any failure.
 */
function follow<T>(
  f: Follower<T>,
  file: string,
  maxBytes = FOLLOW_MAX_BYTES,
  startBack = Infinity,
): T | null {
  let fd: number | undefined;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) {
      unfollow(f, file);
      return null;
    }
    let s = f.files.get(file);
    if (!s || st.size < s.offset) {
      unfollow(f, file);
      const offset = Math.max(0, st.size - startBack);
      // Started mid-file: the first line read is a piece of one.
      s = {
        offset,
        state: f.init(),
        rest: Buffer.alloc(0),
        skipping: offset > 0,
        bytes: 0,
      };
    }
    f.files.delete(file);
    f.files.set(file, s);
    if (st.size === s.offset) return s.state;
    fd = fs.openSync(file, "r");
    const end = Math.min(st.size, s.offset + maxBytes);
    const buf = Buffer.alloc(CHUNK);
    while (s.offset < end) {
      const n = fs.readSync(
        fd,
        buf,
        0,
        Math.min(CHUNK, end - s.offset),
        s.offset,
      );
      if (n <= 0) break;
      s.offset += n;
      let data = buf.subarray(0, n);
      for (;;) {
        const nl = data.indexOf(0x0a);
        if (nl < 0) {
          if (!s.skipping) {
            s.rest = Buffer.concat([s.rest, data]);
            if (s.rest.length > MAX_LINE) {
              s.rest = Buffer.alloc(0);
              s.skipping = true;
            }
          }
          break;
        }
        const piece = data.subarray(0, nl);
        data = data.subarray(nl + 1);
        if (s.skipping) {
          s.skipping = false;
          continue;
        }
        const line = s.rest.length ? Buffer.concat([s.rest, piece]) : piece;
        s.rest = Buffer.alloc(0);
        if (line.includes(f.needle)) s.state = f.onLine(line, s.state);
      }
    }
    f.bytes -= s.bytes;
    s.bytes = 256 + s.rest.length + 2 * (JSON.stringify(s.state)?.length ?? 0);
    f.bytes += s.bytes;
    for (const k of f.files.keys()) {
      if (f.bytes <= FOLLOW_CACHE_BYTES || k === file) break;
      unfollow(f, k);
    }
    return s.state;
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
  }
}

/** The latest custom-title in `file` (read on from the last ask), or null. */
export function transcriptTitle(file: string): string | null {
  return follow(titles, file);
}

/** One compaction Claude Code recorded: when, and whether it was automatic. */
export interface Compaction {
  /** ms since the epoch. */
  at: number;
  auto: boolean;
}

/** The most compactions kept per transcript (the newest). */
const MAX_COMPACTIONS = 200;

/**
 * Issue 278: a `{"type":"system","subtype":"compact_boundary",
 * "compactMetadata":{"trigger":"auto"|"manual",…},"timestamp":…}` record.
 */
function compactionOf(line: Buffer): Compaction | undefined {
  try {
    const rec = JSON.parse(line.toString("utf-8")) as {
      type?: unknown;
      subtype?: unknown;
      timestamp?: unknown;
      compactMetadata?: { trigger?: unknown };
    };
    if (rec?.type !== "system" || rec.subtype !== "compact_boundary")
      return undefined;
    const at =
      typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isFinite(at)) return undefined;
    return { at, auto: rec.compactMetadata?.trigger === "auto" };
  } catch {
    return undefined;
  }
}

const compactions: Follower<Compaction[]> = {
  files: new Map(),
  bytes: 0,
  needle: "compact_boundary",
  init: () => [],
  onLine: (line, state) => {
    const c = compactionOf(line);
    if (!c) return state;
    const next = [...state, c];
    return next.length > MAX_COMPACTIONS ? next.slice(-MAX_COMPACTIONS) : next;
  },
};

/**
 * Issue 278: the compactions recorded in `file` (its compact_boundary
 * records), oldest first. A first ask reads only the last `readMaxBytes`
 * (the caller's D39 limit): older ones can't be part of a loop happening now. Each
 * later ask reads on from where the last stopped. Null on any failure.
 */
export function transcriptCompactions(
  file: string,
  readMaxBytes: number,
): Compaction[] | null {
  const got = follow(compactions, file, readMaxBytes, readMaxBytes);
  return got ? [...got] : null;
}

/** Where a followed file is up to (tests). */
export function followState(file: string): { offset: number } | undefined {
  const f = titles.files.get(file);
  return f ? { offset: f.offset } : undefined;
}

/** Forget every followed file (tests). */
export function resetFollowers(): void {
  titles.files.clear();
  compactions.files.clear();
  titles.bytes = 0;
  compactions.bytes = 0;
}

/** The most of an unended OSC kept between chunks. */
const MAX_CARRY = 1024;
const OSC_START = "\u001b]";

/**
 * The terminal titles (OSC 0 and OSC 2, ended by BEL or ST) in `chunk`,
 * with `carry` the unended OSC the last chunk left; returns what this one
 * leaves. Every other OSC (a link, the cwd) is not a title.
 */
export function oscTitles(
  chunk: string,
  carry: string,
): { titles: string[]; carry: string } {
  const s = carry + chunk;
  const titles: string[] = [];
  let i = 0;
  for (;;) {
    const at = s.indexOf(OSC_START, i);
    if (at < 0) {
      // A lone ESC at the very end may start an OSC in the next chunk.
      return { titles, carry: s.endsWith("\u001b") ? "\u001b" : "" };
    }
    const bel = s.indexOf("\u0007", at + 2);
    const st = s.indexOf("\u001b\\", at + 2);
    const ends = [bel, st].filter((x) => x >= 0);
    if (!ends.length) return { titles, carry: s.slice(at, at + MAX_CARRY) };
    const stop = Math.min(...ends);
    const body = s.slice(at + 2, stop);
    const m = /^([02]);([\s\S]*)$/.exec(body);
    if (m) {
      const t = cleanName(m[2]);
      if (t) titles.push(t);
    }
    i = stop + (stop === bel ? 1 : 2);
  }
}
