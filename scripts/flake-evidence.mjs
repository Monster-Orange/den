#!/usr/bin/env node
/**
 * Issue 397: the evidence a quarantine entry needs (tests/quarantine.json).
 *
 *   node scripts/flake-evidence.mjs <run-id> [--repo owner/name] [--issue N] [--owner who] [--attempt N]
 *
 * For a red CI run: each failed job's failing tests (from its log), and a
 * run on the same head sha where that job passed (another run, or another
 * attempt of this one). It prints one ready-to-paste entry per failing
 * test. With no such run, the entry says so in evidence.note, and names a
 * sibling job of the same run (same shard, other Node) that passed, if one
 * did: weaker evidence, written down as such, never passed off as a rerun.
 *
 * Read-only: GETs on the Actions API through `gh api`. It re-runs, cancels
 * and changes nothing. The tests call evidenceFor() with fake API data.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Jest's failing tests in a job log: [{ file, test }] (test = full name). */
export function failingTests(log) {
  const out = [];
  let file = null;
  const seen = new Set();
  for (const raw of log.split("\n")) {
    // Each log line starts with a timestamp; colour codes go too.
    const line = raw
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
      .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "");
    const f = /^(?:FAIL)\s+(\S+\.test\.ts)/.exec(line);
    if (f) {
      file = f[1];
      continue;
    }
    const t = /^ {2}● (.+?)\s*$/.exec(line);
    if (!t || !file || /^(Test suite failed to run|Console)$/.test(t[1]))
      continue;
    const test = t[1].split(" › ").join(" ");
    const key = `${file}\n${test}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ file, test });
    }
  }
  return out;
}

/** "tests (22.13.0, 4)" → { node: "22.13.0", shard: "4" }, else null. */
function matrixOf(name) {
  const m = /^(.+) \(([^,]+), ([^)]+)\)$/.exec(name);
  return m ? { job: m[1], node: m[2], shard: m[3] } : null;
}

const day = (iso) => (iso ?? "").slice(0, 10);

/**
 * The entries for one red run. `api(path)` answers a GET on
 * repos/<repo>/<path>: parsed JSON, or a log's text.
 */
export async function evidenceFor(
  runId,
  api,
  issue = 397,
  owner = "den-builder",
  attempt = undefined,
) {
  const run = await api(`actions/runs/${runId}`);
  const sha = run.head_sha;
  const jobsOf = async (id, attempt) =>
    (
      await api(
        attempt
          ? `actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`
          : `actions/runs/${id}/jobs?per_page=100`,
      )
    ).jobs;

  // Every attempt of every run of the same workflow on this sha.
  const others = (
    await api(`actions/runs?head_sha=${sha}&per_page=100`)
  ).workflow_runs.filter((r) => r.workflow_id === run.workflow_id);
  const attempts = [];
  for (const r of others)
    for (let a = 1; a <= (r.run_attempt ?? 1); a++)
      attempts.push({ run: r.id, attempt: a, jobs: await jobsOf(r.id, a) });

  // The red attempt: --attempt N (a run re-run green has its red attempt
  // before the last), else the run's last.
  const want = attempt ?? run.run_attempt ?? 1;
  const mine = attempts.find((x) => x.run === run.id && x.attempt === want) ?? {
    run: run.id,
    attempt: want,
    jobs: await jobsOf(run.id, attempt),
  };
  const logs = new Map();
  const logOf = async (id) => {
    if (!logs.has(id))
      logs.set(id, String(await api(`actions/jobs/${id}/logs`)));
    return logs.get(id);
  };
  /** Did this test pass in job `j`? A green job, or its file ran and the test isn't red. */
  const passedIn = async (j, t) => {
    if (j.conclusion === "success") return true;
    if (j.conclusion !== "failure") return false;
    const log = await logOf(j.id);
    const ran = new RegExp(
      `(PASS|FAIL)\\s+${t.file.replace(/[.]/g, "\\.")}\\b`,
    ).test(log);
    return (
      ran &&
      !failingTests(log).some((f) => f.file === t.file && f.test === t.test)
    );
  };
  const entries = [];
  for (const job of mine.jobs.filter((j) => j.conclusion === "failure")) {
    const m = matrixOf(job.name);
    for (const t of failingTests(await logOf(job.id))) {
      const evidence = {
        failed_run: run.id,
        ...(mine.attempt > 1 ? { failed_attempt: mine.attempt } : {}),
        failed_job: job.id,
        job: job.name,
        sha,
      };
      // Best: the same job on the same sha, in another run or attempt.
      let found = null;
      for (const x of attempts) {
        if (x.run === mine.run && x.attempt === mine.attempt) continue;
        const j = x.jobs.find((y) => y.name === job.name);
        if (j && (await passedIn(j, t))) {
          found = { x, j };
          break;
        }
      }
      if (found) {
        evidence.passed_run = found.x.run;
        if (found.x.attempt > 1) evidence.passed_attempt = found.x.attempt;
        evidence.passed_job = found.j.id;
      } else {
        // Weaker, and said so: the same shard on the other Node, this run.
        let sib = null;
        for (const j of mine.jobs) {
          const o = matrixOf(j.name);
          if (
            !m ||
            !o ||
            j.id === job.id ||
            o.job !== m.job ||
            o.shard !== m.shard
          )
            continue;
          if (await passedIn(j, t)) {
            sib = j;
            break;
          }
        }
        if (sib) {
          evidence.passed_run = run.id;
          evidence.passed_job = sib.id;
          evidence.note = `no other run on this sha; the test passed in the same run's ${sib.name} (job ${sib.id}), same sha, other Node`;
        } else {
          evidence.note = `no run on this sha passed it; find a passing run before adding this entry`;
        }
      }
      entries.push({
        file: t.file,
        test: t.test,
        issue,
        owner,
        added: day(new Date().toISOString()),
        evidence,
      });
    }
  }
  return entries;
}

function repoFromGit() {
  const url = execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf-8",
  }).trim();
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`can't read owner/name from ${url}`);
  return m[1];
}

function ghApi(repo) {
  return async (p) => {
    const text = execFileSync(
      "gh",
      ["api", "--allow-escape-sequences", `repos/${repo}/${p}`],
      { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
    );
    return p.endsWith("/logs") ? text : JSON.parse(text);
  };
}

async function main(argv) {
  const runId = argv.find(
    (a, i) => /^\d+$/.test(a) && !/^--(issue|attempt)$/.test(argv[i - 1] ?? ""),
  );
  const r = argv.indexOf("--repo");
  if (!runId) {
    console.error(
      "usage: node scripts/flake-evidence.mjs <run-id> [--repo owner/name] [--issue N] [--owner who] [--attempt N]",
    );
    return 2;
  }
  const repo = r >= 0 ? argv[r + 1] : repoFromGit();
  const i = argv.indexOf("--issue");
  const o = argv.indexOf("--owner");
  const entries = await evidenceFor(
    runId,
    ghApi(repo),
    i >= 0 ? Number(argv[i + 1]) : undefined,
    o >= 0 ? argv[o + 1] : undefined,
    argv.includes("--attempt")
      ? Number(argv[argv.indexOf("--attempt") + 1])
      : undefined,
  );
  if (!entries.length) {
    console.error(`run ${runId}: no failed job with a failing test`);
    return 1;
  }
  console.log(JSON.stringify(entries, null, 2));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e.message ?? e);
      process.exit(1);
    },
  );
