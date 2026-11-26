import { createHash } from "crypto";
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

export function ownStateDirOf(distRoot: string): string | null {
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

export function giveOwnStateDir(distRoot: string, sharedDir: string): string {
  const id = createHash("sha256")
    .update(real(distRoot))
    .digest("hex")
    .slice(0, 6);
  const dir = `${path.resolve(sharedDir)}-${id}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
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
