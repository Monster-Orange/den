#!/usr/bin/env node
/**
 * Issue 398: replays the red ci.yml runs of the last N days against the
 * pull-request test subset (scripts/affected-tests.mjs), to prove the subset
 * would have caught every real failure before CI switches to it.
 *
 *   node scripts/ci-replay.mjs [--days 30] [--repo owner/name]
 *        [--cache <dir>] [--map tests/affected-map.json] [--out replay.md]
 *
 * Read only: `gh api` GETs and local git reads. It never re-runs, cancels or
 * changes anything. Every API answer is cached in --cache (default
 * $TMPDIR/den-ci-replay), so a second pass with a changed map is offline
 * apart from new runs.
 *
 * Which runs: every red run on main, and every red pull-request run whose
 * head commit (or a commit with the same tree) later reached main. Earlier
 * attempts of a re-run are read too (a red first attempt hides behind a
 * green re-run).
 *
 * Real or flake, per failing test file (the rule, in this order):
 *   flake  the same head (sha or tree) passed that file in another run or
 *          attempt (the run went green, or its test jobs all finished
 *          without that file failing);
 *   real   it failed again on the same head (a re-run or another run), or
 *          on the next commit of the branch (main: the next push), or the
 *          next commit changed the test file or a file the test imports (a
 *          fix followed);
 *   real?  none of the above (no re-run, and the next commit went green
 *          without touching it). Counted as real: the subset must catch it.
 *
 * For each real failure, the change is the pull request's (main at the
 * run's time ... head, three-dot) or the push's (the previous main push
 * ... head), from `gh api compare`. The subset is computed at that head's
 * tree (jest --listTests and --findRelatedTests in an extracted copy) with
 * today's map. The script exits 1 when any real failure is missed.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { jestLists, loadMap, selectTests } from "./affected-tests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- pure parts (unit-tested) ---------------------------------------------

/** Drops ANSI colour codes and the Actions timestamp at the start of a line. */
export function cleanLog(text) {
  return (
    text
      // ESC starts a colour code: intentional.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""))
      .join("\n")
  );
}

/**
 * The failing test files in a jest log, each with its failing test names.
 * Jest prints `FAIL <file>` then `  ● <suite> › <name>` per failure (and
 * the whole block again in its summary; duplicates fold).
 */
export function parseJestFailures(log) {
  const out = new Map();
  let current = null;
  for (const line of cleanLog(log).split("\n")) {
    const fail = /^FAIL (\S+\.test\.ts)/.exec(line);
    if (fail) {
      current = fail[1];
      if (!out.has(current)) out.set(current, new Set());
      continue;
    }
    if (/^(PASS|Test Suites:|Tests:)/.test(line)) {
      current = null;
      continue;
    }
    const test = /^ {2}● (.+)$/.exec(line);
    if (current && test && test[1] !== "Console")
      out.get(current).add(test[1].trim());
  }
  return [...out].map(([file, tests]) => ({ file, tests: [...tests] }));
}

/** A run attempt's jobs whose names say they run jest. */
export const isTestJob = (name) => /^tests\b|^den-ui-nav\b/.test(name);

/**
 * Real or flake for one failing file at one head.
 * attempt: { key, head, tree, branch, event, at }
 * others: every other attempt read, each { key, head, tree, branch, at,
 *   green, testsFinished, failedFiles: Set }
 * next: the next commit's attempts on the same branch (same shape), and
 * nextChanged: that commit's changed files, nextRelated: the test files
 * related to them (jest --findRelatedTests at the next head).
 */
