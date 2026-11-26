#!/usr/bin/env node
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export const MARK = "••••";

function globRegex(p) {
  const body = String(p)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}(?:_[0-9].*)?$`, "i");
}

function valueRegex(g) {
  const body = String(g)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "s");
}

export function maskMatcher(names, values = []) {
  if (names === null) return { name: () => true, value: () => true, all: true };
  const n = names.filter(Boolean).map(globRegex);
  const v = values.filter(Boolean).map(valueRegex);
  return {
    name: (x) => n.some((r) => r.test(x)),
    value: (x) => v.some((r) => r.test(x)),
    all: false,
  };
}

const RECORD =
  /^(\s*(?:(?:export|declare|typeset|local|readonly)(?:\s+-[A-Za-z-]+)*\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

export function maskEnvText(text, m, env = process.env) {
  const pieces = new Set();
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string" || v === "") continue;
    if (!m.name(k) && !m.value(v)) continue;
    pieces.add(v);
    for (const l of v.split(/\r?\n/)) if (l.trim()) pieces.add(l);
  }
  const ordered = [...pieces].sort((a, b) => b.length - a.length);
  const parts = String(text).split(/(\r?\n|\0)/);
  for (let i = 0; i < parts.length; i += 2) {
    let rec = parts[i];
    if (ordered.includes(rec) || ordered.includes(rec.trim())) {
      parts[i] = MARK;
      continue;
    }
    for (const p of ordered) if (p.length >= 4) rec = rec.split(p).join(MARK);
    const r = RECORD.exec(rec);
    if (r && (m.name(r[2]) || m.value(r[3]) || r[3].includes(MARK)))
      rec = `${r[1]}${r[2]}=${MARK} (held)`;
    parts[i] = rec;
  }
  return parts.join("");
}

function arg(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let out;
  try {
    const argv = process.argv.slice(2);
    const names = arg("--names", argv);
    const values = arg("--values", argv);
    const m = maskMatcher(
      names === null ? null : names.split(","),
      values === null ? [] : values.split(","),
    );
    out = maskEnvText(Buffer.concat(chunks).toString("utf-8"), m);
  } catch {
    out = "Den's env masker failed: the output was withheld.\n";
  }
  process.stdout.write(out);
}

function isMain() {
  try {
    return (
      !!process.argv[1] &&
      fs.realpathSync(process.argv[1]) ===
        fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMain()) await main();
