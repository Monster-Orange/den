#!/usr/bin/env node
/**
 * Issue 398: writes the rules of tests/affected-map.json from the code, so
 * the map follows new pages and specs instead of going stale.
 *
 *   node scripts/affected-map.mjs           rewrite the rules
 *   node scripts/affected-map.mjs --check   exit 1 if the file is out of date
 *
 * Browser specs load pages over HTTP, so jest's import graph never links a
 * page's scripts to them. The rules say it instead:
 *   - each page (public/*.html) loads its public/*.js, transitively (the
 *     import lines, `/x.js` or `./x.js`); each spec opens pages by URL
 *     (`/agents`, `${base}/settings`, `/` is the local-dev page);
 *   - a public file runs the specs of every page that loads it;
 *   - and tests that read files by path rather than import them: the
 *     public/ and src/ walkers, the docs, changelog and examples readers,
 *     and tests that run a scripts/ file;
 *   - each test that starts Den as a process, when its subject changes
 *     (issue 708; below).
 * --check also fails on a test that starts Den with no subject, unless it
 * is on the map's `subjectless` list (which only shrinks).
 * The everything list, the smoke set and $comment are kept as they are.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp } from "./affected-tests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAP = path.join(ROOT, "tests", "affected-map.json");
const PUB = "src/ui/server/public";
const SELF = "tests/unit/test-infra/affected-tests.test.ts";

/** The route a spec opens → the page file the server sends for it. */
const PAGES = {
  agents: "agents.html",
  settings: "settings.html",
  services: "services.html",
  "local-dev": "local-dev.html",
  graph: "local-dev.html",
  verify: "verify.html",
  "test-runs": "index.html",
  "index.html": "index.html",
  environments: "environments.html",
  release: "release.html",
  edge: "edge.html",
  logs: "logs.html",
  "server-agent": "server-agent.html",
  "embed-connect": "embed-connect.html",
  embed: "embed.html",
  error: "error.html",
};
const ROUTE = new RegExp(
  `(?<=["'\`}t])/(${Object.keys(PAGES)
    .map((k) => k.replace(".", "\\."))
    .join("|")})(?:\\.html)?(?=["'\`?#/$]|\\$\\{)`,
  "g",
);

/** The tests that walk src/ for a ratchet or a rule (by hand: few, stable). */
const SRC_WALKERS = [
  "tests/unit/scripts/words.test.ts",
  "tests/unit/no-fixture-names.test.ts",
  "tests/unit/server/project-wording.test.ts",
  "tests/unit/cli/no-server-imports.test.ts",
];

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

function listTests(dir = "tests") {
  return fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory())
        return e.name === "fixtures" || e.name === "node_modules"
          ? []
          : listTests(p);
      return e.name.endsWith(".test.ts") ? [p] : [];
    })
    .sort();
}

/** The public files a page or module loads (not shell.js: it is "everything"). */
function imports(file) {
  const out = new Set();
  for (const m of read(`${PUB}/${file}`).matchAll(
    /["'`(]\.?\/(kit\/)?([a-z0-9-]+\.(?:js|css))/g,
  )) {
    if (m[1] || m[2] === "shell.js") continue;
    if (fs.existsSync(path.join(ROOT, PUB, m[2]))) out.add(m[2]);
  }
  return [...out];
}

function closure(file) {
  const seen = new Set();
  const todo = [file];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    todo.push(...imports(f));
  }
  return seen;
}

