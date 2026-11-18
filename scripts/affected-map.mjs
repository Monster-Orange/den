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
 *     and tests that run a scripts/ file.
 * The everything list, the smoke set and $comment are kept as they are.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAP = path.join(ROOT, "tests", "affected-map.json");
const PUB = "src/ui/server/public";
const SELF = "tests/unit/test-infra/affected-tests.test.ts";

/** The route a spec opens → the page file the server sends for it. */
const PAGES = {
  agents: "agents.html",
  // Issue 482: Terminals is agents.html with its own page id.
  terminals: "agents.html",
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

export function buildRules() {
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
  return rules.filter((r) => r.run.length);
}

function main(argv) {
  const map = JSON.parse(fs.readFileSync(MAP, "utf-8"));
  const rules = buildRules();
  if (argv.includes("--check")) {
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
