#!/usr/bin/env node
/**
 * Guardrail lint: the text rules in rules.json, for any repo and language.
 *
 *   node lint/mo-gates.mjs --base <ref> [--root dir] [--json]   only the lines a change adds
 *   node lint/mo-gates.mjs --all [--root dir] [--json]          every file
 *   node lint/mo-gates.mjs --pr-text                             PR_TITLE and PR_BODY only
 *
 * A line rule matches added lines. A module rule judges a file and reports line ranges; in --base mode a range
 * counts when the change added a line inside it. A hit is excused by `mo-lint-ok: <reason>` on its line or the
 * line above (a module hit: anywhere in its range). An excuse with no reason does not count.
 * A repo's .guardrail-lint.json may set "since": the commit where the rules landed there. With --base, lines
 * already there at that commit never count, even when the base is older (a queue branch judged against main).
 * It is read from the base's tree, so a change can't move it. In a PR's merge commit, pass --base HEAD^1.
 * A ratchet rule's count(src, path) lists lines, summed over the files the change touched at the base (the newer
 * of the merge base and "since") and at HEAD; it fails when the sum rises. A new file counts from 0, a deleted file's
 * count comes off, an unreadable side (binary, over 2 MB) is left out. opt_in rules run only when the base's settings
 * list them in "on"; ratchets judge only with --base. The settings' "exclude" globs (vendored code) skip every rule,
 * read like "since" (HEAD's with --all), so a change can't exclude its own files.
 * Exit 0 clean, 1 on a hit, 2 on a usage, config or git error. Plain Node, no dependencies.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OK = /mo-lint-ok:[ \t]*\S/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".venv", "__pycache__"]);

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += `(?:${glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else re += c.replace(/[.+?^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export async function loadRules(file = join(HERE, "rules.json")) {
  const { rules, exclude = [] } = JSON.parse(readFileSync(file, "utf-8"));
  const ex = exclude.map(globToRegExp);
  const out = [];
  for (const r of rules) {
    const rule = { ...r, globs: (r.files ?? []).map(globToRegExp) };
    if (r.kind === "line") rule.re = new RegExp(r.pattern, r.flags ?? "");
    if (r.kind === "pr-text") rule.re = new RegExp(r.pattern, "gi");
    if (r.unless_file) rule.unless = new RegExp(r.unless_file);
    if (r.kind === "module") rule.check = (await import(pathToFileURL(join(HERE, r.module)).href)).check;
    if (r.kind === "ratchet") rule.count = (await import(pathToFileURL(join(HERE, r.module)).href)).count;
    out.push(rule);
  }
  return { rules: out, excluded: (p) => ex.some((e) => e.test(p)) };
}

function* walk(root, dir = root) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p, { throwIfNoEntry: false });
    if (!s) continue;
    if (s.isDirectory()) yield* walk(root, p);
    else if (s.isFile() && s.size < 2_000_000) yield relative(root, p).replaceAll("\\", "/");
  }
}

export function tracked(root) {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf-8", maxBuffer: 256 << 20 });
    return out.split("\0").filter(Boolean);
  } catch {
    return [...walk(root)];
  }
}

const SHA = /^[0-9a-f]{40}$/;

/** The repo's lint settings, .guardrail-lint.json as the base commit has it: { "since": "<40-hex commit>" }.
 *  Read from the base's tree, never the working tree, so a change can't set the line that judges it. */
export function baseConfig(root, base) {
  let text;
  try {
    text = execFileSync("git", ["-C", root, "show", `${base}:.guardrail-lint.json`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return {};
  }
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) { throw new Error(`.guardrail-lint.json: ${e.message}`); }
  if (cfg.since !== undefined && !SHA.test(String(cfg.since))) throw new Error(".guardrail-lint.json: since must be one full 40-hex commit SHA");
  if (cfg.on !== undefined && !(Array.isArray(cfg.on) && cfg.on.every((id) => typeof id === "string")))
    throw new Error(".guardrail-lint.json: on must be a list of rule ids");
  const top = (g) => typeof g === "string" && /^(?!\.\.?\/)[\w.-]+\/./.test(g);
  if (cfg.exclude !== undefined && !(Array.isArray(cfg.exclude) && cfg.exclude.every(top)))
    throw new Error(".guardrail-lint.json: exclude must be a list of globs, each starting with a folder named in full (vendor/pack/**)");
  return cfg;
}

/** The lines of HEAD's files that `from` doesn't have: file -> Set of line numbers in HEAD. */
function linesAddedSince(git, from) {
  const diff = git("diff", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=AMR", from, "HEAD");
  const files = new Map();
  let cur = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) {
      cur = l === "+++ /dev/null" ? null : l.slice(6);
      if (cur && !files.has(cur)) files.set(cur, new Set());
    } else if (cur && l.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(l);
      const start = Number(m[1]);
      const n = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < n; i++) files.get(cur).add(start + i);
    }
  }
  return files;
}

