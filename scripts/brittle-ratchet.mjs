#!/usr/bin/env node
/**
 * Issue 839: a ratchet on brittle patterns in browser tests and live checks.
 *
 * Counts, per file, four patterns that break when a page changes but its
 * behaviour doesn't:
 *
 *   sleeps          waitForTimeout(…), and a fixed sleep of 100 ms or more
 *                   (new Promise((r) => setTimeout(r, 500)), or an awaited
 *                   setTimeout/sleep/delay(500))
 *   positional      .nth(), .first(), .last(), :nth-child and friends, and
 *                   an index read on a call's result or a list ()[2],
 *                   .split(…)[1], rows[3] (match/exec groups, and arrays
 *                   not named as rows, lines, cells… don't count)
 *   classSelectors  a string selector with a .class token, passed to
 *                   locator, $, $$, waitForSelector, querySelector…
 *   englishAsserts  toBe/toEqual/toContain/toMatch/toHaveText… with plain
 *                   English of two words or more, or getByText("English")
 *
 * A change is judged against its merge base, never a hand-kept file. For
 * each matching file the change touched (git diff <merge base> HEAD), the
 * check counts the file at the merge base (zero for a new file; a renamed
 * file's old path) and at HEAD. It fails when a count goes up. A count
 * going down never fails, and a file the change didn't touch is never
 * judged. Two changes, each green alone, can't turn main red by merging in
 * turn: they share no baseline to race on.
 *
 *   node scripts/brittle-ratchet.mjs --base <ref> [--root dir] [--files glob]… [--json]
 *
 *   --base      the branch the change goes into (a pull request's base sha,
 *               or origin/main). Needs the history back to the merge base:
 *               a shallow clone without it is an error (exit 2), never a pass.
 *   --report    totals per kind, and per file, of the files as they are now.
 *               Never fails (a push to main; the weekly numbers).
 *   --files     a glob relative to --root (** any folders, * any name part);
 *               repeat for more. Default: tests/**\/*.browser.* and gate/*.mjs
 *   --json      print the result as JSON
 *
 * --baseline, --update and --init (the hand-kept baseline) were replaced by
 * --base; they are refused with a note saying so.
 *
 * Plain Node, no imports but node:*, so another repo can copy it alone.
 * Exit 0 when nothing went up, 1 when something did, 2 on a usage or git error.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const KINDS = [
  "sleeps",
  "positional",
  "classSelectors",
  "englishAsserts",
];
const DEFAULT_FILES = ["tests/**/*.browser.*", "gate/*.mjs"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

const ADVICE = {
  sleeps:
    "wait for a state instead: await expect(locator).toBeVisible(), " +
    "expect.poll(…), page.waitForFunction(…) or waitForResponse(…)",
  positional:
    "pick by what the row is, not where it sits: getByRole(role, { name }), " +
    "getByLabel(…), a data-* attribute, or locator.filter({ hasText })",
  classSelectors:
    "use a role or label finder (getByRole, getByLabel) or a data-* " +
    "attribute or id the page keeps for tests, not a styling class",
  englishAsserts:
    "assert on state (a data-* value, a count, an aria-* attribute) or the " +
    "i18n key's text, not a literal English sentence",
};

// ---------------------------------------------------------------- scanning

/**
 * Blanks the inside of string, template and regex literals with spaces,
 * and comments with "\u0001" (newlines kept), so offsets line up with the
 * source. Code
 * patterns are searched in this text; a literal's own text is read from
 * the source at the same offset.
 */
