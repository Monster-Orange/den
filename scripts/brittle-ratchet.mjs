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
 * The baseline (JSON) records each file's counts. The check fails when a
 * file's count for any kind goes up, or a file not in the baseline has any.
 * It never fails when counts go down; it then prints the command that
 * lowers the baseline (--update), which never raises a count or adds a file.
 *
 *   node scripts/brittle-ratchet.mjs [--root dir] [--files glob]…
 *        [--baseline file] [--update | --init] [--json]
 *
 *   --files     a glob relative to --root (** any folders, * any name part);
 *               repeat for more. Default: tests/**\/*.browser.* and gate/*.mjs
 *   --baseline  default: tests/brittle-baseline.json under --root
 *   --update    rewrite the baseline lower where counts went down
 *   --init      write the baseline from today's counts (only when none exists)
 *   --json      print counts and failures as JSON
 *
 * Plain Node, no imports but node:*, so another repo can copy it alone.
 * Exit 0 when nothing went up, 1 when something did, 2 on a usage error.
 */
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
const DEFAULT_BASELINE = "tests/brittle-baseline.json";
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

/** Compares counts with a baseline: { failures, lower }. */
export function compare(counts, baseline) {
  const failures = [];
  const lower = [];
  const files = baseline.files ?? {};
  for (const [file, hits] of Object.entries(counts)) {
    for (const k of KINDS) {
      const now = hits[k].length;
      const was = files[file]?.[k] ?? 0;
      if (now > was)
        failures.push({
          file,
          kind: k,
          count: now,
          baseline: was,
          newFile: !(file in files),
          lines: hits[k],
        });
      else if (now < was)
        lower.push({ file, kind: k, count: now, baseline: was });
    }
  }
  for (const [file, was] of Object.entries(files))
    if (!(file in counts))
      for (const k of KINDS)
        if (was[k]) lower.push({ file, kind: k, count: 0, baseline: was[k] });
  return { failures, lower };
}

function totals(files) {
  const t = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const c of Object.values(files))
    for (const k of KINDS) t[k] += c[k] ?? 0;
  return t;
}

function baselineDoc(files) {
  const sorted = {};
  for (const f of Object.keys(files).sort()) {
    const row = {};
    for (const k of KINDS) if (files[f][k]) row[k] = files[f][k];
    if (Object.keys(row).length) sorted[f] = row;
  }
  return {
    about:
      "Issue 839: per-file counts of brittle patterns (scripts/brittle-ratchet.mjs). " +
      "Counts may only go down; lower them with: node scripts/brittle-ratchet.mjs --update",
    totals: totals(sorted),
    files: sorted,
  };
}

/** The new baseline --update writes: each count lowered to today's, never raised. */
export function lowered(counts, baseline) {
  const files = {};
  for (const [file, was] of Object.entries(baseline.files ?? {})) {
    if (!(file in counts)) continue;
    const row = {};
    for (const k of KINDS)
      row[k] = Math.min(was[k] ?? 0, counts[file][k].length);
    files[file] = row;
  }
  return baselineDoc(files);
}

function parseArgs(argv) {
  const o = { files: [], json: false, update: false, init: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--root") o.root = val();
    else if (a === "--files") o.files.push(val());
    else if (a === "--baseline") o.baseline = val();
    else if (a === "--update") o.update = true;
    else if (a === "--init") o.init = true;
    else if (a === "--json") o.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`brittle-ratchet: ${e.message}`);
    return 2;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(o.root ?? path.join(here, ".."));
  const globs = o.files.length ? o.files : DEFAULT_FILES;
  const basePath = path.resolve(root, o.baseline ?? DEFAULT_BASELINE);

  const counts = {};
  for (const f of listFiles(root, globs)) {
    const hits = scan(fs.readFileSync(path.join(root, f), "utf8"));
    if (KINDS.some((k) => hits[k].length)) counts[f] = hits;
  }

  if (o.init) {
    if (fs.existsSync(basePath)) {
      console.error(
        `brittle-ratchet: ${basePath} exists; --init only writes a new baseline (use --update to lower one)`,
      );
      return 2;
    }
    const flat = Object.fromEntries(
      Object.entries(counts).map(([f, h]) => [
        f,
        Object.fromEntries(KINDS.map((k) => [k, h[k].length])),
      ]),
    );
    const doc = baselineDoc(flat);
    fs.mkdirSync(path.dirname(basePath), { recursive: true });
    fs.writeFileSync(basePath, JSON.stringify(doc, null, 2) + "\n");
    console.log(`brittle-ratchet: wrote ${path.relative(root, basePath)}`);
    console.log(JSON.stringify(doc.totals));
    return 0;
  }

  let baseline = { files: {} };
  if (fs.existsSync(basePath))
    baseline = JSON.parse(fs.readFileSync(basePath, "utf8"));
  const { failures, lower } = compare(counts, baseline);

  if (o.update && lower.length) {
    fs.writeFileSync(
      basePath,
      JSON.stringify(lowered(counts, baseline), null, 2) + "\n",
    );
  }

  if (o.json) {
    const files = {};
    for (const [f, h] of Object.entries(counts))
      files[f] = Object.fromEntries(
        KINDS.filter((k) => h[k].length).map((k) => [
          k,
          { count: h[k].length, lines: h[k] },
        ]),
      );
    console.log(JSON.stringify({ files, failures, lower }, null, 2));
    return failures.length ? 1 : 0;
  }

  const rel = path.relative(process.cwd(), basePath) || basePath;
  const updateCmd = `node scripts/brittle-ratchet.mjs${o.root ? ` --root ${o.root}` : ""}${o.files.map((g) => ` --files '${g}'`).join("")}${o.baseline ? ` --baseline ${o.baseline}` : ""} --update`;
  if (failures.length) {
    console.error(
      `brittle-ratchet: ${failures.length} count(s) went up over ${rel} (issue 839)\n`,
    );
    for (const f of failures) {
      const where = f.lines.length === 1 ? "line" : "lines";
      console.error(
        `  ${f.file}: ${f.kind} ${f.count} > ${f.baseline}${f.newFile ? " (new file: not in the baseline)" : ""}, ${where} ${f.lines.join(", ")}\n    ${ADVICE[f.kind]}`,
      );
    }
    console.error(
      "\nThe baseline never goes up: rewrite the new lines the way each note says.",
    );
  }
  if (lower.length && !o.update) {
    console.log(
      `brittle-ratchet: ${lower.length} count(s) went down. Lower the baseline with:\n  ${updateCmd}`,
    );
  } else if (lower.length) {
    console.log(`brittle-ratchet: lowered ${lower.length} count(s) in ${rel}`);
  }
  if (!failures.length && !lower.length)
    console.log(
      `brittle-ratchet: ${Object.keys(counts).length} files at their baseline`,
    );
  return failures.length ? 1 : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