export function addedLines(root, base) {
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf-8", maxBuffer: 256 << 20 });
  const is = (a, b) => { try { git("merge-base", "--is-ancestor", a, b); return true; } catch { return false; } };
  const mb = git("merge-base", base, "HEAD").trim();
  const { since } = baseConfig(root, git("rev-parse", "--verify", `${base}^{commit}`).trim());
  const files = linesAddedSince(git, mb);
  // Lines already there when the rules landed never count: when `since` is in this branch's history, a line
  // counts only if it is new against both the merge base and `since`. A branch without it is judged as usual.
  if (!since || is(since, mb) || !is(since, "HEAD")) return files;
  const sinceThen = linesAddedSince(git, since);
  for (const [p, set] of files) {
    const keep = sinceThen.get(p);
    if (!keep) files.delete(p);
    else for (const n of [...set]) if (!keep.has(n)) set.delete(n);
  }
  return files;
}

/**
 * A ratchet rule over a change's touched files, [{ path, base, head }] with null for a side the file is missing
 * from: one hit when the count across them rose. A file with no base side (a new file) counts from 0.
 */
export function ratchetCompare(rule, files) {
  let was = 0;
  let now = 0;
  const rows = [];
  for (const f of files) {
    if (!rule.globs.some((g) => g.test(f.path))) continue;
    const b = f.base === null ? 0 : rule.count(f.base, f.path).length;
    const lines = f.head === null ? [] : rule.count(f.head, f.path);
    was += b;
    now += lines.length;
    if (lines.length !== b) rows.push({ path: f.path, d: lines.length - b, lines });
  }
  if (now <= was) return [];
  rows.sort((x, y) => y.d - x.d);
  const top = rows[0];
  const each = rows.map((r) => `${r.path} ${r.d > 0 ? "+" : ""}${r.d}`).join(", ");
  return [{ rule, path: top.path, line: top.lines[0] ?? 0, text: `${was} -> ${now} across the files this change touched (${each})` }];
}

