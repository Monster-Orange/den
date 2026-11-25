import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listFiles, verifyPack, type PackPin } from "./pin.js";

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
  if (fs.existsSync(path.join(dest, ".claude-plugin", "plugin.json")))
    return dest;
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(base, ".build-"));
  const keep = new Set(skills);
  for (const rel of listFiles(src)) {
    const m = /^skills\/([^/]+)\//.exec(rel);
    if (m && !keep.has(m[1]!)) continue;
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.copyFileSync(path.join(src, rel), path.join(tmp, rel));
  }
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(path.join(dest, ".claude-plugin", "plugin.json")))
      throw e;
    return dest;
  }
  readOnly(dest);
  return dest;
}
