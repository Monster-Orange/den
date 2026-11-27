#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const USAGE = `node scripts/shim-imports.mjs [--root <dir>]

Each path in scripts/shims.json is an old path kept for outside consumers.
It must stay a single export-* line, and no file in this repo may import it:
import the new path instead.`;

const SHIM_LINE = /^export \* from "\.{1,2}\/[^"\n]+";\n?$/;
const SPEC =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bjest\.(?:mock|unstable_mockModule|requireActual|doMock|requireMock)\s*\(\s*)(["'`])((?:\.{1,2}\/|@monster-orange\/den\/)[^"'`\n]+?)\1/g;
const CODE = /\.(ts|tsx|js|mjs|cjs)$/;

function resolveSpec(fromFile, spec, tracked) {
  const abs = spec.startsWith("@monster-orange/den/")
    ? spec.slice("@monster-orange/den/".length)
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const cands = abs.endsWith(".js")
    ? [abs.replace(/\.js$/, ".ts"), abs]
    : /\.[a-z]+$/.test(abs)
      ? [abs]
      : [`${abs}.ts`, `${abs}/index.ts`, abs];
  return cands.find((c) => tracked.has(c));
}

export function shimProblems(root) {
  const listFile = path.join(root, "scripts", "shims.json");
  const shims = JSON.parse(fs.readFileSync(listFile, "utf8")).shims ?? [];
  const tracked = new Set(
    execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean),
  );
  const out = [];
  const listed = new Set(shims);
  for (const s of shims) {
    if (!tracked.has(s)) {
      out.push(`${s}: listed in scripts/shims.json, but not in the tree`);
      continue;
    }
    const text = fs.readFileSync(path.join(root, s), "utf8");
    if (!SHIM_LINE.test(text))
      out.push(
        `${s}: a listed shim must be one export-* line and nothing else`,
      );
  }
  for (const f of [...tracked].sort()) {
    if (!CODE.test(f) || listed.has(f) || f.includes("node_modules/")) continue;
    const lines = fs.readFileSync(path.join(root, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(SPEC)) {
        const t = resolveSpec(f, m[2], tracked);
        if (t && listed.has(t))
          out.push(
            `${f}:${i + 1}: imports ${t}, a shim; import ${shimTarget(root, t)} instead`,
          );
      }
    });
  }
  return out;
}

function shimTarget(root, shim) {
  const m = fs
    .readFileSync(path.join(root, shim), "utf8")
    .match(/from "([^"]+)"/);
  if (!m) return "its new path";
  return path.posix
    .normalize(path.posix.join(path.posix.dirname(shim), m[1]))
    .replace(/\.js$/, ".ts");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }
  const at = args.indexOf("--root");
  const root = path.resolve(at >= 0 ? args[at + 1] : ".");
  const problems = shimProblems(root);
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error(`shim-imports: ${problems.length} problem(s)\n\n${USAGE}`);
    process.exit(1);
  }
  console.log("shim-imports: ok");
}
