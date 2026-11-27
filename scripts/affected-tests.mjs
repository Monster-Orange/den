#!/usr/bin/env node
/**
 * Issue 398: the tests a pull request runs. Main and releases run every
 * test; a pull request runs the tests its change affects:
 *
 *   related   jest --findRelatedTests over the changed source files (the
 *             tests that import them, directly or not);
 *   changed   a changed test file;
 *   mapped    the browser specs mapped to a changed page, route or public
 *             file in tests/affected-map.json (browser tests load pages over
 *             HTTP, so jest's import graph never reaches them), and each
 *             test that starts Den as a process, when its subject changes
 *             (issue 708: a spawn is not an import either);
 *   smoke     the map's fixed smoke set, on every pull request;
 *   ALL       every test, when a changed file matches the map's
 *             "everything" list (the shared shell, the kit, the request
 *             guard, package.json, jest config, CI...).
 *
 *   node scripts/affected-tests.mjs <base> <head> [--out <file>]
 *        [--summary <file>] [--map <file>]
 *
 * The change is `git diff --name-only <base>...<head>` (what the pull
 * request changes). The map's page rules are also rebuilt from the code
 * (scripts/affected-map.mjs) and added, so a stale map never runs less. Prints one line per test file with its reasons, or ALL
 * with the files that caused it. --out writes the bare list (or the word
 * ALL) for jest; --summary appends a Markdown table (the job summary).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MAP = path.join(ROOT, "tests", "affected-map.json");

// --- pure parts (unit-tested) ---------------------------------------------

/** A glob as a RegExp: `**` any depth, `*` and `?` within a segment, `{a,b}`. */
export function globToRegExp(glob) {
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
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re +=
        "(?:" +
        glob
          .slice(i + 1, end)
          .split(",")
          .map(escape)
          .join("|") +
        ")";
      i = end;
    } else re += escape(c);
  }
  return new RegExp("^" + re + "$");
}
/** Many globs' RegExp sources at once (for the map's own checks). */
export const globsToRegExps = (globs) =>
  globs.map((g) => globToRegExp(g).source);

const escape = (s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");

const matcher = (globs) => {
  const res = [globs].flat().map(globToRegExp);
  return (f) => res.some((r) => r.test(f));
};

/** Checks a map's shape; throws on a mistake rather than running less. */
export function validateMap(map) {
  const problems = [];
  if (!Array.isArray(map.everything))
    problems.push("everything: a list of globs");
  if (!Array.isArray(map.smoke)) problems.push("smoke: a list of test files");
  if (!Array.isArray(map.rules))
    problems.push("rules: a list of {when, run, why}");
  for (const [i, r] of (map.rules ?? []).entries()) {
    if (!r.when?.length || !r.run?.length || !r.why)
      problems.push(`rules[${i}]: needs when, run and why`);
    if (r.importers && !Array.isArray(r.importers))
      problems.push(`rules[${i}]: importers is a list of files`);
    if (r.mentions !== undefined && typeof r.mentions !== "boolean")
      problems.push(`rules[${i}]: mentions is true or false`);
  }
  // Issue 708: the subjects of tests that start Den, and the shrink-only
  // list of those without one.
  if (
    map.subjects !== undefined &&
    (typeof map.subjects !== "object" ||
      Array.isArray(map.subjects) ||
      Object.values(map.subjects).some((g) => !Array.isArray(g) || !g.length))
  )
    problems.push("subjects: {test file: [globs]}, none empty");
  if (map.subjectless !== undefined && !Array.isArray(map.subjectless))
    problems.push("subjectless: a list of test files");
  if (problems.length) throw new Error(`affected map: ${problems.join("; ")}`);
  return map;
}

export function loadMap(file = DEFAULT_MAP) {
  return validateMap(JSON.parse(fs.readFileSync(file, "utf-8")));
}

/**
 * The subset for one change.
 *   changed   files the change touches (repo-relative)
 *   allTests  every jest test file (repo-relative)
 *   related   the test files jest --findRelatedTests gave for the change
 *   map       the affected map
 *   importersOf  for a rule's `importers` files: the tests that import
 *             each (jest's import graph), { file: [tests] }
 *   mentioned the browser specs that mention a changed catalog key or its
 *             English text, for a rule with `mentions: true`
 * Returns { all, allBecause, files: Map<test file, reasons[]> }.
 */
/**
 * Issue 843: the jest files CI's `fast` job ran (scripts/fast-checks.json).
 * The pull request's jobs wait for `fast`, so a selection leaves them out:
 * one run per check per tree.
 */
export function ranFirstTests(root = ROOT) {
  const file = path.join(root, "scripts", "fast-checks.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8")).jest ?? [];
}

export function testsNamingPaths(changed, sources) {
  const out = {};
  for (const [t, text] of Object.entries(sources))
    for (const f of changed) {
      if (f === t) continue;
      let i = text.indexOf(f);
      while (i >= 0 && /[\w.-]/.test(text[i + f.length] ?? ""))
        i = text.indexOf(f, i + 1);
      if (i >= 0) (out[t] ??= []).push(f);
    }
  return out;
}

