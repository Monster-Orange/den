/**
 * release.yml's guard: a version is released only from a commit whose
 * ci.yml run for the push to main passed, on both Nodes. A pull request
 * runs its checks on one Node (scripts/pr-nodes.js), so the push run is
 * where every gate meets both; the release never gets ahead of it.
 *
 *   GH_TOKEN=... node scripts/release-ci-green.js <sha>
 *
 * Reads the Actions API (GET only, with the workflow's github.token):
 * ci.yml's runs for <sha> with event push. It waits while that run is
 * queued or running (or not there yet), up to CI_WAIT_MINUTES (a setting,
 * 45 by default), then writes release=true only when the run's conclusion
 * is success and, for each Node in NODES, its tests jobs are there and
 * every job on that Node passed. Anything else: release=false, with one
 * summary line saying why. It never re-runs or changes anything.
 */

/** "tests (22.13.0, 1)" → "22.13.0"; "checks (24.13.0)" → "24.13.0". */
function nodeOf(name) {
  const m = /\((\d+\.\d+\.\d+)(?:,|\))/.exec(name);
  return m ? m[1] : null;
}

/**
 * The verdict on ci.yml's runs for one sha (the API's workflow_runs) and
 * the newest run's jobs: { state: "wait" | "green" | "red", reason }.
 */
export function judge(runs, jobs, sha, nodes) {
  const mine = runs
    .filter((r) => r.head_sha === sha && r.event === "push")
    .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0));
  const short = sha.slice(0, 7);
  if (!mine.length)
    return { state: "wait", reason: `no ci.yml push run for ${short} yet` };
  const run = mine[0];
  const at = `ci.yml run ${run.id} (push, ${short})`;
  if (run.status !== "completed")
    return { state: "wait", reason: `${at} is ${run.status}` };
  if (run.conclusion !== "success")
    return { state: "red", reason: `${at} ended ${run.conclusion}` };
  for (const node of nodes) {
    const on = jobs.filter((j) => nodeOf(j.name) === node);
    if (!on.some((j) => /^tests \(/.test(j.name)))
      return { state: "red", reason: `${at} has no tests job on Node ${node}` };
    const bad = on.filter((j) => j.conclusion !== "success");
    if (bad.length)
      return {
        state: "red",
        reason: `${at}: on Node ${node}, ${bad.map((j) => `${j.name} ${j.conclusion}`).join(", ")}`,
      };
  }
  return {
    state: "green",
    reason: `${at} passed on Node ${nodes.join(" and ")}`,
  };
}

/**
 * Ask until the run finishes or the time is up. `api(path)` GETs
 * repos/<repo>/<path> as JSON; `sleep(ms)` and `now()` are injected so the
 * tests need no clock and no network.
 */
export async function waitForCi({
  api,
  sha,
  nodes,
  waitMinutes,
  pollSeconds = 30,
  sleep,
  now,
}) {
  const end = now() + waitMinutes * 60_000;
  for (;;) {
    const runs = (
      await api(
        `actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=20`,
      )
    ).workflow_runs;
    const newest = runs
      .filter((r) => r.head_sha === sha && r.event === "push")
      .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0))[0];
    let jobs = [];
    if (newest?.status === "completed") {
      for (let page = 1; ; page++) {
        const got = (
          await api(
            `actions/runs/${newest.id}/jobs?filter=latest&per_page=100&page=${page}`,
          )
        ).jobs;
        jobs = jobs.concat(got);
        if (got.length < 100) break;
      }
    }
    const v = judge(runs, jobs, sha, nodes);
    if (v.state !== "wait") return v;
    if (now() + pollSeconds * 1000 > end)
      return {
        state: "red",
        reason: `${v.reason} after ${waitMinutes} min (CI_WAIT_MINUTES): not released`,
      };
    await sleep(pollSeconds * 1000);
  }
}

async function main(argv) {
  const fs = await import("node:fs");
  const sha = argv[0];
  const nodes = (process.env.NODES ?? "").split(/[\s,]+/).filter(Boolean);
  const waitMinutes = Number(process.env.CI_WAIT_MINUTES || 45);
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  if (!sha || !nodes.length || !token || !repo || !(waitMinutes >= 0)) {
    console.error(
      "usage: GH_TOKEN=... GITHUB_REPOSITORY=o/r NODES='22.13.0 24.13.0' node scripts/release-ci-green.js <sha>",
    );
    return 2;
  }
  const api = async (p) => {
    const res = await fetch(`${base}/repos/${repo}/${p}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) throw new Error(`GET ${p}: ${res.status}`);
    return res.json();
  };
  const v = await waitForCi({
    api,
    sha,
    nodes,
    waitMinutes,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  });
  const release = v.state === "green";
  const line = release
    ? `CI guard: ${v.reason}: release goes ahead.`
    : `CI guard: release=false. ${v.reason}.`;
  console.log(release ? line : `::warning::${line}`);
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `release=${release}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  return 0;
}

if (/[\\/]release-ci-green\.js$/.test(process.argv[1] ?? ""))
  main(process.argv.slice(2)).then(
    (c) => (process.exitCode = c),
    (e) => {
      console.error(e.message ?? e);
      process.exitCode = 1;
    },
  );