/** The pages a browser spec opens. */
export function pagesOpened(text) {
  const pages = new Set([...text.matchAll(ROUTE)].map((m) => PAGES[m[1]]));
  if (/SERVED_PAGES|served-pages/.test(text))
    Object.values(PAGES).forEach((p) => pages.add(p));
  // `${base}/` or "/?ws=…": the root, the local-dev page (the server-agent
  // page on a fresh Den).
  if (/(?<=["'`}])\/(\?[^"'`]*)?["'`]/.test(text)) pages.add("local-dev.html");
  if (pages.has("local-dev.html") && /fresh/i.test(text))
    pages.add("server-agent.html");
  if (/error-frame-server|sendErrorPage|error\.html/.test(text))
    pages.add("error.html");
  return pages;
}

// --- tests that start Den as a process (issue 708) -------------------------
//
// A test that runs bin/den, or tsx on a src/ entry, or the server through
// startDenServer, reaches Den over a pipe or HTTP: no import links it to
// the modules that process loads. Linking it to the entry's whole import
// closure would run it for nearly any change (the server loads most of
// src/), so each one is linked to its subject instead:
//   - the src files named like the test (hub-delivery.integration →
//     hub-delivery.ts, hub-delivery-loop.ts, hub-delivery-service.ts);
//   - the src files it names, by path or by file name;
//   - the globs the map's `subjects` declares for it.
// One with none fails the selector's test, unless it is on the map's
// `subjectless` list, which only shrinks.

/** Starts Den: bin/den, tsx's cli on an entry, or startDenServer(…). */
const STARTS =
  /(?<!function )startDenServer\(|["']bin["'],\s*["']den["']|["']bin\/den["']\)|["']tsx["'],\s*["']dist["']/;

/** The files under tests/ that `file` imports (relative imports only). */
function testImports(file) {
  const out = [];
  for (const m of read(file).matchAll(
    /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g,
  )) {
    const p = path.posix.join(path.posix.dirname(file), m[1]);
    const ts = p.replace(/\.js$/, ".ts");
    for (const c of [ts, p])
      if (
        c.startsWith("tests/") &&
        fs.existsSync(path.join(ROOT, c)) &&
        fs.statSync(path.join(ROOT, c)).isFile()
      ) {
        out.push(c);
        break;
      }
  }
  return out;
}

/** The given tests that start Den, themselves or through a test helper. */
export function startsDen(tests) {
  const memo = new Map();
  const starts = (f, seen) => {
    if (memo.has(f)) return memo.get(f);
    if (seen.has(f)) return false;
    seen.add(f);
    const r =
      STARTS.test(read(f)) || testImports(f).some((i) => starts(i, seen));
    memo.set(f, r);
    return r;
  };
  return tests.filter((t) => starts(t, new Set()));
}

let srcFiles = null;
const sources = () =>
  (srcFiles ??= fs
    .readdirSync(path.join(ROOT, "src"), { recursive: true })
    .map((f) => `src/${f.split(path.sep).join("/")}`)
    .filter((f) => f.endsWith(".ts"))
    .sort());

/**
 * A test's subject: the src files named like it, the src files its text
 * names (a path, or a file name only one or two src files have), and the
 * globs `declared` gives it.
 */
export function subjectOf(test, text, declared = {}) {
  const src = sources();
  const stem = path.posix
    .basename(test)
    .replace(/\.test\.ts$/, "")
    .replace(/\.(integration|browser|polling)$/, "");
  const out = new Set(
    src.filter((f) => {
      const b = path.posix.basename(f, ".ts");
      return b === stem || b.startsWith(`${stem}-`);
    }),
  );
  for (const m of (text ?? "").matchAll(
    /(?<![\w/.-])((?:src\/[\w/.-]+\/)?[\w.-]+\.ts)\b/g,
  )) {
    const named = m[1].startsWith("src/")
      ? src.filter((f) => f === m[1])
      : src.filter((f) => path.posix.basename(f) === m[1]);
    if (named.length && named.length <= 2) named.forEach((f) => out.add(f));
  }
  for (const g of declared[test] ?? []) out.add(g);
  return [...out].sort();
}

/** Each test that starts Den, with its subject ([] when it has none). */
function starterSubjects(map, tests = listTests()) {
  return startsDen(tests.filter((t) => t !== SELF)).map((t) => [
    t,
    subjectOf(t, read(t), map.subjects ?? {}),
  ]);
}

/**
 * missing: starts Den, has no subject, and isn't on the subjectless list.
 * stale: on the list, but it has a subject now, or starts no Den.
 */
export function subjectGaps(map) {
  const listed = new Set(map.subjectless ?? []);
  const subj = new Map(starterSubjects(map));
  const missing = [...subj]
    .filter(([t, s]) => !s.length && !listed.has(t))
    .map(([t]) => t);
  const stale = [...listed].filter(
    (t) => !subj.has(t) || subj.get(t).length > 0,
  );
  return {
    missing: missing.sort(),
    stale: stale.sort(),
    empty: emptySubjects(map),
  };
}

/**
 * Issue 709: each declared subject names a test that is there, and each
 * of its globs names at least one file in the repo. A typo or a moved
 * file would otherwise count as a subject that never runs the test.
 */
function emptySubjects(map) {
  const files = execFileSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf-8",
  })
    .split("\n")
    .filter(Boolean);
  const out = [];
  for (const [test, globs] of Object.entries(map.subjects ?? {})) {
    if (!fs.existsSync(path.join(ROOT, test))) {
      out.push(`${test}: the test isn't there`);
      continue;
    }
    for (const g of [globs].flat()) {
      const re = typeof g === "string" && g.trim() ? globToRegExp(g) : null;
      if (!re || !files.some((f) => re.test(f)))
        out.push(`${test}: ${JSON.stringify(g)}`);
    }
  }
  return out;
}

const readMap = () => JSON.parse(fs.readFileSync(MAP, "utf-8"));

export function buildRules(map = readMap()) {
  const tests = listTests();
  const specs = tests.filter((t) => t.endsWith(".browser.test.ts"));
  const others = tests.filter(
    (t) => !t.endsWith(".browser.test.ts") && t !== SELF,
  );
  const opens = Object.fromEntries(specs.map((s) => [s, pagesOpened(read(s))]));
  // A spec that starts a Den but names no page: every page (unknown is not
  // "none"). One that starts none (it builds its own page) has none.
  const startsDen = (s) =>
    /signInUrl|\.base|:\$\{port\}|startDenServer|PageServer|errorFrameServer|kitShell/i.test(
      read(s),
    );
  const unknown = specs.filter((s) => !opens[s].size && startsDen(s));

  const pages = fs
    .readdirSync(path.join(ROOT, PUB))
    .filter((f) => f.endsWith(".html"));
  const loadedBy = {};
  for (const p of pages)
    for (const f of closure(p)) (loadedBy[f] ??= new Set()).add(p);
  // One rule per set of pages: the files those pages (and only they) load.
  const groups = {};
  for (const [f, ps] of Object.entries(loadedBy))
    (groups[[...ps].sort().join(",")] ??= []).push(f);
  const rules = Object.entries(groups)
    .sort(
      ([a], [b]) =>
        a.split(",").length - b.split(",").length || a.localeCompare(b),
    )
    .map(([key, files]) => {
      const ps = new Set(key.split(","));
      return {
        when: files.sort().map((f) => `${PUB}/${f}`),
        run: specs.filter(
          (s) => unknown.includes(s) || [...opens[s]].some((p) => ps.has(p)),
        ),
        why: ps.size > 3 ? `loaded by ${ps.size} pages` : [...ps].join(", "),
      };
    });

  rules.push(
    {
      when: [`${PUB}/i18n/**`],
      run: specs.filter((s) => /["'`/=](es|ja)["'`&]/.test(read(s))),
      why: "the es and ja catalogs: the specs that switch language",
    },
    {
      // The catalogs themselves (en.js once the English one moves out of
      // shell.js): the tests that import the en-catalog helper (found by
      // jest's import graph when the selector runs), the words ratchet,
      // the specs that check every page's words, and (mentions) the specs
      // that name a changed key or its English text.
      when: [`${PUB}/i18n/*.js`],
      run: [
        "tests/unit/scripts/words.test.ts",
        "tests/unit/server/i18n-pages.browser.test.ts",
        "tests/unit/server/i18n-shell.browser.test.ts",
        "tests/unit/server/one-url-per-module.browser.test.ts",
        "tests/unit/server/kit-dialog.browser.test.ts",
      ],
      importers: ["tests/unit/server/helpers/en-catalog.ts"],
      mentions: true,
      why: "the UI catalogs",
    },
    {
      when: [`${PUB}/**`],
      run: others.filter(
        (t) =>
          /readdirSync|globSync/.test(read(t)) &&
          /"public"|src\/ui\/server\/public|PUBLIC/.test(read(t)),
      ),
      why: "tests that read every file in public/ (ratchets, tokens, wording, i18n)",
    },
    {
      when: ["src/**"],
      run: SRC_WALKERS,
      why: "tests that walk src/ (words ratchet, fixture names, wording, CLI imports)",
    },
    {
      when: ["docs/**", "README.md", "CONTRIBUTING.md"],
      run: others.filter((t) => /["'`]docs["'`/]|README/.test(read(t))),
      why: "tests that read the docs",
    },
    {
      when: ["CHANGELOG.md"],
      run: tests.filter((t) => t !== SELF && /CHANGELOG/.test(read(t))),
      why: "tests that read the changelog",
    },
    {
      when: ["examples/**"],
      run: others.filter((t) => /["'`]examples["'`/]/.test(read(t))),
      why: "tests that read examples/",
    },
  );
  // Scripts a test runs by path (a spawn is not an import).
  for (const f of fs
    .readdirSync(path.join(ROOT, "scripts"))
    .filter((f) => /\.(m?js|cjs|sh|ts)$/.test(f))
    .sort()) {
    const run = tests.filter((t) => t !== SELF && read(t).includes(f));
    if (run.length)
      rules.push({
        when: [`scripts/${f}`],
        run,
        why: `tests that run scripts/${f}`,
      });
  }
  // Tests that start Den as a process: each runs when its subject changes.
  const starters = starterSubjects(map, tests);
  for (const [t, subject] of starters)
    if (subject.length)
      rules.push({
        when: subject,
        run: [t],
        why: "starts Den as a process: its subject",
      });
  // Issue 728: a test declared in `subjects` that STARTS can't see (it
  // runs a scaffolded distribution's own bin) runs on its globs too.
  const seen = new Set(starters.map(([t]) => t));
  for (const [t, globs] of Object.entries(map.subjects ?? {}))
    if (!seen.has(t))
      rules.push({
        when: [globs].flat().sort(),
        run: [t],
        why: "runs Den as a process (declared): its subject",
      });
  return rules.filter((r) => r.run.length);
}

function main(argv) {
  const map = readMap();
  const rules = buildRules(map);
  if (argv.includes("--check")) {
    const { missing, stale, empty } = subjectGaps(map);
    for (const e of empty)
      console.error(
        `tests/affected-map.json "subjects": ${e} names no file: fix the path or drop it`,
      );
    for (const t of missing)
      console.error(
        `${t} starts Den but has no subject: name it like its module, or add it to "subjects" in tests/affected-map.json`,
      );
    for (const t of stale)
      console.error(
        `${t} is on "subjectless" but has a subject now (or starts no Den): take it off`,
      );
    if (missing.length || stale.length || empty.length) return 1;
    if (JSON.stringify(map.rules) === JSON.stringify(rules)) return 0;
    console.error(
      "tests/affected-map.json is out of date: run node scripts/affected-map.mjs (then prettier)",
    );
    return 1;
  }
  map.rules = rules;
  fs.writeFileSync(MAP, JSON.stringify(map, null, 2) + "\n");
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