export function selectTests({
  changed,
  allTests,
  related,
  map,
  importersOf = {},
  mentioned = [],
  named = {},
  ranFirst = [],
}) {
  const skip = new Set(ranFirst);
  allTests = allTests.filter((f) => !skip.has(f));
  const everything = (map.everything ?? []).map((e) =>
    typeof e === "string" ? { glob: e } : e,
  );
  const allBecause = [];
  for (const f of changed) {
    const hit = everything.find((e) => globToRegExp(e.glob).test(f));
    if (hit) allBecause.push(f);
  }
  const files = new Map();
  const add = (f, why) => {
    if (!files.has(f)) files.set(f, []);
    if (!files.get(f).includes(why)) files.get(f).push(why);
  };
  if (allBecause.length) {
    for (const f of allTests) add(f, "everything");
    return { all: true, allBecause, files };
  }
  const tests = new Set(allTests);
  for (const f of changed) if (tests.has(f)) add(f, "changed");
  for (const f of related) if (tests.has(f)) add(f, "related");
  for (const [t, paths] of Object.entries(named))
    if (tests.has(t)) for (const p of paths) add(t, `names ${p}`);
  for (const rule of map.rules) {
    const when = matcher(rule.when);
    const trigger = changed.filter(when);
    if (!trigger.length) continue;
    const run = matcher(rule.run);
    const why = `mapped: ${trigger[0]}${trigger.length > 1 ? ` +${trigger.length - 1}` : ""} (${rule.why})`;
    for (const t of allTests) if (run(t)) add(t, why);
    for (const imp of rule.importers ?? [])
      for (const t of importersOf[imp] ?? [])
        if (tests.has(t)) add(t, `${why}: imports ${path.basename(imp)}`);
    if (rule.mentions)
      for (const t of mentioned)
        if (tests.has(t)) add(t, `${why}: mentions a changed key or its text`);
  }
  for (const s of map.smoke) if (tests.has(s)) add(s, "smoke");
  return { all: false, allBecause, files };
}

/**
 * The catalog entries a diff of public/i18n/*.js adds or removes:
 * `"key": "text",` lines (either quote), as { keys, texts }.
 */
export function catalogChanges(diff) {
  const keys = new Set();
  const texts = new Set();
  for (const line of diff.split("\n")) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    const m = /^[+-]\s*(["'])([^"']+)\1\s*:\s*(["'`])((?:\\.|(?!\3).)*)\3/.exec(
      line,
    );
    if (!m) continue;
    keys.add(m[2]);
    texts.add(m[4]);
  }
  return { keys: [...keys], texts: [...texts] };
}

/** The English text of each key, read from the English catalog's source. */
export function englishTexts(keys, enSource) {
  const out = [];
  for (const k of keys) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(
      `(["'])${esc}\\1\\s*:\\s*(["'\`])((?:\\\\.|(?!\\2).)*)\\2`,
    ).exec(enSource ?? "");
    if (m) out.push(m[3]);
  }
  return out;
}

/**
 * The specs whose source names one of the keys, or one of the English
 * texts. Short needles match too much: a key needs a dot or 6 characters,
 * a text 6 characters.
 */
export function specsMentioning(specSources, keys, texts) {
  const needles = [
    ...keys.filter((k) => k.includes(".") || k.length >= 6),
    ...texts.filter((t) => t.length >= 6),
  ];
  return Object.entries(specSources)
    .filter(([, src]) => needles.some((n) => src.includes(n)))
    .map(([f]) => f)
    .sort();
}

/** The Markdown job summary. */
export function summaryMarkdown(sel, changedCount) {
  const lines = ["## Tests this pull request runs (issue 398)", ""];
  if (sel.all) {
    lines.push(
      `**Everything**: ${sel.files.size} test files, because of ${sel.allBecause.map((f) => `\`${f}\``).join(", ")}.`,
      "",
    );
    return lines.join("\n") + "\n";
  }
  lines.push(
    `${sel.files.size} test files for ${changedCount} changed files.`,
    "",
    "| Test | Why |",
    "| --- | --- |",
  );
  for (const [f, why] of [...sel.files].sort(([a], [b]) => a.localeCompare(b)))
    lines.push(`| \`${f}\` | ${why.join("; ")} |`);
  return lines.join("\n") + "\n";
}

// --- CLI --------------------------------------------------------------------

const SOURCE_ROOTS = ["tests", "src", "packages", "scripts", "bin"];

/**
 * A child process's output, or a plain Error with its message and stderr
 * (a child-process error refers to itself, which nothing can serialize).
 */
function run(cmd, args, opts) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
  } catch (e) {
    throw new Error(
      `${cmd} ${args[0] ?? ""} failed: ${e.message}\n${e.stderr ?? ""}`,
    );
  }
}

