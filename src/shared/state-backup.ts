/**
 * Issue 786 clause 3: a state file Den can't read is kept, never lost.
 *
 * Until 786 a reader that hit a broken file (a crash mid-write before
 * atomic-write, a disk error, a hand edit) caught the error and started
 * empty, and the next save wrote over what was left. Now the reader moves
 * the file to `<state>/backup/` first, under its path in the state folder
 * plus the time, and keeps the newest KEEP_PER_FILE copies of each file.
 * Each copy is noted in `<state>/backup/kept.json`, which doctor reads (a
 * warn row naming the files) and the server turns into one bell item per
 * file. Nothing is reset silently.
 *
 * Only the state folder's own files are moved: a file outside it is left
 * where it is (it is the person's, not Den's to move).
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";

export const BACKUP_DIR = "backup";
export const KEPT_FILE = "kept.json";
/** Copies kept per state file; older ones are removed. */
export const KEEP_PER_FILE = 3;
/** Notes kept in kept.json (the newest). */
const KEEP_NOTES = 50;

export interface KeptFile {
  /** The file's path in the state folder ("agents/a1.json"). */
  file: string;
  /** The copy's name in <state>/backup/. */
  saved: string;
  /** ISO 8601: when it was kept. */
  at: string;
  /** Why it couldn't be read (the parse error's message), bounded. */
  why: string;
  /** Whether the bell has been told (the server sets it). */
  told?: boolean;
}

/** Listeners told of each file kept (the server's bell). */
const listeners = new Set<(k: KeptFile) => void>();

/** Hear of each file kept from now on; returns the way to stop. */
export function onKept(fn: (k: KeptFile) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function backupDir(stateDir: string): string {
  return path.join(stateDir, BACKUP_DIR);
}

/** "agents/a1.json" → "agents__a1.json": one flat folder, one name per file. */
function flatName(rel: string): string {
  return rel.split(/[\\/]+/).join("__");
}

/** The ISO time made safe for a file name on every OS. */
function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

/**
 * Move the unreadable `file` to <state>/backup/ and note it. Null when the
 * file is gone, is outside `stateDir`, or can't be moved (then it stays
 * where it is: never worse than before).
 */
/**
 * Why a file couldn't be read, with none of its text. Node's JSON.parse
 * messages quote the file (a short one whole), and a state file may hold
 * a token or a key: only a fixed reason is kept, with the position at
 * most, or the error code of a read that failed.
 */
export function safeWhy(message: string): string {
  if (
    /JSON|Unexpected|Unterminated|Expected|Bad control|Bad escaped/.test(
      message,
    )
  ) {
    const at = /position (\d+)/.exec(message);
    return `not valid JSON${at ? ` (at position ${at[1]})` : ""}`;
  }
  const code = /^(E[A-Z]{2,}):/.exec(message);
  return code ? `can't be read (${code[1]})` : "can't be read";
}

export function keepUnreadable(
  stateDir: string,
  file: string,
  why: string,
  now: Date = new Date(),
): KeptFile | null {
  const root = path.resolve(stateDir);
  const abs = path.resolve(file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (rel.split(/[\\/]+/)[0] === BACKUP_DIR) return null;
  if (!fs.existsSync(abs)) return null;
  const dir = backupDir(root);
  const base = flatName(rel);
  let saved = `${base}.${stamp(now)}.bad`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let i = 1; fs.existsSync(path.join(dir, saved)); i++)
      saved = `${base}.${stamp(now)}-${i}.bad`;
    fs.renameSync(abs, path.join(dir, saved));
  } catch {
    return null;
  }
  prune(dir, base);
  const k: KeptFile = {
    file: rel.split(path.sep).join("/"),
    saved,
    at: now.toISOString(),
    why: safeWhy(why),
  };
  try {
    writeNotes(root, [...readKept(root), k].slice(-KEEP_NOTES));
  } catch {
    /* the copy is kept; only the note is lost */
  }
  for (const fn of listeners) {
    try {
      fn(k);
    } catch {
      /* a listener's trouble never stops a read */
    }
  }
  return k;
}

/** All but the newest KEEP_PER_FILE copies of `base` go. */
function prune(dir: string, base: string): void {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.`) && n.endsWith(".bad"))
      .filter((n) => !n.slice(base.length + 1).includes("__"));
  } catch {
    return;
  }
  // The name ends in the time it was kept (a rename keeps the old mtime).
  const byTime = [...names].sort();
  for (const n of byTime.slice(0, Math.max(0, byTime.length - KEEP_PER_FILE)))
    fs.rmSync(path.join(dir, n), { force: true });
}

/** The notes of files kept, oldest first ([] when none or unreadable). */
export function readKept(stateDir: string): KeptFile[] {
  try {
    const v: unknown = JSON.parse(
      fs.readFileSync(path.join(backupDir(stateDir), KEPT_FILE), "utf8"),
    );
    if (!Array.isArray(v)) return [];
    return v.filter(
      (k): k is KeptFile =>
        !!k &&
        typeof k === "object" &&
        typeof (k as KeptFile).file === "string" &&
        typeof (k as KeptFile).saved === "string" &&
        typeof (k as KeptFile).at === "string",
    );
  } catch {
    return [];
  }
}

function writeNotes(stateDir: string, notes: KeptFile[]): void {
  writeFileAtomic(
    path.join(backupDir(stateDir), KEPT_FILE),
    `${JSON.stringify(notes, null, 1)}\n`,
    { mode: 0o600 },
  );
}

/** Mark these notes told (by `saved`), so the bell says each once. */
export function markKeptTold(stateDir: string, saved: readonly string[]): void {
  if (!saved.length) return;
  const set = new Set(saved);
  const notes = readKept(stateDir);
  if (!notes.some((k) => set.has(k.saved) && !k.told)) return;
  writeNotes(
    stateDir,
    notes.map((k) => (set.has(k.saved) ? { ...k, told: true } : k)),
  );
}

export type StateRead =
  | { ok: true; value: unknown }
  | { ok: false; missing: true }
  | { ok: false; missing: false; kept: KeptFile | null };

/**
 * Read a JSON state file. Missing: says so. Unreadable (bad JSON, or a
 * read error other than missing): the file is kept in backup and the
 * caller starts from its default, as before, but nothing is lost.
 */
export function readStateJson(stateDir: string, file: string): StateRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: false, missing: true };
    return { ok: false, missing: false, kept: null };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return {
      ok: false,
      missing: false,
      kept: keepUnreadable(stateDir, file, (e as Error).message),
    };
  }
}
