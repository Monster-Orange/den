import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";
import { hubUrlProblem } from "./hub-url.js";

const OWNER = "owner.json";
const RECORD = path.join("config", "local", "state-dir.json");

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function ownerOf(stateDir: string): string | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, OWNER), "utf-8"),
    ) as { distRoot?: unknown };
    return typeof raw.distRoot === "string" && path.isAbsolute(raw.distRoot)
      ? raw.distRoot
      : null;
  } catch {
    return null;
  }
}

const isCheckout = (root: string): boolean => {
  try {
    return fs.statSync(path.join(root, "config")).isDirectory();
  } catch {
    return false;
  }
};

export function stateDirShared(stateDir: string, distRoot: string): boolean {
  const owner = ownerOf(stateDir);
  return !!owner && owner !== real(distRoot) && isCheckout(owner);
}

export function claimStateDir(
  stateDir: string,
  distRoot: string,
): { shared: boolean } {
  if (stateDirShared(stateDir, distRoot)) return { shared: true };
  const me = real(distRoot);
  if (ownerOf(stateDir) !== me) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(
      path.join(stateDir, OWNER),
      JSON.stringify({ distRoot: me }) + "\n",
      { mode: 0o644 },
    );
  }
  return { shared: false };
}

function recordedDir(distRoot: string): string | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(distRoot, RECORD), "utf-8"),
    ) as { dir?: unknown };
    return typeof raw.dir === "string" && path.isAbsolute(raw.dir)
      ? path.normalize(raw.dir)
      : null;
  } catch {
    return null;
  }
}

function madeByDen(dir: string, distRoot: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return false;
  }
  const uid = process.getuid?.();
  return (
    st.isDirectory() &&
    !st.isSymbolicLink() &&
    (uid === undefined || st.uid === uid) &&
    (st.mode & 0o777) === 0o700 &&
    ownerOf(dir) === real(distRoot)
  );
}

export function ownStateDirOf(distRoot: string): string | null {
  const dir = recordedDir(distRoot);
  return dir && madeByDen(dir, distRoot) ? dir : null;
}

export function ownStateDirProblem(distRoot: string): string | null {
  const dir = recordedDir(distRoot);
  return dir && !madeByDen(dir, distRoot)
    ? "this install's own state folder isn't the one Den made (a link, another owner or other permissions), so Den doesn't use it: Settings › Hub's Connect offers a new one"
    : null;
}

function newEmptyDir(base: string, rand: () => string): string {
  for (let i = 0; i < 8; i++) {
    const dir = `${base}-${rand()}`;
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    const st = fs.lstatSync(dir);
    const uid = process.getuid?.();
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      (uid !== undefined && st.uid !== uid) ||
      fs.readdirSync(dir).length
    )
      continue;
    fs.chmodSync(dir, 0o700);
    return dir;
  }
  throw new Error(
    "Den couldn't make a new state folder: every name it tried was taken",
  );
}

export function giveOwnStateDir(
  distRoot: string,
  sharedDir: string,
  rand: () => string = () => randomBytes(4).toString("hex"),
): string {
  const dir = newEmptyDir(path.resolve(sharedDir), rand);
  claimStateDir(dir, distRoot);
  const file = path.join(distRoot, RECORD);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ dir }) + "\n", { mode: 0o600 });
  return dir;
}

const nextFile = (stateDir: string) =>
  path.join(stateDir, "hub", "connect-next.json");

export function writeConnectNext(stateDir: string, hub: string): void {
  const file = nextFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify({ hub }) + "\n", { mode: 0o600 });
}

export function takeConnectNext(stateDir: string): string | null {
  const file = nextFile(stateDir);
  let hub: unknown;
  try {
    hub = (JSON.parse(fs.readFileSync(file, "utf-8")) as { hub?: unknown }).hub;
  } catch {
    return null;
  }
  fs.rmSync(file, { force: true });
  return typeof hub === "string" && !hubUrlProblem(hub) ? hub : null;
}