export function classify({
  file,
  attempt,
  base,
  changed,
  testReadsMarkdown,
  others,
  next,
  nextChanged,
  nextRelated,
}) {
  const sameHead = (o) =>
    o.key !== attempt.key &&
    (o.head === attempt.head || (attempt.tree && o.tree === attempt.tree));
  const passes = (o) =>
    o.green || (o.testsFinished && !o.failedFiles.has(file));
  const same = others.filter(sameHead);
  const passed = same.find(passes);
  if (passed)
    return { verdict: "flake", why: `same head passed in ${passed.key}` };
  const baseRed =
    base && others.find((o) => o.head === base && o.failedFiles.has(file));
  if (baseRed)
    return {
      verdict: "inherited",
      why: `main was already red on it before this change (${baseRed.key})`,
    };
  if (
    changed?.length &&
    changed.every((f) => f.endsWith(".md")) &&
    !testReadsMarkdown
  )
    return {
      verdict: "flake?",
      why: "the change was Markdown only, and the test reads no Markdown",
    };
  const again = same.find((o) => o.failedFiles.has(file));
  if (again)
    return {
      verdict: "real",
      why: `failed again on the same head (${again.key})`,
    };
  const nextFail = (next ?? []).find((o) => o.failedFiles.has(file));
  const nextPassed = (next ?? []).find(passes);
  if (nextFail && nextPassed)
    return {
      verdict: "flake?",
      why: `the next commit failed it too (${nextFail.key}), then passed it on the same sha (${nextPassed.key})`,
    };
  if (nextFail)
    return {
      verdict: "real",
      why: `failed again on the next commit (${nextFail.key})`,
    };
  if ((nextChanged ?? []).includes(file))
    return { verdict: "real", why: "the next commit changed the test" };
  if ((nextRelated ?? []).includes(file))
    return {
      verdict: "real",
      why: "the next commit changed code the test imports",
    };
  if (nextPassed)
    return {
      verdict: "flake?",
      why: `no re-run; the next commit (${nextPassed.key}) passed it with no change to the test or code it imports`,
    };
  return { verdict: "real?", why: "no re-run and no finished next commit" };
}

/**
 * An unconfirmed failure (real?) whose test failed the same way in another
 * change, where it was a flake: a known flaky test, not this change.
 */
export function knownFlakes(rows) {
  return rows.map((r) => {
    if (r.verdict !== "real?") return r;
    const twin = rows.find(
      (o) =>
        o !== r &&
        o.file === r.file &&
        (o.verdict === "flake" || o.verdict === "flake?") &&
        o.tests.some((t) => r.tests.includes(t)),
    );
    return twin
      ? {
          ...r,
          verdict: "flake?",
          why: `the same test failed the same way as a flake in ${twin.run.split(" ")[0]}`,
        }
      : r;
  });
}

/** Real failures: the ones the pull-request subset has to catch. */
export const isReal = (r) => r.verdict === "real" || r.verdict === "real?";

/**
 * Whether the subset (with `map`) runs each real failure's test, from the
 * saved case alone: the change's files, and whether jest related the test
 * to them. A case: { run, file, verdict, why, changed, related: boolean }.
 * (Only the failing file's own selection matters, so it is the only test
 * file the check needs.)
 */
export function recheck(cases, map) {
  return cases.map((c) => {
    const sel = selectTests({
      changed: c.changed,
      allTests: [c.file],
      related: c.related ? [c.file] : [],
      map,
    });
    const caught = sel.all || sel.files.has(c.file);
    // The same without the everything list: what the map itself catches.
    const narrow = selectTests({
      changed: c.changed,
      allTests: [c.file],
      related: c.related ? [c.file] : [],
      map: { ...map, everything: [] },
    });
    return {
      ...c,
      caught,
      caughtByMap: narrow.files.has(c.file),
      caughtWhy: sel.all
        ? `ALL (${sel.allBecause.join(", ")})`
        : caught
          ? sel.files.get(c.file).join("; ")
          : "not in the subset",
    };
  });
}

/** The real failures the subset misses. */
export const missedFailures = (rows) =>
  rows.filter((r) => isReal(r) && !r.caught);

