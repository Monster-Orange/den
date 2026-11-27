import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashFile, listFiles, verifyPack, type PackPin } from "./pin.js";

export const SKILL_PACK_CACHE = "skill-packs";

const setKey = (skills: readonly string[]) =>
  crypto
    .createHash("sha256")
    .update([...new Set(skills)].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);

function readOnly(dir: string): void {
  for (const f of listFiles(dir)) fs.chmodSync(path.join(dir, f), 0o444);
}

function keptFiles(pin: PackPin, keep: ReadonlySet<string>): string[] {
  return Object.keys(pin.files)
    .filter((rel) => {
      const m = /^skills\/([^/]+)\//.exec(rel);
      return !m || keep.has(m[1]!);
    })
    .sort();
}

function matchesPin(dir: string, want: readonly string[], pin: PackPin) {
  let have: string[];
  try {
    have = listFiles(dir);
  } catch {
    return false;
  }
  if (have.join("\n") !== want.join("\n")) return false;
  return want.every((rel) => {
    try {
      return hashFile(path.join(dir, rel)) === pin.files[rel];
    } catch {
      return false;
    }
  });
}

function removeTree(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[])
    try {
      fs.chmodSync(path.join(dir, f), 0o700);
    } catch {
      continue;
    }
  fs.rmSync(dir, { recursive: true, force: true });
}

export function buildPluginDir(
  packsDir: string,
  cache: string,
  name: string,
  pin: PackPin,
  skills: readonly string[],
): string {
  const src = path.join(packsDir, name);
  const problems = verifyPack(src, pin);
  if (problems.length)
    throw new Error(`skill pack ${name}: ${problems.slice(0, 3).join("; ")}`);
  const base = path.join(cache, `${name}@${pin.commit.slice(0, 12)}`);
  const dest = path.join(base, setKey(skills));
  const want = keptFiles(pin, new Set(skills));
  if (matchesPin(dest, want, pin)) return dest;
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(base, ".build-"));
  for (const rel of want) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.copyFileSync(path.join(src, rel), path.join(tmp, rel));
  }
  readOnly(tmp);
  if (!matchesPin(tmp, want, pin)) {
    removeTree(tmp);
    throw new Error(`skill pack ${name}: its built copy isn't the pin's`);
  }
  const stale = fs.existsSync(dest)
    ? fs.mkdtempSync(path.join(base, ".stale-"))
    : null;
  if (stale) fs.renameSync(dest, path.join(stale, "old"));
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    removeTree(tmp);
    if (!matchesPin(dest, want, pin)) throw e;
  } finally {
    if (stale) removeTree(stale);
  }
  return dest;
}
