/**
 * AG-DROP: a file dropped or pasted onto an agent's terminal, from a
 * browser that may be on another machine. The browser sends it over Den's
 * own HTTPS; the server writes it under
 * `<uploads dir>/<session id>/<timestamp>-<name>` (0600, in a 0700 folder,
 * outside any repo) and the page types its absolute path at the cursor,
 * as a native terminal's drop does. Nothing is written through the PTY.
 *
 * Settings, `agents.uploads`:
 *   max_bytes  the largest file taken (default 25 MB)
 *   keep_days  how long a file is kept before it is pruned (default 7)
 *   dir        where they go (default <state>/uploads)
 */
import * as fs from "fs";
import * as path from "path";

export interface UploadSettings {
  maxBytes: number;
  keepDays: number;
  /** Absolute, or null: `<state>/uploads`. */
  dir: string | null;
}

export const UPLOAD_DEFAULTS: UploadSettings = {
  maxBytes: 25 * 1024 * 1024,
  keepDays: 7,
  dir: null,
};

/** The largest max_bytes a config may set (4 GiB). */
const MAX_MAX_BYTES = 4 * 1024 * 1024 * 1024;

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `agents.uploads` checked; a bad key or value throws naming it. */
export function uploadsBlock(v: unknown): UploadSettings {
  const out = { ...UPLOAD_DEFAULTS };
  if (v === undefined || v === null) return out;
  if (!isMapping(v))
    throw new Error(
      `agents.uploads: must be a mapping of max_bytes, keep_days, dir (got ${JSON.stringify(v)})`,
    );
  for (const [k, x] of Object.entries(v)) {
    if (k === "max_bytes") {
      if (
        typeof x !== "number" ||
        !Number.isInteger(x) ||
        x < 1 ||
        x > MAX_MAX_BYTES
      )
        throw new Error(
          `agents.uploads.max_bytes: must be a whole number of bytes from 1 to ${MAX_MAX_BYTES} (got ${JSON.stringify(x)})`,
        );
      out.maxBytes = x;
    } else if (k === "keep_days") {
      if (typeof x !== "number" || !Number.isFinite(x) || x <= 0 || x > 3650)
        throw new Error(
          `agents.uploads.keep_days: must be a number of days, above 0 and at most 3650 (got ${JSON.stringify(x)})`,
        );
      out.keepDays = x;
    } else if (k === "dir") {
      if (typeof x !== "string" || !path.isAbsolute(x))
        throw new Error(
          `agents.uploads.dir: must be an absolute path (got ${JSON.stringify(x)})`,
        );
      out.dir = path.normalize(x);
    } else
      throw new Error(
        `agents.uploads.${k}: unknown key (agents.uploads takes max_bytes, keep_days, dir)`,
      );
  }
  return out;
}

/** A session id as the host makes them (hex), the only folder name taken. */
export const UPLOAD_SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A file name as the browser gave it, made safe to write: its last path
 * part only, control characters and anything outside a plain set turned to
 * "_", no leading dots, at most 100 characters (its extension kept).
 * Empty: "file".
 */
export function safeUploadName(name: string): string {
  const base = String(name ?? "")
    .split(/[\\/]/)
    .pop()!
    .normalize("NFC");
  let s = base
    .replace(/[^\p{L}\p{N} ._+@()-]/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "");
  if (s.length > 100) {
    const ext = path.extname(s).slice(0, 16);
    s = s.slice(0, 100 - ext.length) + ext;
  }
  return s || "file";
}

/** 20261111-153012-123: sorts by time, safe in a file name. */
function stamp(at: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-` +
    `${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}-${p(at.getUTCMilliseconds(), 3)}`
  );
}

/** Where uploads go: the setting's dir, else `<state>/uploads`. */
export function uploadsRoot(s: UploadSettings, stateDir: string): string {
  return s.dir ?? path.join(stateDir, "uploads");
}

/**
 * The file's path for `name` in session `sessionId`'s folder, made at `at`.
 * Throws on a session id that isn't one; the result is always inside the
 * session's folder.
 */
export function uploadPath(
  root: string,
  sessionId: string,
  name: string,
  at: Date,
): string {
  if (!UPLOAD_SESSION_RE.test(sessionId))
    throw new Error(`not a session id: ${JSON.stringify(sessionId)}`);
  const dir = path.join(root, sessionId);
  const file = path.join(dir, `${stamp(at)}-${safeUploadName(name)}`);
  if (path.dirname(file) !== dir) throw new Error("upload path escapes");
  return file;
}

/**
 * A path as a shell reads it back as one word: as it is when it has only
 * safe characters, else in single quotes (a ' inside as '\'').
 */
export function shellQuote(p: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Remove upload files older than keep_days under `root`, and session
 * folders left empty. Only regular files directly in a session folder are
 * touched; anything else (a link, a folder) is left. Returns how many
 * files went.
 */
export function pruneUploads(
  root: string,
  keepDays: number,
  now: number = Date.now(),
): number {
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  let gone = 0;
  let sessions: fs.Dirent[];
  try {
    sessions = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of sessions) {
    if (!d.isDirectory() || !UPLOAD_SESSION_RE.test(d.name)) continue;
    const dir = path.join(root, d.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let left = files.length;
    for (const f of files) {
      if (!f.isFile()) continue;
      const file = path.join(dir, f.name);
      try {
        if (fs.lstatSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
          gone++;
          left--;
        }
      } catch {
        /* gone already, or not ours to remove */
      }
    }
    if (left === 0)
      try {
        fs.rmdirSync(dir);
      } catch {
        /* not empty after all */
      }
  }
  return gone;
}

export interface UploadEntry {
  path: string;
  name: string;
  bytes: number;
  /** ms since the epoch. */
  at: number;
}

/** The files in session `sessionId`'s uploads folder, newest first. */
export function listUploads(root: string, sessionId: string): UploadEntry[] {
  if (!UPLOAD_SESSION_RE.test(sessionId)) return [];
  const dir = path.join(root, sessionId);
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: UploadEntry[] = [];
  for (const d of names) {
    if (!d.isFile() || d.name.endsWith(".part")) continue;
    const file = path.join(dir, d.name);
    try {
      const st = fs.lstatSync(file);
      out.push({ path: file, name: d.name, bytes: st.size, at: st.mtimeMs });
    } catch {
      /* gone */
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