export function codeOnly(src) {
  const out = src.split("");
  const blank = (a, b, ch = " ") => {
    for (let i = a; i < b; i++) if (out[i] !== "\n") out[i] = ch;
  };
  let i = 0;
  const n = src.length;
  const tmplDepth = []; // brace depth at each open ${ in a template
  let braces = 0;
  let lastSig = ""; // last significant code char, for regex detection
  const readString = (q, from) => {
    let j = from + 1;
    while (j < n && src[j] !== q && src[j] !== "\n") {
      if (src[j] === "\\") j++;
      j++;
    }
    return j; // at the closing quote (or end of line)
  };
  const readTemplate = (from) => {
    // from: index after ` or after a } closing ${…}; returns [end, opened]
    let j = from;
    while (j < n) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "`") return [j, false];
      else if (src[j] === "$" && src[j + 1] === "{") return [j, true];
      else j++;
    }
    return [n, false];
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blank(i, end, "\u0001");
      i = end;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end, "\u0001");
      i = end;
    } else if (c === '"' || c === "'") {
      const e = readString(c, i);
      blank(i + 1, e);
      i = e + 1;
      lastSig = c;
    } else if (c === "`") {
      const [e, opened] = readTemplate(i + 1);
      blank(i + 1, e);
      if (opened) {
        tmplDepth.push(braces);
        i = e + 2;
        lastSig = "{";
      } else {
        i = e + 1;
        lastSig = "`";
      }
    } else if (
      c === "/" &&
      (lastSig === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig))
    ) {
      // A regex literal.
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      lastSig = "/";
    } else if (c === "{") {
      braces++;
      lastSig = c;
      i++;
    } else if (c === "}") {
      if (tmplDepth.length && tmplDepth[tmplDepth.length - 1] === braces) {
        tmplDepth.pop();
        const [e, opened] = readTemplate(i + 1);
        blank(i + 1, e);
        if (opened) {
          tmplDepth.push(braces);
          i = e + 2;
          lastSig = "{";
        } else {
          i = e + 1;
          lastSig = "`";
        }
      } else {
        braces--;
        lastSig = c;
        i++;
      }
    } else {
      if (!/\s/.test(c)) {
        // Identifier/number ends: a "/" after it is division.
        lastSig = /[\w$)\]]/.test(c) ? "a" : c;
      }
      i++;
    }
  }
  return out.join("");
}

/** The literal starting at `at` in src ("…", '…', `…` or /…/): [text, kind]. */
function literalAt(src, at) {
  const q = src[at];
  if (q !== '"' && q !== "'" && q !== "`" && q !== "/") return null;
  let j = at + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === "\\") j++;
    if (q !== "`" && src[j] === "\n") return null;
    j++;
  }
  return [src.slice(at + 1, j), q];
}

const lineOf = (starts, idx) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};

const num = (s) => Number(String(s).replace(/_/g, ""));

/** A selector string with a .class token (attribute values and quoted parts ignored). */
export function hasClassToken(sel) {
  const s = sel
    .replace(/\$\{[^}]*\}/g, "x")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"|'[^']*'/g, "");
  return (
    /(?:^|[\s>+~,(*\w\])])\.[A-Za-z_-][\w-]*/.test(s) &&
    !/^\s*\.\/|^\.\.?$/.test(s)
  );
}

