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
/** A line longer than this is no title record: skipped to its end. */
const MAX_LINE = 64 * 1024;
/** The longest name kept. */
export const MAX_NAME = 80;
/** The most files followed at once (the oldest is forgotten first). */
const MAX_FOLLOWED = 256;

interface Follow {
  offset: number;
  title: string | null;
  /** The start of a line whose newline hasn't come yet. */
  rest: Buffer;
  /** Inside a line too long to be a title: drop bytes to its newline. */
  skipping: boolean;
}

const followers = new Map<string, Follow>();

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

function titleOf(line: Buffer): string | null | undefined {
  if (!line.includes("custom-title")) return undefined;
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

/** The latest custom-title in `file` (read on from the last ask), or null. */
export function transcriptTitle(file: string): string | null {
  let fd: number | undefined;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) {
      followers.delete(file);
      return null;
    }
    let f = followers.get(file);
    if (!f || st.size < f.offset) {
      f = { offset: 0, title: null, rest: Buffer.alloc(0), skipping: false };
      followers.delete(file);
      if (followers.size >= MAX_FOLLOWED)
        followers.delete(followers.keys().next().value as string);
      followers.set(file, f);
    }
    if (st.size === f.offset) return f.title;
    fd = fs.openSync(file, "r");
    const end = Math.min(st.size, f.offset + FOLLOW_MAX_BYTES);
    const buf = Buffer.alloc(CHUNK);
    while (f.offset < end) {
      const n = fs.readSync(
        fd,
        buf,
        0,
        Math.min(CHUNK, end - f.offset),
        f.offset,
      );
      if (n <= 0) break;
      f.offset += n;
      let data = buf.subarray(0, n);
      for (;;) {
        const nl = data.indexOf(0x0a);
        if (nl < 0) {
          if (!f.skipping) {
            f.rest = Buffer.concat([f.rest, data]);
            if (f.rest.length > MAX_LINE) {
              f.rest = Buffer.alloc(0);
              f.skipping = true;
            }
          }
          break;
        }
        const piece = data.subarray(0, nl);
        data = data.subarray(nl + 1);
        if (f.skipping) {
          f.skipping = false;
          continue;
        }
        const line = f.rest.length ? Buffer.concat([f.rest, piece]) : piece;
        f.rest = Buffer.alloc(0);
        const t = titleOf(line);
        if (t) f.title = t;
      }
    }
    return f.title;
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

/** Where a followed file is up to (tests). */
export function followState(file: string): { offset: number } | undefined {
  const f = followers.get(file);
  return f ? { offset: f.offset } : undefined;
}

/** Forget every followed file (tests). */
export function resetFollowers(): void {
  followers.clear();
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
