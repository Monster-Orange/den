/**
 * The static tests (tests/static-tests.json): the fast consistency checks
 * that need no server, no browser, no Docker and no child process. CI runs
 * them first, in one short job (ci.yml's static job), and every test job
 * waits for it: a red version-sync or token check fails in about a minute,
 * not after the 10-13 minute shards.
 *
 * The rule, checked by tests/unit/test-infra/static-tests.test.ts:
 *   - the file, and every file it imports from this repo (followed to the
 *     end), imports no child-process, network-server, browser or Docker
 *     module (FORBIDDEN below);
 *   - no file in that chain is a test helper that starts a server or a
 *     child (FORBIDDEN_LOCAL);
 *   - it is not a browser or integration test;
 *   - it runs in under the list's max_seconds: CI's static job checks each
 *     file's time on CI's own clock (timing() below).
 *
 * The command line is scripts/static-tests.mjs. Paths are relative to the
 * checkout (the working directory by default).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
export const LIST = "tests/static-tests.json";

/** Modules a static test never reaches: processes, servers, browsers, Docker. */
export const FORBIDDEN = [
  "child_process",
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "cluster",
  "worker_threads",
  "execa",
  "cross-spawn",
  "node-pty",
  "express",
  "ws",
  "playwright",
  "playwright-core",
  "@playwright/test",
  "puppeteer",
  "dockerode",
  "testcontainers",
];

/** Test helpers that start a server or a child process. */
export const FORBIDDEN_LOCAL = [
  /^tests\/child-servers\./,
  /^tests\/.*start-den-server/,
  /^tests\/.*browser.*\.(ts|js|mjs|cjs)$/,
  /^tests\/docker-suites\./,
];

const IMPORT_RE =
  /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|(?:^|[^\w$.])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gm;

/** The module specifiers a source file names (type-only imports left out). */
export function specifiers(src) {
  const out = [];
  // comments are not imports
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  for (let m = IMPORT_RE.exec(code); m; m = IMPORT_RE.exec(code)) {
    if (/^\s*import\s+type\b|^\s*export\s+type\b/.test(m[0].trimStart()))
      continue;
    out.push(m[1] ?? m[2]);
  }
  IMPORT_RE.lastIndex = 0;
  return out;
}

const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"];

/** A specifier relative to `from` (or the jest page mappings), as a repo path; null for a package. */
export function resolveLocal(spec, from, root = ROOT) {
  let base;
  const page = /^\/kit\/([\w-]+)\.js$/.exec(spec);
  const pub = /^\/([\w-]+)\.js$/.exec(spec);
  if (page) base = path.join(root, "packages/den-ui/src", `${page[1]}.js`);
  else if (pub) base = path.join(root, "src/ui/server/public", `${pub[1]}.js`);
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  const tries = [base];
  const stem = base.replace(/\.(js|mjs|cjs)$/, "");
  for (const e of EXTS) tries.push(stem + e, path.join(base, "index" + e));
  for (const t of tries)
    if (fs.existsSync(t) && fs.statSync(t).isFile()) return t;
  return base; // unresolved: reported by the caller
}

const bare = (spec) =>
  spec
    .replace(/^node:/, "")
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");

const rel = (abs, root) => path.relative(root, abs).split(path.sep).join("/");

/**
 * Why `file` is not a static test: one line each, empty when it is. Follows
 * every local import to the end.
 */
export function staticViolations(file, root = ROOT) {
  const out = [];
  const seen = new Set();
  const walk = (abs, chain) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    const r = rel(abs, root);
    const via = [...chain, r];
    if (FORBIDDEN_LOCAL.some((re) => re.test(r)) && chain.length)
      out.push(
        `${via.join(" > ")}: a test helper that starts a server or a child`,
      );
    if (!fs.existsSync(abs)) {
      out.push(`${via.join(" > ")}: not found`);
      return;
    }
    if (abs.endsWith(".json")) return;
    const src = fs.readFileSync(abs, "utf-8");
    for (const spec of specifiers(src)) {
      const local = resolveLocal(spec, abs, root);
      if (local) walk(local, via);
      else if (FORBIDDEN.includes(bare(spec)))
        out.push(`${via.join(" > ")}: imports ${spec}`);
    }
  };
  walk(path.resolve(root, file), []);
  return out;
}

/** Every test file under tests/ (jest's testMatch: **\/*.test.ts). */
export function testFiles(root = ROOT) {
  return fs
    .readdirSync(path.join(root, "tests"), { recursive: true })
    .map((f) => `tests/${String(f).split(path.sep).join("/")}`)
    .filter((f) => f.endsWith(".test.ts") && !f.includes("/node_modules/"))
    .sort();
}

export function loadList(root = ROOT) {
  const doc = JSON.parse(fs.readFileSync(path.join(root, LIST), "utf-8"));
  if (!Array.isArray(doc.files) || !Number.isFinite(doc.max_seconds))
    throw new Error(`${LIST}: needs "files" and "max_seconds"`);
  return doc;
}

/** What is wrong with the list: one line each. */
export function listProblems(doc, root = ROOT) {
  const out = [];
  const seen = new Set();
  for (const f of doc.files) {
    if (seen.has(f)) out.push(`${f}: listed twice`);
    seen.add(f);
    if (!/^tests\/.+\.test\.ts$/.test(f)) out.push(`${f}: not a test file`);
    if (/\.browser\.test\.ts$|\.integration\.test\.ts$/.test(f))
      out.push(`${f}: a browser or integration test is never static`);
    for (const v of staticViolations(f, root)) out.push(v);
  }
  return out;
}

/**
 * jest --json results against the limit: { rows: [{file, seconds}], slow,
 * missing, failed }. `seconds` is the file's own run time (start to end).
 */
export function timing(results, doc, root = ROOT) {
  const rows = (results.testResults ?? []).map((t) => ({
    file: rel(path.resolve(root, t.name ?? t.testFilePath), root),
    seconds:
      ((t.perfStats?.end ?? t.endTime ?? 0) -
        (t.perfStats?.start ?? t.startTime ?? 0)) /
      1000,
    status: t.status,
  }));
  const ran = new Set(rows.map((r) => r.file));
  return {
    rows: rows.sort((a, b) => b.seconds - a.seconds),
    slow: rows.filter((r) => r.seconds > doc.max_seconds),
    missing: doc.files.filter((f) => !ran.has(f)),
    failed: rows.filter((r) => r.status !== "passed"),
  };
}
