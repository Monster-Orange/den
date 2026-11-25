#!/usr/bin/env node
/**
 * The release dry run's box watch (issue 1492). The dry run's plan, checks
 * and pack may run on the self-hosted runners (release-dry-run.yml). This
 * runs in a GitHub-hosted job beside them, and makes sure a dry run never
 * waits forever for a box that is offline, or whose runner group won't take
 * the job:
 *
 *   node scripts/release-box-watch.mjs watch
 *     Every 30 s, read this run's jobs. When a box job has waited in the
 *     queue for its minutes and no box job is running, start the dry run
 *     again by hand on the same tag (a run by hand is always GitHub-hosted),
 *     and stop: the dry run's concurrency group cancels this run. When every
 *     other job has finished, stop.
 *     Env: GH_TOKEN (actions: write), GITHUB_REPOSITORY, GITHUB_RUN_ID,
 *     GITHUB_REF_NAME, GITHUB_JOB, WAIT_MINUTES (default 10).
 *     Exit 0: the box ran its jobs, or the hosted run was started. 1: the
 *     API or the new run failed (said in one line).
 *
 *   node scripts/release-box-watch.mjs decide <jobs.json> <now> <minutes>
 *     The rule alone, for the tests: prints wait, done, or fallback and why.
 *     Exit 2: the jobs file can't be read.
 *
 * Only actions: write is needed (read the run's jobs; start a run). It reads
 * no secret, and prints job names and minutes only.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const SELF = process.env.GITHUB_JOB || "box-watch";
const WORKFLOW = "release-dry-run.yml";
const QUEUED = new Set(["queued", "waiting", "pending", "requested"]);

/** The minutes a box job may wait, from text; a bad value is 10. */
export function minutesOf(text) {
  const n = Number(text);
  return text !== "" && text !== undefined && Number.isFinite(n) && n > 0
    ? n
    : 10;
}

/**
 * wait | done | { fallback: why }, from the run's jobs (as the API lists
 * them: name, status, labels, created_at).
 */
export function decide(jobs, nowMs, minutes, self = SELF) {
  const others = jobs.filter((j) => j.name !== self);
  const box = others.filter((j) => (j.labels ?? []).includes("self-hosted"));
  const running = box.some((j) => j.status === "in_progress");
  const stale = box.find(
    (j) =>
      QUEUED.has(j.status) &&
      nowMs - Date.parse(j.created_at) >= minutes * 60_000,
  );
  if (stale && !running) {
    return {
      fallback:
        `no box picked this up in ${minutes} min; the runner group may not allow ${WORKFLOW}. ` +
        `"${stale.name}" waited in the queue with no box job running, ` +
        `so the dry run starts again GitHub-hosted.`,
    };
  }
  if (others.every((j) => j.status === "completed")) return "done";
  return "wait";
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function jobsOf(repo, run) {
  const out = gh([
    "api",
    `repos/${repo}/actions/runs/${run}/jobs?per_page=100`,
    "--jq",
    "[.jobs[] | {name, status, labels, created_at}]",
  ]);
  return JSON.parse(out);
}

async function watch() {
  const repo = process.env.GITHUB_REPOSITORY;
  const run = process.env.GITHUB_RUN_ID;
  const ref = process.env.GITHUB_REF_NAME;
  if (!repo || !/^\d+$/.test(run ?? "") || !ref) {
    console.error(
      "box watch: GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_REF_NAME are needed",
    );
    return 1;
  }
  const minutes = minutesOf(process.env.WAIT_MINUTES ?? "");
  console.log(`box watch: a box job may wait ${minutes} min in the queue`);
  let misses = 0;
  for (;;) {
    let jobs;
    try {
      jobs = jobsOf(repo, run);
      misses = 0;
    } catch {
      // a blip in the API isn't a verdict; five in a row is
      if (++misses >= 5) {
        console.error(
          "box watch: couldn't read this run's jobs 5 times in a row",
        );
        return 1;
      }
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    const v = decide(jobs, Date.now(), minutes);
    if (v === "done") {
      console.log("box watch: every job has finished");
      return 0;
    }
    if (typeof v === "object") {
      console.log(`::warning::${v.fallback}`);
      try {
        gh(["workflow", "run", WORKFLOW, "--repo", repo, "--ref", ref]);
      } catch (e) {
        const line = String(e?.stderr ?? "")
          .split("\n")[0]
          .slice(0, 200);
        console.error(`box watch: couldn't start the hosted run: ${line}`);
        return 1;
      }
      console.log(
        `box watch: started ${WORKFLOW} on ${ref} by hand (GitHub-hosted); this run will be cancelled`,
      );
      return 0;
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

function decideCli([file, now, minutes]) {
  let jobs;
  try {
    jobs = JSON.parse(fs.readFileSync(file, "utf-8")).jobs;
    if (!Array.isArray(jobs)) throw new Error("no jobs");
  } catch {
    console.error("box watch: the jobs file can't be read");
    return 2;
  }
  const v = decide(jobs, Date.parse(now), minutesOf(minutes ?? ""));
  console.log(typeof v === "object" ? `fallback\n${v.fallback}` : v);
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "watch") process.exit(await watch());
else if (cmd === "decide") process.exit(decideCli(rest));
else {
  console.error(
    "usage: release-box-watch.mjs watch | decide <jobs.json> <now> <minutes>",
  );
  process.exit(2);
}
