#!/usr/bin/env node
/**
 * Words gate (LOGICAL-ERD.md, "Words people see"): a patch may not add a
 * "never shown" word (scripts/words.js) to a string people read. It reads
 * only the lines the patch adds under src/ (TypeScript, the pages' scripts
 * and HTML), against the base: DEN_WORDS_BASE, else the commit in
 * scripts/words-base.txt, else the merge base with origin/main. Existing
 * strings are a separate sweep.
 *
 *   node scripts/words-gate.mjs                 # this branch vs main
 *   DEN_WORDS_BASE=HEAD~1 node scripts/words-gate.mjs
 *
 * A line that must keep a word (a protocol's name, quoted output of another
 * tool) ends with the comment `words-ok: <why>`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { neverShownIn, proseIn } from "./words.js";

const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });

// Until the sweep of existing strings lands, the gate reads from the
// commit named in scripts/words-base.txt (strings before it are the
// sweep's); after the sweep the file says origin/main.
let base = process.env.DEN_WORDS_BASE;
if (!base) {
  try {
    const named = readFileSync(
      new URL("./words-base.txt", import.meta.url),
      "utf-8",
    )
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (named && named !== "origin/main") base = named;
  } catch {
    /* no file: the merge base */
  }
}
if (!base) {
  try {
    base = git("merge-base", "HEAD", "origin/main").trim();
  } catch {
    console.error(
      "words gate: no base (fetch origin/main, or set DEN_WORDS_BASE)",
    );
    process.exit(2);
  }
}

const diff = git(
  "diff",
  "-U0",
  "--no-color",
  "--diff-filter=AM",
  base,
  "--",
  "src/*.ts",
  "src/**/*.ts",
  "src/**/*.js",
  "src/**/*.html",
);

/** A page's lines inside <script>…</script> (1-based), read as code. */
const scriptLines = new Map();
function inScript(f, at) {
  if (!scriptLines.has(f)) {
    const set = new Set();
    let text = "";
    try {
      text = readFileSync(f, "utf-8");
    } catch {
      /* gone: none */
    }
    let open = false;
    text.split("\n").forEach((l, i) => {
      const starts = /<script\b[^>]*>/i.test(l);
      const ends = /<\/script>/i.test(l);
      if (open || starts) set.add(i + 1);
      if (starts && !ends) open = true;
      else if (ends) open = false;
    });
    scriptLines.set(f, set);
  }
  return scriptLines.get(f).has(at);
}

/** A page's lines inside <style>…</style>: CSS, which no one reads as words. */
const styleLines = new Map();
function inStyle(f, at) {
  if (!styleLines.has(f)) {
    const set = new Set();
    let text = "";
    try {
      text = readFileSync(f, "utf-8");
    } catch {
      /* gone: none */
    }
    let open = false;
    text.split("\n").forEach((l, i) => {
      const starts = /<style\b[^>]*>/i.test(l);
      const ends = /<\/style>/i.test(l);
      if (open || starts) set.add(i + 1);
      if (starts && !ends) open = true;
      else if (ends) open = false;
    });
    styleLines.set(f, set);
  }
  return styleLines.get(f).has(at);
}

let file = "";
let lineNo = 0;
let hits = 0;
for (const raw of diff.split("\n")) {
  if (raw.startsWith("+++ ")) {
    file = raw.slice(6);
    continue;
  }
  const h = /^@@ -\S+ \+(\d+)/.exec(raw);
  if (h) {
    lineNo = Number(h[1]);
    continue;
  }
  if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
  const line = raw.slice(1);
  const at = lineNo++;
  if (/\.test\.|\.d\.ts$/.test(file)) continue;
  if (/words-ok:/.test(line)) continue;
  if (file.endsWith(".html") && inStyle(file, at)) continue;
  const strings =
    file.endsWith(".html") && !inScript(file, at)
      ? [
          ...line.matchAll(/\b(?:title|aria-label|placeholder|alt)="([^"]*)"/g),
        ].map((m) => m[1])
      : proseIn(line);
  if (file.endsWith(".html") && !inScript(file, at)) {
    const text = line
      .replace(/<script\b[\s\S]*$/i, "")
      .replace(/<[^>]*>/g, "\n")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => /\S\s+\S/.test(s));
    strings.push(...text);
  }
  for (const s of strings) {
    const words = neverShownIn(s);
    if (!words.length) continue;
    hits++;
    console.error(
      `${file}:${at}: "${words.join('", "')}" (say company, install, project, person, agent): ${s.trim().slice(0, 140)}`,
    );
  }
}

if (hits) {
  console.error(
    `\nwords gate: ${hits} added string(s) use a word people never see (LOGICAL-ERD.md). Reword, or end the line with \`// words-ok: <why>\`.`,
  );
  process.exit(1);
}
console.log(`words gate: added strings clean (vs ${base.slice(0, 12)})`);