/** Plain English: words of letters, `min` of them or more, nothing code-like. */
export function isEnglish(text, min = 2) {
  const t = text.trim();
  if (!t || /[/\\=<>{}[\]_$#@|`*^]/.test(t)) return false;
  if (/^[\w.-]+$/.test(t) && !/\s/.test(t) && min > 1) return false;
  const words = t
    .split(/\s+/)
    .filter((w) => /^[("']?[A-Za-z][a-z'’]*[A-Za-z]?[)"'.,:;!?…]*$/.test(w));
  const longWords = words.filter((w) => /[A-Za-z]{2,}/.test(w));
  return words.length >= min && longWords.length >= 1;
}

const SELECTOR_CALLS =
  /(?:\.|\b)(locator|\$\$?|\$\$?eval|waitForSelector|querySelector(?:All)?|closest|matches|click|dblclick|hover|fill|check|textContent|innerText|isVisible)\s*\([\s\u0001]*/g;
const ASSERT_CALLS =
  /\.(toBe|toEqual|toStrictEqual|toContain|toMatch|toHaveText|toContainText)\s*\([\s\u0001]*/g;
const LIST_INDEX =
  /(?<![\w$.])(?:rows|lines|cells|items|cols|columns|parts|boxes|els|elements|nodes|buttons|btns|links|tabs|cards|options|texts|labels|words|fields|out|output|stdout)\s*\[\s*\d+\s*\]/g;
const TEXT_FINDERS = /\b(getByText)\s*\([\s\u0001]*/g;

/** Counts each kind in one file's source: { kind: [line, …] }. */
export function scan(src) {
  const code = codeOnly(src);
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  const hits = Object.fromEntries(KINDS.map((k) => [k, []]));
  const add = (kind, idx) => hits[kind].push(lineOf(starts, idx));
  let m;

  // Sleeps.
  for (m of code.matchAll(/\bwaitForTimeout\s*\(/g)) add("sleeps", m.index);
  for (m of code.matchAll(
    /\bnew\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(\s*\1\s*,\s*([\d_]+)\s*\)/g,
  ))
    if (num(m[2]) >= 100) add("sleeps", m.index);
  for (m of code.matchAll(
    /\bawait\s+(?:setTimeout|sleep|delay|wait|pause)\s*\(\s*([\d_]+)\s*[,)]/g,
  ))
    if (num(m[1]) >= 100) add("sleeps", m.index);

  // Positional picks.
  for (m of code.matchAll(/\.(?:nth\s*\(|(?:first|last)\s*\(\s*\))/g))
    add("positional", m.index);
  for (m of src.matchAll(
    /:(?:nth-child|nth-of-type|nth-last-child|first-child|last-child|first-of-type|last-of-type)\b/g,
  ))
    if (code[m.index] === " ") add("positional", m.index); // in a string
  for (m of code.matchAll(/\)\s*\[\s*\d+\s*\]/g)) {
    // Walk back to the call's "(" and read the name before it.
    let depth = 0;
    let j = m.index;
    for (; j >= 0; j--) {
      if (code[j] === ")") depth++;
      else if (code[j] === "(" && --depth === 0) break;
    }
    const name = /([\w$]+)\s*$/.exec(code.slice(Math.max(0, j - 40), j));
    if (name && /^(match|exec|matchAll|if|while|for)$/.test(name[1])) continue;
    add("positional", m.index);
  }
  // A list of rows, lines or elements read by position (a name that says
  // so; other arrays, like a live check's clause names, don't count).
  for (m of code.matchAll(LIST_INDEX)) add("positional", m.index);

  // Raw class selectors.
  for (m of code.matchAll(SELECTOR_CALLS)) {
    const at = m.index + m[0].length;
    const lit = literalAt(src, at);
    if (lit && lit[1] !== "/" && hasClassToken(lit[0]))
      add("classSelectors", m.index);
  }

  // English-text asserts.
  for (m of code.matchAll(ASSERT_CALLS)) {
    const at = m.index + m[0].length;
    const lit = literalAt(src, at);
    if (!lit) continue;
    let text = lit[0];
    if (lit[1] === "/")
      text = text.replace(/\\b|\\s\+?|\^|\$/g, " ").replace(/\\(.)/g, "$1");
    if (lit[1] === "`" && text.includes("${")) continue;
    if (isEnglish(text, 2)) add("englishAsserts", m.index);
  }
  for (m of code.matchAll(TEXT_FINDERS)) {
    const at = m.index + m[0].length;
    const lit = literalAt(src, at);
    if (
      lit &&
      isEnglish(lit[1] === "/" ? lit[0].replace(/\\./g, "") : lit[0], 1)
    )
      add("englishAsserts", m.index);
  }
  for (const k of KINDS) hits[k].sort((a, b) => a - b);
  return hits;
}

// ------------------------------------------------------------------ files

/** A glob ("**" any folders, "*" any part of a name) as a RegExp. */
export function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function listFiles(root, globs) {
  const res = globs.map(globRe);
  const out = [];
  const walk = (rel) => {
    let ents;
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(r);
      } else if (e.isFile() && res.some((x) => x.test(r))) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

// --------------------------------------------------------------- ratchet

const countOf = (src) => {
  const hits = scan(src);
  return Object.fromEntries(KINDS.map((k) => [k, hits[k]]));
};

/** Totals per kind over { file: { kind: n } }. */
export function totals(files) {
  const t = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const c of Object.values(files))
    for (const k of KINDS) t[k] += c[k] ?? 0;
  return t;
}

/**
 * Compares one file's counts at the merge base ({ kind: n }) with its hits
 * at HEAD ({ kind: [line, …] }): { failures, lower }.
 */
export function compareFile(file, base, head, newFile = false) {
  const failures = [];
  const lower = [];
  for (const k of KINDS) {
    const was = base[k] ?? 0;
    const now = head[k]?.length ?? 0;
    if (now > was)
      failures.push({
        file,
        kind: k,
        base: was,
        head: now,
        newFile,
        lines: head[k],
      });
    else if (now < was) lower.push({ file, kind: k, base: was, head: now });
  }
  return { failures, lower };
}

class GitError extends Error {}

function gitIn(root) {
  return (...args) => {
    const r = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) throw new GitError(`git ${args[0]}: ${r.error.message}`);
    return r;
  };
}

const NO_BASE_HINT =
  "The check needs the history back to where this change and its base meet. " +
  "In CI, check out with fetch-depth: 0 (or fetch the base ref deep enough); " +
  "locally, git fetch --unshallow.";

/** The merge base of `base` and HEAD, or a GitError that says why not. */
export function mergeBase(root, base) {
  const git = gitIn(root);
  const ref = git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
  if (ref.status !== 0)
    throw new GitError(
      `no merge base: ${base} is not a commit in this clone. ${NO_BASE_HINT}`,
    );
  const mb = git("merge-base", ref.stdout.trim(), "HEAD");
  if (mb.status !== 0 || !mb.stdout.trim()) {
    const shallow =
      git("rev-parse", "--is-shallow-repository").stdout.trim() === "true";
    throw new GitError(
      `no merge base between ${base} and HEAD${shallow ? " (this is a shallow clone)" : ""}. ${NO_BASE_HINT}`,
    );
  }
  return mb.stdout.trim();
}

/**
 * The files matching `globs` that changed between the merge base and HEAD:
 * [{ file, from }] where `from` is the path at the merge base (a rename's
 * old path), or null for a new file. Deleted files are left out (a count
 * that drops to nothing never fails).
 */
export function changedFiles(root, mb, globs) {
  const res = globs.map(globRe);
  const r = gitIn(root)("diff", "--name-status", "-z", "-M", mb, "HEAD", "--");
  if (r.status !== 0) throw new GitError(`git diff: ${r.stderr.trim()}`);
  const parts = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i < parts.length - 1; ) {
    const status = parts[i++];
    if (/^[RC]/.test(status)) {
      const from = parts[i++];
      const to = parts[i++];
      if (res.some((x) => x.test(to)))
        out.push({ file: to, from: status[0] === "R" ? from : null });
    } else {
      const file = parts[i++];
      if (status === "D") continue;
      if (res.some((x) => x.test(file)))
        out.push({ file, from: status === "A" ? null : file });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

function showAt(root, rev, file) {
  const r = gitIn(root)("show", `${rev}:${file}`);
  if (r.status !== 0)
    throw new GitError(`git show ${rev}:${file}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Judges a change: { mergeBase, files, failures, lower }. */
export function judge(root, base, globs) {
  const mb = mergeBase(root, base);
  const files = {};
  const failures = [];
  const lower = [];
  for (const { file, from } of changedFiles(root, mb, globs)) {
    const was = from ? countOf(showAt(root, mb, from)) : {};
    const now = countOf(showAt(root, "HEAD", file));
    const wasN = Object.fromEntries(KINDS.map((k) => [k, was[k]?.length ?? 0]));
    const r = compareFile(file, wasN, now, !from);
    failures.push(...r.failures);
    lower.push(...r.lower);
    const row = {};
    for (const k of KINDS)
      if (wasN[k] || now[k].length)
        row[k] = { base: wasN[k], head: now[k].length, lines: now[k] };
    files[file] = row;
  }
  return { mergeBase: mb, files, failures, lower };
}

export function reportSince(root, rev, globs) {
  const git = gitIn(root);
  const commit = git("rev-parse", "--verify", "--quiet", `${rev}^{commit}`);
  if (commit.status !== 0)
    throw new GitError(`--since ${rev}: no such commit here`);
  const sha = commit.stdout.trim();
  const ls = git("ls-tree", "-r", "-z", "--name-only", sha);
  if (ls.status !== 0)
    throw new GitError(`git ls-tree ${sha}: ${ls.stderr.trim()}`);
  const res = globs.map(globRe);
  const was = {};
  for (const f of ls.stdout.split("\0").filter(Boolean).sort()) {
    if (!res.some((x) => x.test(f))) continue;
    const hits = scan(showAt(root, sha, f));
    const row = {};
    for (const k of KINDS) if (hits[k].length) row[k] = hits[k].length;
    if (Object.keys(row).length) was[f] = row;
  }
  const now = report(root, globs);
  const sum = (row) => KINDS.reduce((n, k) => n + (row?.[k] ?? 0), 0);
  const down = [];
  const up = [];
  for (const file of [
    ...new Set([...Object.keys(was), ...Object.keys(now.files)]),
  ].sort()) {
    const before = sum(was[file]);
    const after = sum(now.files[file]);
    if (after < before) down.push({ file, before, after });
    else if (after > before) up.push({ file, before, after });
  }
  return {
    ...now,
    since: { ref: rev, commit: sha, totals: totals(was), files: was },
    down,
    up,
  };
}

/** Counts every matching file as it is now: { totals, files }. */
export function report(root, globs) {
  const files = {};
  for (const f of listFiles(root, globs)) {
    const hits = scan(fs.readFileSync(path.join(root, f), "utf8"));
    const row = {};
    for (const k of KINDS) if (hits[k].length) row[k] = hits[k].length;
    if (Object.keys(row).length) files[f] = row;
  }
  return { totals: totals(files), files };
}

const REPLACED = new Set(["--baseline", "--update", "--init"]);
const USAGE =
  "usage: brittle-ratchet.mjs --base <ref> | --report [--since <ref>] [--root dir] [--files glob]… [--json]";

function parseArgs(argv) {
  const o = { files: [], json: false, report: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--root") o.root = val();
    else if (a === "--files") o.files.push(val());
    else if (a === "--base") o.base = val();
    else if (a === "--report") o.report = true;
    else if (a === "--since") o.since = val();
    else if (a === "--json") o.json = true;
    else if (REPLACED.has(a))
      throw new Error(
        `${a} is gone: there is no hand-kept baseline any more (issue 839). ` +
          "A change is judged against its merge base with --base <ref>; " +
          "totals come from --report.",
      );
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.base && !o.report)
    throw new Error(
      "pass --base <ref> to judge a change against its merge base, " +
        "or --report for totals per kind",
    );
  if (o.base && o.report)
    throw new Error("--base <ref> and --report don't go together");
  if (o.since !== undefined && !o.report)
    throw new Error("--since <ref> goes with --report");
  return o;
}

function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`brittle-ratchet: ${e.message}\n${USAGE}`);
    return 2;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(o.root ?? path.join(here, ".."));
  const globs = o.files.length ? o.files : DEFAULT_FILES;

  if (o.report && o.since !== undefined) {
    let r;
    try {
      r = reportSince(root, o.since, globs);
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      console.error(`brittle-ratchet: ${e.message}`);
      return 2;
    }
    if (o.json) console.log(JSON.stringify(r, null, 2));
    else {
      const n = (x) => Object.keys(x).length;
      const files = (c) => `${c} file${c === 1 ? "" : "s"}`;
      console.log(
        `brittle-ratchet: since ${o.since} (${r.since.commit.slice(0, 12)}): ${files(n(r.files))} with brittle patterns, was ${n(r.since.files)}`,
      );
      console.log(
        "  (then and now are both counted with this script's patterns)",
      );
      for (const k of KINDS) {
        const d = r.totals[k] - r.since.totals[k];
        console.log(
          `  ${k.padEnd(15)} ${r.since.totals[k]} -> ${r.totals[k]} (${d > 0 ? "+" : ""}${d})`,
        );
      }
      for (const [list, word] of [
        [r.down, "down"],
        [r.up, "up"],
      ]) {
        if (!list.length) continue;
        console.log(`${files(list.length)} went ${word}:`);
        for (const f of list)
          console.log(`  ${f.file}: ${f.before} -> ${f.after}`);
      }
    }
    return 0;
  }

  if (o.report) {
    const r = report(root, globs);
    if (o.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(
        `brittle-ratchet: ${Object.keys(r.files).length} files with brittle patterns`,
      );
      for (const k of KINDS) console.log(`  ${k.padEnd(15)} ${r.totals[k]}`);
    }
    return 0;
  }

  let r;
  try {
    r = judge(root, o.base, globs);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    console.error(`brittle-ratchet: ${e.message}`);
    return 2;
  }
  if (o.json) {
    console.log(JSON.stringify(r, null, 2));
    return r.failures.length ? 1 : 0;
  }
  const against = `${o.base} (merge base ${r.mergeBase.slice(0, 12)})`;
  if (r.failures.length) {
    console.error(
      `brittle-ratchet: ${r.failures.length} count(s) went up in files this change touched, against ${against} (issue 839)\n`,
    );
    for (const f of r.failures) {
      const where = f.lines.length === 1 ? "line" : "lines";
      console.error(
        `  ${f.file}: ${f.kind} ${f.base} -> ${f.head}${f.newFile ? " (new file)" : ""}, ${where} ${f.lines.join(", ")}\n    ${ADVICE[f.kind]}`,
      );
    }
    console.error("\nRewrite the new lines the way each note says.");
  }
  if (r.lower.length)
    console.log(
      `brittle-ratchet: ${r.lower.length} count(s) went down against ${against}`,
    );
  if (!r.failures.length && !r.lower.length)
    console.log(
      `brittle-ratchet: ${Object.keys(r.files).length} touched file(s), no count went up against ${against}`,
    );
  return r.failures.length ? 1 : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