/** The touched files of a change, both sides, for the ratchet rules: [{ path, base, head }]. */
export function changedPairs(root, base, excluded = () => false) {
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf-8", maxBuffer: 256 << 20 });
  const is = (a, b) => { try { git("merge-base", "--is-ancestor", a, b); return true; } catch { return false; } };
  const mb = git("merge-base", base, "HEAD").trim();
  const cfg = baseConfig(root, git("rev-parse", "--verify", `${base}^{commit}`).trim());
  const from = cfg.since && !is(cfg.since, mb) && is(cfg.since, "HEAD") ? cfg.since : mb;
  const show = (rev, p) => {
    let src;
    try { src = execFileSync("git", ["-C", root, "show", `${rev}:${p}`], { encoding: "utf-8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
    return src.length > 2_000_000 || src.includes("\0") ? null : src;
  };
  const parts = git("diff", "--name-status", "-z", "-M", "--no-ext-diff", from, "HEAD", "--").split("\0");
  const out = [];
  for (let i = 0; i < parts.length - 1; ) {
    const st = parts[i++];
    const old = parts[i++];
    const cur = /^[RC]/.test(st) ? parts[i++] : old;
    if (excluded(cur) || excluded(old)) continue;
    const baseSide = st[0] === "A" || st[0] === "C" ? null : show(from, old);
    const headSide = st[0] === "D" ? null : show("HEAD", cur);
    // A side that can't be read (binary, too big) skips the file: never counted as deleted, so it can't pay
    // for comments added elsewhere.
    if ((st[0] !== "A" && st[0] !== "C" && baseSide === null) || (st[0] !== "D" && headSide === null)) continue;
    out.push({ path: cur, base: baseSide, head: headSide });
  }
  return { pairs: out, on: cfg.on ?? [] };
}

export const escData = (v) => String(v).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
export const escProp = (v) => escData(v).replace(/:/g, "%3A").replace(/,/g, "%2C");

export function lintFile(rules, path, src, added) {
  const lines = src.split("\n");
  const excused = (from, to) => {
    for (let i = Math.max(1, from - 1); i <= to; i++) if (OK.test(lines[i - 1] ?? "")) return true;
    return false;
  };
  const hits = [];
  for (const r of rules) {
    if (r.kind === "pr-text" || !r.globs.some((g) => g.test(path))) continue;
    if (r.unless && r.unless.test(src)) continue;
    if (r.kind === "line") {
      lines.forEach((text, i) => {
        const n = i + 1;
        if ((!added || added.has(n)) && r.re.test(text) && !excused(n, n)) hits.push({ rule: r, path, line: n });
      });
    } else if (r.kind === "module") {
      for (const { line, end } of r.check(src, path)) {
        if (added && ![...added].some((n) => n >= line && n <= end)) continue;
        if (!excused(line, end)) hits.push({ rule: r, path, line });
      }
    }
  }
  return hits;
}

export function lintPrText(rules, texts) {
  const hits = [];
  for (const r of rules.filter((x) => x.kind === "pr-text"))
    for (const [where, text] of texts) for (const m of String(text ?? "").matchAll(r.re)) hits.push({ rule: r, path: where, line: 0, text: m[0] });
  return hits;
}

async function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = arg("--root") ?? process.cwd();
  const base = arg("--base");
  const { rules, excluded: shared } = await loadRules(arg("--rules"));
  let excluded = shared;
  let hits;
  if (argv.includes("--pr-text")) {
    hits = lintPrText(rules, [["pull request title", process.env.PR_TITLE], ["pull request body", process.env.PR_BODY]]);
  } else if (base || argv.includes("--all")) {
    let files;
    try {
      const at = base ? execFileSync("git", ["-C", root, "rev-parse", "--verify", `${base}^{commit}`], { encoding: "utf-8" }).trim() : "HEAD";
      const own = (baseConfig(root, at).exclude ?? []).map(globToRegExp);
      if (own.length) excluded = (p) => shared(p) || own.some((e) => e.test(p));
      files = base ? addedLines(root, base) : new Map(tracked(root).map((p) => [p, null]));
    } catch (e) {
      if (/guardrail-lint\.json/.test(e.message)) { console.error(`guardrail lint: ${e.message}`); return 2; }
      console.error(`guardrail lint: git failed (${String(e.message).split("\n")[0]}). It needs the history back to the merge base.`);
      return 2;
    }
    hits = [];
    for (const [p, added] of files) {
      if (excluded(p)) continue;
      let src;
      try {
        const st = lstatSync(join(root, p));
        if (!st.isFile() || st.size > 2_000_000) continue;
        src = readFileSync(join(root, p), "utf-8");
      } catch { continue; }
      if (src.includes("\0")) continue;
      hits.push(...lintFile(rules, p, src, added));
    }
    const ratchets = rules.filter((r) => r.kind === "ratchet");
    if (base && ratchets.length) {
      let ch;
      try { ch = changedPairs(root, base, excluded); } catch (e) {
        console.error(`guardrail lint: ${/guardrail-lint\.json/.test(e.message) ? e.message : `git failed (${String(e.message).split("\n")[0]})`}`);
        return 2;
      }
      for (const r of ratchets) if (!r.opt_in || ch.on.includes(r.id)) hits.push(...ratchetCompare(r, ch.pairs));
    }
  } else {
    console.error("usage: mo-gates.mjs --base <ref> | --all | --pr-text  [--root dir] [--json]");
    return 2;
  }
  if (argv.includes("--json")) console.log(JSON.stringify(hits.map((h) => ({ rule: h.rule.id, path: h.path, line: h.line, text: h.text }))));
  else for (const h of hits) {
    const at = h.line ? `${h.path}:${h.line}` : h.path;
    const msg = `${at}: ${h.text ? `"${h.text}": ` : ""}${h.rule.message} (${h.rule.id})`;
    console.log(process.env.GITHUB_ACTIONS ? `::error${h.line ? ` file=${escProp(h.path)},line=${h.line}` : ""}::${escData(msg)}` : msg);
  }
  if (!argv.includes("--json")) console.log(`guardrail lint: ${hits.length ? `${hits.length} hit(s)` : "ok"}${base ? ` (lines added since ${base})` : ""}`);
  return hits.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
