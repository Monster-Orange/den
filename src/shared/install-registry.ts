/**
 * Issue 728: the installs that share this OS user, so an agent of one is
 * denied the others' credential files and edge keys (it runs as the same
 * user and its own deny rules name only its own install's).
 *
 * One folder per OS user, the same for every distribution, beside the gate
 * slots: `DEN_INSTALLS_DIR`, else ~/Library/Application Support/den/installs
 * (macOS), else $XDG_STATE_HOME/den/installs (~/.local/state). Each install's
 * server writes `<id>.json` (its real state folder and edge key folders) at
 * start. An entry stays while its state folder does: keys outlive a stop.
 *
 * An entry only ever adds denials. Reading keeps an entry only when it
 * passes every check: a regular 0600 file of this user, read without
 * following a link; an absolute state folder of this user, 0700, with a
 * web.secret, not this install's own; and every path free of characters
 * that could break a permission rule, so no entry can void the deny list.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";

const ENTRY_MAX_BYTES = 8192;
const MAX_KEY_DIRS = 8;
/**
 * Characters a permission rule gives meaning to (its parentheses, and the
 * globs * ? [ ] { }), or that end a line.
 */
const UNSAFE_PATH = /[()*?[\]{}"\\\n\r\t\0]/;

export interface RegisteredInstall {
  stateDir: string;
  edgeKeyDirs: string[];
}

export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.DEN_INSTALLS_DIR?.trim();
  if (set) return path.resolve(set);
  const home = env.HOME?.trim() || os.homedir();
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", "den", "installs");
  const xdg = env.XDG_STATE_HOME?.trim();
  return path.join(
    xdg || path.join(home, ".local", "state"),
    "den",
    "installs",
  );
}

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const uid = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;
const safePath = (p: unknown): p is string =>
  typeof p === "string" && path.isAbsolute(p) && !UNSAFE_PATH.test(p);

/**
 * Write (or replace) this install's entry. Throws only when the state folder
 * itself is unsafe; an unsafe edge folder (the any-org fallback of a broken
 * edge config, say) is left out of the entry and returned in `dropped`.
 */
export function registerInstall(
  dir: string,
  o: RegisteredInstall,
): { dropped: string[] } {
  const stateDir = real(o.stateDir);
  if (!safePath(stateDir))
    throw new Error(
      `install registry: refusing the path ${JSON.stringify(stateDir)}`,
    );
  // By real path, as the state folder: readers keep only a real path.
  const all = o.edgeKeyDirs.map(real);
  const edgeKeyDirs = all.filter(safePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const id = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  writeFileAtomic(
    path.join(dir, `${id}.json`),
    JSON.stringify({ stateDir, edgeKeyDirs }) + "\n",
    { mode: 0o600 },
  );
  return { dropped: all.filter((d) => !safePath(d)) };
}

/** The other installs whose entries pass every check, by state folder. */
export function listOtherInstalls(
  dir: string,
  o: {
    ownStateDir: string;
    /** The reader's home (default: os.homedir()). */
    home?: string;
    /** More of the reader's own folders no entry may deny (its distRoot). */
    protect?: string[];
  },
): RegisteredInstall[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const own = real(o.ownStateDir);
  const kept = [own, o.home ?? os.homedir(), ...(o.protect ?? [])].map(real);
  const out: RegisteredInstall[] = [];
  for (const n of names.sort()) {
    const e = readEntry(path.join(dir, n));
    if (!e || !stateDirOk(e.stateDir, own)) continue;
    if (out.some((x) => x.stateDir === e.stateDir)) continue;
    out.push({
      stateDir: e.stateDir,
      edgeKeyDirs: e.edgeKeyDirs
        .filter((d) => keyDirOk(d, kept))
        .slice(0, MAX_KEY_DIRS),
    });
  }
  return out;
}

function readEntry(file: string): RegisteredInstall | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600) return null;
    if (uid() !== null && st.uid !== uid()) return null;
    if (st.size > ENTRY_MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    const v = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
    if (!safePath(v.stateDir)) return null;
    const keys = Array.isArray(v.edgeKeyDirs) ? v.edgeKeyDirs : [];
    return {
      stateDir: v.stateDir,
      edgeKeyDirs: keys.filter(safePath),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Another entry's edge key folder, kept only when denying it can't take
 * anything from this install: an existing directory of this user, its own
 * real path, not / and not one of `kept` (our state folder, home, distRoot)
 * or a folder above one.
 */
function keyDirOk(d: string, kept: string[]): boolean {
  try {
    const st = fs.lstatSync(d);
    if (!st.isDirectory()) return false;
    if (uid() !== null && st.uid !== uid()) return false;
    if (real(d) !== d || d === path.parse(d).root) return false;
    return !kept.some((k) => k === d || k.startsWith(d + path.sep));
  } catch {
    return false;
  }
}

/** An install's state folder: this user's, 0700, with a web.secret. */
function stateDirOk(stateDir: string, own: string): boolean {
  try {
    const st = fs.lstatSync(stateDir);
    if (!st.isDirectory() || (st.mode & 0o777) !== 0o700) return false;
    if (uid() !== null && st.uid !== uid()) return false;
    if (real(stateDir) !== stateDir || stateDir === own) return false;
    return fs.lstatSync(path.join(stateDir, "web.secret")).isFile();
  } catch {
    return false;
  }
}
