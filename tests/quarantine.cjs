/**
 * Issue 397: the quarantine list (tests/quarantine.json) and how a test is
 * matched against it.
 *
 * A quarantined test is a flaky one with evidence: the same sha failed and
 * then passed. On a pull request CI leaves it out of the blocking run and
 * runs it in a separate step that does not block. On main and in the
 * release, nothing is left out.
 *
 * The switch is DEN_TEST_QUARANTINE:
 *   - unset or blank: off. Every test runs and blocks (main, release.yml,
 *     every local run).
 *   - "exclude": quarantined tests are skipped (the PR's blocking run).
 *   - "only": only quarantined files run, and in them only the quarantined
 *     tests (the PR's non-blocking step).
 *
 * DEN_TEST_QUARANTINE_FILE names another list (the tests use it); the
 * default is tests/quarantine.json. CommonJS: jest.config.js, the test
 * environment, the reporter and the TypeScript tests all load it.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_FILE = path.join(ROOT, "tests", "quarantine.json");
/** The Setting's default: an entry older than this many days fails. */
const DEFAULT_MAX_AGE_DAYS = 14;

/** "exclude", "only", or "" (off). Anything else is a mistake: it throws. */
function quarantineMode(env = process.env) {
  const m = (env.DEN_TEST_QUARANTINE ?? "").trim();
  if (m && m !== "exclude" && m !== "only")
    throw new Error(`DEN_TEST_QUARANTINE is exclude or only (got "${m}")`);
  return m;
}

function quarantineFile(env = process.env) {
  const f = (env.DEN_TEST_QUARANTINE_FILE ?? "").trim();
  return f ? path.resolve(ROOT, f) : DEFAULT_FILE;
}

/** The list as written: { max_age_days?, entries: [...] }. */
function loadQuarantine(env = process.env) {
  const doc = JSON.parse(fs.readFileSync(quarantineFile(env), "utf-8"));
  if (!doc || !Array.isArray(doc.entries))
    throw new Error(`${quarantineFile(env)}: no "entries" list`);
  return doc;
}

/**
 * The Setting: DEN_QUARANTINE_MAX_AGE_DAYS, else the file's max_age_days,
 * else 14.
 */
function maxAgeDays(doc, env = process.env) {
  const e = (env.DEN_QUARANTINE_MAX_AGE_DAYS ?? "").trim();
  if (e) {
    if (!/^\d+$/.test(e))
      throw new Error(`DEN_QUARANTINE_MAX_AGE_DAYS is a number (got "${e}")`);
    return Number(e);
  }
  return Number.isInteger(doc.max_age_days)
    ? doc.max_age_days
    : DEFAULT_MAX_AGE_DAYS;
}

/** A "/pattern/flags" string is a regex; anything else is a name. */
function asRegex(test) {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(test);
  return m ? new RegExp(m[1], m[2]) : null;
}

/** A path relative to the checkout, with forward slashes. */
function relPath(file, root = ROOT) {
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  return path.relative(root, abs).split(path.sep).join("/");
}

/**
 * Does `entry` name this test? The file must be the same file. A name
 * matches the test's full name (its describe titles and its own title,
 * joined by spaces, as jest prints it) or its own title, exactly. A
 * "/regex/" is tested against the full name.
 */
function entryMatches(entry, file, fullName, title) {
  if (relPath(entry.file) !== relPath(file)) return false;
  const re = asRegex(entry.test);
  if (re) return re.test(fullName);
  return entry.test === fullName || entry.test === title;
}

function isQuarantined(entries, file, fullName, title) {
  return entries.some((e) => entryMatches(e, file, fullName, title));
}

/** The quarantined files, relative to the checkout, each once. */
function quarantinedFiles(entries) {
  return [...new Set(entries.map((e) => relPath(e.file)))].sort();
}

/** Whole days from `added` (YYYY-MM-DD) to `today` (a Date), in UTC. */
function ageDays(added, today = new Date()) {
  const a = Date.parse(`${added}T00:00:00Z`);
  const t = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return Math.floor((t - a) / 86400000);
}

/**
 * What is wrong with the list, one line each (empty: nothing). The weekly
 * rule: each entry is fixed (removed with the fix) or deleted before it is
 * older than the Setting's days. Every entry names its issue and its
 * evidence.
 */
function quarantineProblems(doc, today = new Date(), env = process.env) {
  const max = maxAgeDays(doc, env);
  const out = [];
  for (const [i, e] of doc.entries.entries()) {
    const at = `entry ${i} (${e.file ?? "?"} › ${e.test ?? "?"})`;
    if (!e.file || !e.test) out.push(`${at}: needs file and test`);
    if (!Number.isInteger(e.issue) || e.issue <= 0) out.push(`${at}: no issue`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.added ?? "")) {
      out.push(`${at}: added is not YYYY-MM-DD`);
    } else {
      const age = ageDays(e.added, today);
      if (age > max)
        out.push(
          `${at}: ${age} days old, over ${max}: fix it (and remove it with the fix) or delete it`,
        );
    }
    const ev = e.evidence ?? {};
    if (!ev.failed_run || !ev.sha)
      out.push(`${at}: evidence needs failed_run and sha`);
    if (!ev.passed_run && !ev.note)
      out.push(
        `${at}: evidence needs passed_run, or a note saying why there is none`,
      );
    const abs = e.file ? path.join(ROOT, relPath(e.file)) : "";
    if (e.file && !fs.existsSync(abs)) out.push(`${at}: no such file`);
    else if (e.file && e.test && !namesATest(e, testNames(abs)))
      out.push(
        `${at}: names no test in its file (renamed or split?): point it at the test, or remove it`,
      );
  }
  return out;
}