/** The replay as Markdown: the counts, the rule, one row per failing file. */
export function renderReplay(rows, meta) {
  const real = rows.filter(isReal);
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const lines = [
    "# CI replay (issue 398)",
    "",
    `Window: ${meta.since} to ${meta.until}: ${meta.runs} ci.yml runs read; ${meta.red} red attempts in scope (red on main, or red on a pull-request head that reached main); ${rows.length} failing test files in them.`,
    "",
    `- Real failures: **${real.length}** (${count("real")} confirmed, ${count("real?")} unconfirmed and counted as real).`,
    `- Caught by the pull-request subset: **${real.filter((r) => r.caught).length}** of ${real.length}; by the map, related tests and smoke alone (no "everything" trigger): ${real.filter((r) => r.caughtByMap).length}.`,
    `- Flakes: **${count("flake") + count("flake?")}** (${count("flake")} with the same head passing, ${count("flake?")} that went away on the next commit with no fix).`,
    `- Inherited: ${count("inherited")} (main was already red on that test; main's full run is what catches those).`,
    "",
    "Rule, in order: **flake** when the same head (sha or tree) passed the file in another run or attempt; **inherited** when main's run at the change's base had already failed that file; **real** when it failed again on that head, or on the next commit, or the next commit changed the test or code it imports (a fix followed); **flake?** when the next commit passed it with no such change; otherwise **real?** (no re-run, no finished next commit), counted as real.",
    "",
    "| Run | Failing test | Verdict | Changed files | Subset includes it | Map alone | Why |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const real = isReal(r);
    lines.push(
      `| ${r.run} | \`${r.file}\` | ${r.verdict} | ${r.changedCount ?? ""} | ${real ? (r.caught ? "yes" : "**NO**") : "n/a"} | ${real ? (r.caughtByMap ? "yes" : "no") : ""} | ${r.why}${real && r.caughtWhy ? `; subset: ${r.caughtWhy}` : ""} |`,
    );
  }
  if (meta.other?.length) {
    lines.push(
      "",
      "Red jobs with no jest failure in them (checks, dist-smoke; not the subset's job):",
      "",
    );
    for (const o of meta.other) lines.push(`- ${o}`);
  }
  return lines.join("\n") + "\n";
}

// --- I/O ------------------------------------------------------------------

function args(argv) {
  const o = {
    days: 30,
    repo: "",
    cache: "",
    map: "",
    out: "",
    cases: "",
    recheck: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (k in o) o[k] = argv[++i];
  }
  o.days = Number(o.days);
  o.map ||= path.join(ROOT, "tests", "affected-map.json");
  if (o.recheck) return o;
  o.repo ||= execFileSync(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    { encoding: "utf-8" },
  ).trim();
  o.cache ||= path.join(os.tmpdir(), "den-ci-replay");
  o.map ||= path.join(ROOT, "tests", "affected-map.json");
  return o;
}