/** jest's file lists, at the repo root. */
export function jestLists(changed, cwd = ROOT) {
  const jest = path.join(cwd, "node_modules", ".bin", "jest");
  const rel = (out) =>
    out
      .split("\n")
      .filter(Boolean)
      .map((f) => path.relative(cwd, f));
  const allTests = rel(run(jest, ["--listTests"], { cwd }));
  const tests = new Set(allTests);
  // jest's roots are tests/ only; the import graph needs the sources too.
  const roots = SOURCE_ROOTS.filter((r) =>
    fs.existsSync(path.join(cwd, r)),
  ).map((r) => `<rootDir>/${r}`);
  const srcs = changed.filter(
    (f) =>
      !tests.has(f) &&
      /\.[cm]?[jt]sx?$/.test(f) &&
      fs.existsSync(path.join(cwd, f)),
  );
  const related = srcs.length
    ? rel(
        run(
          jest,
          ["--roots", ...roots, "--findRelatedTests", ...srcs, "--listTests"],
          { cwd },
        ),
      )
    : [];
  return { allTests, related };
}

const CATALOG = /^src\/ui\/server\/public\/i18n\/[^/]+\.js$/;

/** The tests that import `file`, directly or not (jest's import graph). */
function jestImporters(file, cwd = ROOT) {
  if (!fs.existsSync(path.join(cwd, file))) return [];
  const jest = path.join(cwd, "node_modules", ".bin", "jest");
  const roots = SOURCE_ROOTS.filter((r) =>
    fs.existsSync(path.join(cwd, r)),
  ).map((r) => `<rootDir>/${r}`);
  return run(
    jest,
    ["--roots", ...roots, "--findRelatedTests", file, "--listTests"],
    { cwd },
  )
    .split("\n")
    .filter(Boolean)
    .map((f) => path.relative(cwd, f));
}

async function main(argv) {
  const pos = [];
  const opt = { out: "", summary: "", map: DEFAULT_MAP };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) opt[k.slice(2)] = argv[++i];
    else pos.push(k);
  }
  const [base, head] = pos;
  if (!base || !head) {
    console.error(
      "usage: affected-tests.mjs <base> <head> [--out <file>] [--summary <file>] [--map <file>]",
    );
    return 2;
  }
  const changed = run(
    "git",
    ["diff", "--name-only", "--no-renames", `${base}...${head}`],
    { cwd: ROOT },
  )
    .split("\n")
    .filter(Boolean);
  const map = loadMap(opt.map);
  // The page rules written from today's code join the file's: a spec or
  // page added since the file was last written still runs (never fewer).
  const { buildRules } = await import("./affected-map.mjs");
  map.rules = [...map.rules, ...buildRules(map)];
  const { allTests, related } = jestLists(changed);
  // Rules that run a helper's importers, or the specs naming a changed key.
  const fired = map.rules.filter((r) => changed.some(matcher(r.when)));
  const importersOf = {};
  for (const imp of new Set(fired.flatMap((r) => r.importers ?? [])))
    importersOf[imp] = jestImporters(imp);
  let mentioned = [];
  const catalogs = changed.filter((f) => CATALOG.test(f));
  if (fired.some((r) => r.mentions) && catalogs.length) {
    const { keys, texts } = catalogChanges(
      run(
        "git",
        ["diff", "-U0", "--no-renames", `${base}...${head}`, "--", ...catalogs],
        { cwd: ROOT },
      ),
    );
    const en = path.join(
      ROOT,
      "src",
      "ui",
      "server",
      "public",
      "i18n",
      "en.js",
    );
    const enSource = fs.existsSync(en) ? fs.readFileSync(en, "utf-8") : "";
    const specs = Object.fromEntries(
      allTests
        .filter((t) => t.endsWith(".browser.test.ts"))
        .map((t) => [t, fs.readFileSync(path.join(ROOT, t), "utf-8")]),
    );
    mentioned = specsMentioning(specs, keys, [
      ...texts,
      ...englishTexts(keys, enSource),
    ]);
  }
  const sel = selectTests({
    changed,
    allTests,
    related,
    map,
    importersOf,
    mentioned,
    named: testsNamingPaths(
      changed,
      Object.fromEntries(
        allTests.map((t) => [t, fs.readFileSync(path.join(ROOT, t), "utf-8")]),
      ),
    ),
    ranFirst: ranFirstTests(),
  });
  if (sel.all)
    console.log(
      `ALL  (${sel.files.size} files) because: ${sel.allBecause.join(", ")}`,
    );
  else
    for (const [f, why] of sel.files) console.log(`${f}  # ${why.join("; ")}`);
  if (opt.out)
    fs.writeFileSync(
      opt.out,
      sel.all ? "ALL\n" : [...sel.files.keys()].join("\n") + "\n",
    );
  if (opt.summary)
    fs.appendFileSync(opt.summary, summaryMarkdown(sel, changed.length));
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