const TEST_CALLS = new Set(["it", "test", "describe"]);
/** Stands in a sample name for a part only known when the test runs. */
const HOLE = "\u0000";

/**
 * The names of a file's tests, read from its source: each as a regex over
 * jest's full name (describe titles and its own, joined by spaces) and over
 * its own title, with a sample full name. A template title's ${...} parts match anything; a title
 * that is not text at all (a variable) leaves the file unknown (null).
 */
function testNames(file) {
  const ts = require("typescript");
  const src = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // [pattern, sample]: the sample has HOLE for each ${...} or %s part.
  const title = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      return [esc(n.text), n.text];
    // Only ${...} parts, no text of its own (it(`${name}`)): it could be
    // any name, so it tells nothing; its file is unknown, never refused.
    if (
      ts.isTemplateExpression(n) &&
      !n.head.text &&
      n.templateSpans.every((sp) => !sp.literal.text)
    )
      return null;
    if (ts.isTemplateExpression(n))
      return [
        esc(n.head.text) +
          n.templateSpans.map((sp) => `.+${esc(sp.literal.text)}`).join(""),
        n.head.text +
          n.templateSpans.map((sp) => `${HOLE}${sp.literal.text}`).join(""),
      ];
    return null;
  };
  const out = [];
  let unknown = false;
  const callee = (e) => {
    while (ts.isPropertyAccessExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? e.text : "";
  };
  // it.each(table)("in %s at %i px"): each %-part matches anything.
  const eachOf = (n) =>
    ts.isCallExpression(n) &&
    ts.isCallExpression(n.expression) &&
    ts.isPropertyAccessExpression(n.expression.expression) &&
    n.expression.expression.name.text === "each" &&
    TEST_CALLS.has(callee(n.expression.expression))
      ? callee(n.expression.expression)
      : "";
  const printf = (t) =>
    t && [
      t[0].replace(/%[sdifjop#]/g, ".+"),
      t[1].replace(/%[sdifjop#]/g, HOLE),
    ];
  const visit = (n, groups) => {
    const each = eachOf(n);
    if (
      each ||
      (ts.isCallExpression(n) && TEST_CALLS.has(callee(n.expression)))
    ) {
      const arg = n.arguments[0];
      const t = arg ? (each ? printf(title(arg)) : title(arg)) : null;
      if (t === null) {
        unknown = true;
        return;
      }
      if ((each || callee(n.expression)) === "describe") {
        for (const a of n.arguments.slice(1)) visit(a, [...groups, t]);
        return;
      }
      const all = [...groups, t];
      out.push({
        re: new RegExp(`^(${all.map((g) => g[0]).join(" ")}|${t[0]})$`, "s"),
        sample: all.map((g) => g[1]).join(" "),
      });
      return;
    }
    ts.forEachChild(n, (c) => visit(c, groups));
  };
  visit(src, []);
  return unknown ? null : out;
}

/**
 * A name's instances to try a regex entry on: each hole filled with the
 * regex's own words, since a regex aimed at a template's test names one of
 * its values (/in ja at/ at it(`in ${lang} at 390`)). At most 64.
 */
function instances(sample, re) {
  const holes = sample.split(HOLE).length - 1;
  if (!holes) return [sample];
  const words = [...new Set(re.source.match(/[A-Za-z0-9_.-]+/g) ?? [])];
  let out = [""];
  const pieces = sample.split(HOLE);
  for (let i = 0; i < pieces.length; i++) {
    out = out.map((o) => o + pieces[i]);
    if (i < holes)
      out = out.flatMap((o) => ["x", ...words].map((w) => o + w)).slice(0, 64);
  }
  return out;
}

/** Does an entry name at least one of the file's tests (unknown: yes)? */
function namesATest(entry, names) {
  if (names === null) return true;
  const re = asRegex(entry.test);
  if (re)
    return names.some((n) => instances(n.sample, re).some((x) => re.test(x)));
  return names.some((n) => n.re.test(entry.test));
}

/** The full name jest gives a jest-circus test: describe titles, then its own. */
function circusFullName(test) {
  const names = [];
  for (let t = test; t; t = t.parent)
    if (t.name !== "ROOT_DESCRIBE_BLOCK") names.unshift(t.name);
  return names.join(" ");
}

module.exports = {
  DEFAULT_MAX_AGE_DAYS,
  ageDays,
  circusFullName,
  entryMatches,
  isQuarantined,
  loadQuarantine,
  maxAgeDays,
  quarantineFile,
  quarantineMode,
  quarantineProblems,
  quarantinedFiles,
  relPath,
  testNames,
};