function makeApi(cache) {
  fs.mkdirSync(cache, { recursive: true });
  return function api(route, { raw = false, fresh = false } = {}) {
    const f = path.join(
      cache,
      route.replace(/[^A-Za-z0-9._-]+/g, "_") + (raw ? ".txt" : ".json"),
    );
    if (!fresh && fs.existsSync(f)) {
      const t = fs.readFileSync(f, "utf-8");
      return raw ? t : JSON.parse(t);
    }
    let out;
    for (let tryNo = 1; ; tryNo++) {
      try {
        out = execFileSync(
          "gh",
          ["api", ...(raw ? ["--allow-escape-sequences"] : []), route],
          {
            encoding: "utf-8",
            maxBuffer: 256 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        break;
      } catch (e) {
        // GitHub answers 502 now and then; a few tries, then give up.
        if (tryNo >= 4 || !/HTTP 5\d\d/.test(String(e.stderr))) throw e;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          3000 * tryNo,
        );
      }
    }
    fs.writeFileSync(f, out);
    return raw ? out : JSON.parse(out);
  };
}

/** Fills the cache for many routes at once (a few gh calls in flight). */
async function prefetch(api, cache, routes, { raw = false, width = 6 } = {}) {
  const run = promisify(execFile);
  const todo = routes.filter(
    (r) =>
      !fs.existsSync(
        path.join(
          cache,
          r.replace(/[^A-Za-z0-9._-]+/g, "_") + (raw ? ".txt" : ".json"),
        ),
      ),
  );
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const r = todo[i++];
      try {
        const { stdout } = await run(
          "gh",
          ["api", ...(raw ? ["--allow-escape-sequences"] : []), r],
          { maxBuffer: 256 * 1024 * 1024 },
        );
        fs.writeFileSync(
          path.join(
            cache,
            r.replace(/[^A-Za-z0-9._-]+/g, "_") + (raw ? ".txt" : ".json"),
          ),
          stdout,
        );
      } catch {
        // The one-at-a-time pass retries it.
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
}

function git(...a) {
  try {
    return execFileSync("git", a, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function listRuns(api, repo, since) {
  const runs = [];
  for (let page = 1; ; page++) {
    const r = api(
      `repos/${repo}/actions/workflows/ci.yml/runs?created=>=${since}&per_page=100&page=${page}`,
      { fresh: true },
    );
    runs.push(...r.workflow_runs);
    if (r.workflow_runs.length < 100) break;
  }
  return runs.filter((r) => r.status === "completed");
}

/** Every attempt of a run, with its jobs and the jest failures of its red test jobs. */
function readAttempts(api, repo, run) {
  const out = [];
  for (let n = 1; n <= run.run_attempt; n++) {
    const a =
      n === run.run_attempt
        ? run
        : api(`repos/${repo}/actions/runs/${run.id}/attempts/${n}`);
    const jobs = [];
    for (let page = 1; ; page++) {
      const j = api(
        `repos/${repo}/actions/runs/${run.id}/attempts/${n}/jobs?per_page=100&page=${page}`,
      );
      jobs.push(...j.jobs);
      if (j.jobs.length < 100) break;
    }
    const failedFiles = new Map();
    const otherRed = [];
    for (const job of jobs) {
      if (job.conclusion !== "failure") continue;
      const steps = (job.steps ?? [])
        .filter((s) => s.conclusion === "failure")
        .map((s) => s.name);
      if (isTestJob(job.name)) {
        let found = [];
        try {
          found = parseJestFailures(
            api(`repos/${repo}/actions/jobs/${job.id}/logs`, { raw: true }),
          );
        } catch {
          // Logs expire; the job still counts as red with no file named.
        }
        for (const f of found) {
          const e = failedFiles.get(f.file) ?? { tests: new Set(), jobs: [] };
          f.tests.forEach((t) => e.tests.add(t));
          e.jobs.push(job.name);
          failedFiles.set(f.file, e);
        }
        if (!found.length)
          otherRed.push(
            `${job.name}: ${steps.join(", ") || "red"} (no FAIL line)`,
          );
      } else otherRed.push(`${job.name}: ${steps.join(", ") || "red"}`);
    }
    const testJobs = jobs.filter((j) => isTestJob(j.name));
    out.push({
      key: `${run.id}#${n}`,
      runId: run.id,
      n,
      head: run.head_sha,
      branch: run.head_branch,
      event: run.event,
      at: a.run_started_at ?? run.created_at,
      green: a.conclusion === "success",
      testsFinished:
        testJobs.length > 0 &&
        testJobs.every(
          (j) => j.conclusion === "success" || j.conclusion === "failure",
        ),
      failedFiles,
      otherRed,
      conclusion: a.conclusion,
    });
  }
  return out;
}

/** Extracts the tree at <sha> (git archive) and lists tests there with jest. */
function jestAt(sha, cache, changed) {
  const dir = path.join(cache, "trees", sha);
  if (!fs.existsSync(path.join(dir, "package.json"))) {
    fs.mkdirSync(dir, { recursive: true });
    const want = [
      "tests",
      "src",
      "packages",
      "scripts",
      "bin",
      "jest.config.js",
      "tsconfig.json",
      "tsconfig.jest.json",
      "package.json",
    ];
    const have = new Set(
      (git("ls-tree", "--name-only", sha) ?? "").split("\n"),
    );
    const paths = want.filter((p) => have.has(p));
    execFileSync(
      "bash",
      [
        "-c",
        'git archive "$1" "${@:3}" | tar -x -C "$2"',
        "bash",
        sha,
        dir,
        ...paths,
      ],
      { cwd: ROOT, shell: false },
    );
    fs.symlinkSync(
      path.join(ROOT, "node_modules"),
      path.join(dir, "node_modules"),
    );
  }
  const { allTests, related } = jestLists(changed, dir);
  return { allTests, related, dir };
}

function changedFiles(api, repo, base, head) {
  const c = api(`repos/${repo}/compare/${base}...${head}?per_page=300`);
  const files = (c.files ?? []).flatMap((f) =>
    f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
  );
  return { files, truncated: (c.files ?? []).length >= 300 };
}

function report(rows) {
  const missed = missedFailures(rows);
  if (missed.length) {
    console.error(
      `ci-replay: the subset misses ${missed.length} real failure(s):`,
    );
    for (const m of missed) console.error(`  ${m.file}  (${m.run})`);
    return 1;
  }
  return 0;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.recheck) {
    // Offline: the saved real failures against a map (no gh, no git).
    const rows = recheck(
      JSON.parse(fs.readFileSync(o.recheck, "utf-8")),
      loadMap(o.map),
    );
    console.log(
      `ci-replay: ${rows.length} real failures, ${rows.filter((r) => r.caught).length} caught with ${path.relative(process.cwd(), o.map)}`,
    );
    process.exitCode = report(rows);
    return;
  }
  const api = makeApi(o.cache);
  const since = new Date(Date.now() - o.days * 864e5)
    .toISOString()
    .slice(0, 10);
  const runs = listRuns(api, o.repo, since).sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const map = loadMap(o.map);

  git("fetch", "-q", "origin", "main");
  const mainTrees = new Set(
    (
      git(
        "log",
        "--format=%T",
        `--since=${o.days + 10} days ago`,
        "origin/main",
      ) ?? ""
    ).split("\n"),
  );
  const treeOf = (sha) => git("rev-parse", `${sha}^{tree}`);
  const reachedMain = (sha) => {
    if (git("merge-base", "--is-ancestor", sha, "origin/main") !== null)
      return true;
    const t = treeOf(sha);
    return Boolean(t && mainTrees.has(t));
  };

  // Every attempt of every red or re-run run: the red ones are the cases,
  // the rest are evidence.
  const reads = runs.filter(
    (r) =>
      !(r.conclusion === "success" && r.run_attempt === 1) &&
      r.conclusion !== "cancelled" &&
      r.conclusion !== "skipped",
  );
  await prefetch(
    api,
    o.cache,
    reads.flatMap((r) =>
      Array.from(
        { length: r.run_attempt },
        (_, k) =>
          `repos/${o.repo}/actions/runs/${r.id}/attempts/${k + 1}/jobs?per_page=100&page=1`,
      ),
    ),
  );
  await prefetch(
    api,
    o.cache,
    reads.flatMap((r) =>
      Array.from(
        { length: r.run_attempt - 1 },
        (_, k) => `repos/${o.repo}/actions/runs/${r.id}/attempts/${k + 1}`,
      ),
    ),
  );
  const logRoutes = [];
  for (const r of reads)
    for (let n = 1; n <= r.run_attempt; n++) {
      const f = path.join(
        o.cache,
        `repos/${o.repo}/actions/runs/${r.id}/attempts/${n}/jobs?per_page=100&page=1`.replace(
          /[^A-Za-z0-9._-]+/g,
          "_",
        ) + ".json",
      );
      if (!fs.existsSync(f)) continue;
      for (const j of JSON.parse(fs.readFileSync(f, "utf-8")).jobs)
        if (j.conclusion === "failure" && isTestJob(j.name))
          logRoutes.push(`repos/${o.repo}/actions/jobs/${j.id}/logs`);
    }
  await prefetch(api, o.cache, logRoutes, { raw: true });

  const attempts = [];
  for (const run of runs) {
    if (run.conclusion === "success" && run.run_attempt === 1) {
      attempts.push({
        key: `${run.id}#1`,
        runId: run.id,
        n: 1,
        head: run.head_sha,
        branch: run.head_branch,
        event: run.event,
        at: run.created_at,
        green: true,
        testsFinished: true,
        failedFiles: new Map(),
        otherRed: [],
        conclusion: "success",
      });
      continue;
    }
    if (run.conclusion === "cancelled" || run.conclusion === "skipped")
      continue;
    attempts.push(...readAttempts(api, o.repo, run));
  }
  for (const a of attempts) a.tree = treeOf(a.head);
  const evidence = attempts.map((a) => ({
    ...a,
    failedFiles: new Set(a.failedFiles.keys()),
  }));

  const scope = attempts.filter(
    (a) =>
      a.conclusion === "failure" &&
      ((a.event === "push" && a.branch === "main") ||
        (a.event === "pull_request" && reachedMain(a.head))),
  );

  const rows = [];
  const other = [];
  const jestCache = new Map();
  const jestFor = (sha, changed) => {
    const k = sha + "\0" + changed.join("\0");
    if (!jestCache.has(k)) jestCache.set(k, jestAt(sha, o.cache, changed));
    return jestCache.get(k);
  };
  // Main's tip when a run started: the newest main push run before it (a
  // fast-forward merge keeps the branch's commit dates, so commit dates
  // alone would put the pull request's own head on main already).
  const mainPushes = runs.filter(
    (r) => r.event === "push" && r.head_branch === "main",
  );
  const mainAt = (iso) =>
    mainPushes.filter((r) => r.created_at < iso).at(-1)?.head_sha ??
    git("rev-list", "-1", "--first-parent", `--before=${iso}`, "origin/main");

  for (const a of scope) {
    for (const r of a.otherRed)
      other.push(
        `${a.key} (${a.event} ${a.branch} ${a.head.slice(0, 7)}): ${r}`,
      );
    if (!a.failedFiles.size) continue;
    // The change under test.
    const base =
      a.event === "push"
        ? git("rev-parse", `${a.head}^1`) // overwritten below by the previous push when known
        : mainAt(a.at);
    let changeBase = base;
    if (a.event === "push") {
      const prev = runs
        .filter(
          (r) =>
            r.event === "push" &&
            r.head_branch === "main" &&
            r.created_at < a.at &&
            r.head_sha !== a.head,
        )
        .at(-1);
      if (prev) changeBase = prev.head_sha;
    }
    const { files: changed, truncated } = changedFiles(
      api,
      o.repo,
      changeBase,
      a.head,
    );
    // The next commit on the same branch.
    const later = evidence.filter(
      (e) =>
        e.branch === a.branch &&
        e.event === a.event &&
        e.at > a.at &&
        e.head !== a.head,
    );
    const nextHead = later[0]?.head;
    const next = nextHead ? evidence.filter((e) => e.head === nextHead) : [];
    let nextChanged = [];
    let nextRelated = [];
    if (nextHead) {
      nextChanged = changedFiles(api, o.repo, a.head, nextHead).files;
      try {
        nextRelated = jestFor(nextHead, nextChanged).related;
      } catch {
        nextRelated = [];
      }
    }
    for (const [file, info] of a.failedFiles) {
      const src = git("show", `${a.head}:${file}`) ?? "";
      const c = classify({
        file,
        attempt: a,
        base: changeBase,
        changed,
        testReadsMarkdown: /\.md\b|["'`]docs["'`/]|CHANGELOG|README/.test(src),
        others: evidence,
        next,
        nextChanged,
        nextRelated,
      });
      const row = {
        // Run id#attempt (actions/runs/<id>/attempts/<n>), branch, head.
        run: `${a.key} ${a.event === "push" ? "main" : a.branch} ${a.head.slice(0, 7)}`,
        file,
        tests: [...info.tests],
        jobs: info.jobs,
        verdict: c.verdict,
        why: c.why,
        changedCount: changed.length + (truncated ? "+" : ""),
        changed,
      };
      row.head = a.head;
      rows.push(row);
    }
  }

  // Only now is every verdict known: a real? can turn out a known flake.
  const final = knownFlakes(rows).map((r) => {
    if (!isReal(r)) return r;
    const t = jestFor(r.head, r.changed);
    return recheck([{ ...r, related: t.related.includes(r.file) }], map)[0];
  });
  rows.length = 0;
  rows.push(...final);
  const md = renderReplay(rows, {
    since,
    until: new Date().toISOString().slice(0, 10),
    runs: runs.length,
    red: scope.length,
    other,
  });
  if (o.out) fs.writeFileSync(o.out, md);
  fs.writeFileSync(
    path.join(o.cache, "replay-rows.json"),
    JSON.stringify(rows, null, 2),
  );
  process.stdout.write(md);
  if (o.cases) {
    const cases = rows
      .filter(isReal)
      .map(({ run, file, verdict, why, changed, related }) => ({
        run,
        file,
        verdict,
        why,
        changed,
        related,
      }));
    fs.writeFileSync(o.cases, JSON.stringify(cases, null, 2) + "\n");
  }
  process.exitCode = report(rows);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
