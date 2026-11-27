import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface PackPin {
  source: string;
  path: string;
  commit: string;
  license: "MIT";
  copyright: string;
  exclude: { path: string; why: string }[];
  patches: Record<string, string>;
  default_off: { skill: string; why: string }[];
  files: Record<string, string>;
}

export type Packs = Record<string, PackPin>;

export const PACKS_FILE = "packs.json";

export function hashFile(file: string): string {
  return `sha256-${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), {
      withFileTypes: true,
    })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out.sort();
}

export function readPacks(packsDir: string): Packs {
  return JSON.parse(
    fs.readFileSync(path.join(packsDir, PACKS_FILE), "utf8"),
  ) as Packs;
}

export function verifyPack(dir: string, pin: PackPin): string[] {
  const problems: string[] = [];
  const have = fs.existsSync(dir) ? listFiles(dir) : [];
  const listed = Object.keys(pin.files).sort();
  for (const f of listed) {
    if (!have.includes(f)) problems.push(`${f}: missing`);
    else if (hashFile(path.join(dir, f)) !== pin.files[f])
      problems.push(`${f}: its hash isn't the pin's`);
  }
  for (const f of have)
    if (!Object.hasOwn(pin.files, f)) problems.push(`${f}: not in the pin`);
  const licence = path.join(dir, "LICENSE");
  if (!fs.existsSync(licence)) {
    if (!problems.includes("LICENSE: missing"))
      problems.push("LICENSE: missing");
  } else {
    const text = fs.readFileSync(licence, "utf8");
    if (!text.startsWith("MIT License") || !text.includes(pin.copyright))
      problems.push("LICENSE: not the MIT licence with the pin's copyright");
  }
  return problems;
}
