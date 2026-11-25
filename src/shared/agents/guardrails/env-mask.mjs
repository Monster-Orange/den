#!/usr/bin/env node
/**
 * Issue 974: Den's masker for commands that print the environment. Den's
 * PreToolUse hook rewrites such a command into `{ <it>; } | <this>`, ahead
 * of any pipe or redirect, so what reaches the transcript, a later stage or
 * a file has the values of secret-looking names replaced by a fixed mark:
 * `NAME=•••• (held)`. Nothing of a value is kept: no prefix, suffix, length
 * or hash.
 *
 * It guards against printing a secret into a transcript by accident. It is
 * not a boundary: an interpreter, `ps eww`, `$VAR` or eval still read a
 * value. On a strict install, the hold (env-hold.ts) is the real control:
 * a held variable isn't in the session at all.
 *
 * The masked set comes from env-hold.ts (envMaskArgs), passed as
 *   --names  P1,P2   name patterns, matched by the hold's own rule
 *   --values G1,G2   value globs (a person's credential, whatever its name)
 * With no --names, every value is masked (it fails closed).
 *
 * Two passes over stdin, which it reads whole:
 *   1. every value (and every line of it) of a variable in its own
 *      environment whose name or value matches, wherever it shows: a bare
 *      value from `printenv NAME`, or a value over several lines;
 *   2. every `NAME=…`, `export NAME=…`, `declare -x NAME=…` record (lines,
 *      or NUL-separated from `env -0`) whose name or value matches.
 * Plain Node, no imports beyond node:*. On any error it prints a line
 * saying the output was withheld, never the output.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export const MARK = "••••";

/** A pattern's regex, by the hold's rule (env-hold.ts globRegex). */
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

/** What is masked: names by `names`, values by `values`; null: everything. */
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

/** `text` with the matched values masked (see the header). */
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
    // A record that is a whole value: masked however short it is.
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
