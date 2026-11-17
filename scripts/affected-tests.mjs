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
 *             HTTP, so jest's import graph never reaches them);
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
  }
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
 * Returns { all, allBecause, files: Map<test file, reasons[]> }.
 */
export function selectTests({ changed, allTests, related, map }) {
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
  for (const rule of map.rules) {
    const when = matcher(rule.when);
    const trigger = changed.filter(when);
    if (!trigger.length) continue;
    const run = matcher(rule.run);
    for (const t of allTests)
      if (run(t))
        add(
          t,
          `mapped: ${trigger[0]}${trigger.length > 1 ? ` +${trigger.length - 1}` : ""} (${rule.why})`,
        );
  }
  for (const s of map.smoke) if (tests.has(s)) add(s, "smoke");
  return { all: false, allBecause, files };
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
  map.rules = [...map.rules, ...buildRules()];
  const { allTests, related } = jestLists(changed);
  const sel = selectTests({ changed, allTests, related, map });
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
