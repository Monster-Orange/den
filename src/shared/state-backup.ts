import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";

export const BACKUP_DIR = "backup";
export const KEPT_FILE = "kept.json";
export const KEEP_PER_FILE = 3;
const KEEP_NOTES = 50;

export interface KeptFile {
  file: string;
  saved: string;
  at: string;
  why: string;
  told?: boolean;
}

const listeners = new Set<(k: KeptFile) => void>();

export function onKept(fn: (k: KeptFile) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function backupDir(stateDir: string): string {
  return path.join(stateDir, BACKUP_DIR);
}

function flatName(rel: string): string {
  return rel.split(/[\\/]+/).join("__");
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

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
  const at = `${base}.${stamp(now)}`;
  let saved = `${at}.bad`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let top = -1;
    for (const n of fs.readdirSync(dir)) {
      if (n === `${at}.bad`) top = Math.max(top, 0);
      const m = n.startsWith(`${at}-`)
        ? /^-(\d+)\.bad$/.exec(n.slice(at.length))
        : null;
      if (m) top = Math.max(top, Number(m[1]));
    }
    if (top >= 0) saved = `${at}-${top + 1}.bad`;
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
  const key = (n: string): [string, number] => {
    const m = /^(.*Z)(?:-(\d+))?\.bad$/.exec(n.slice(base.length + 1));
    return m ? [m[1]!, Number(m[2] ?? 0)] : [n, 0];
  };
  const byTime = [...names].sort((a, b) => {
    const [ta, na] = key(a);
    const [tb, nb] = key(b);
    return ta < tb ? -1 : ta > tb ? 1 : na - nb;
  });
  for (const n of byTime.slice(0, Math.max(0, byTime.length - KEEP_PER_FILE)))
    try {
      fs.rmSync(path.join(dir, n), { force: true, recursive: true });
    } catch {
      /* kept one more */
    }
}

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

export function readStateJson(stateDir: string, file: string): StateRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: false, missing: true };
    return {
      ok: false,
      missing: false,
      kept: keepUnreadable(stateDir, file, (e as Error).message),
    };
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
