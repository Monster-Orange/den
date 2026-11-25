/**
 * Issue 1492: the release dry run's box watch (scripts/release-box-watch.mjs).
 * The dry run's plan, checks and pack may go to the self-hosted runners. A
 * GitHub-hosted job watches them: when a box job has waited its minutes in
 * the queue and no box job is running, no box is taking the work, so it
 * starts the dry run again on the same tag, GitHub-hosted (a run by hand),
 * and the dry run's concurrency group cancels the stuck one.
 *
 * `decide` is the rule, given the run's jobs as the API lists them.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.join(process.cwd(), "scripts", "release-box-watch.mjs");
const BOX = ["self-hosted", "den-wsl"];
const HOSTED = ["ubuntu-latest"];
const NOW = "2026-11-25T06:00:00Z";
const ago = (min: number) =>
  new Date(Date.parse(NOW) - min * 60_000).toISOString();

interface Job {
  name: string;
  status: string;
  labels: string[];
  created_at: string;
  completed_at?: string | null;
}
const job = (
  name: string,
  status: string,
  labels: string[],
  minutesAgo = 1,
): Job => ({ name, status, labels, created_at: ago(minutesAgo) });

const done = (j: Job, minutesAgo: number): Job => ({
  ...j,
  status: "completed",
  completed_at: ago(minutesAgo),
});

function decide(jobs: Job[], wait = "10", idleBefore = "no") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-watch-"));
  const file = path.join(dir, "jobs.json");
  fs.writeFileSync(file, JSON.stringify({ jobs }));
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "decide", file, NOW, wait, idleBefore],
    {
      encoding: "utf-8",
      timeout: 10_000,
      // CI runs this test inside a job of its own (GITHUB_JOB=pr-shards):
      // the rule must not take that job's name for the watch's.
      env: { ...process.env, GITHUB_JOB: "pr-shards" },
    },
  );
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

const WATCH = job("box-watch", "in_progress", HOSTED, 12);

describe("the release dry run's box watch", () => {
  it("a box job queued past its minutes, with no box job running: start again hosted, and say why plainly", () => {
    const r = decide([WATCH, job("plan", "queued", BOX, 11)]);
    expect(r.code).toBe(0);
    const [verdict, ...why] = r.out.split("\n");
    expect(verdict).toBe("fallback");
    expect(why.join(" ")).toContain(
      "no box picked this up in 10 min; the runner group may not allow release-dry-run.yml",
    );
  });

  it("a box job queued under its minutes: wait", () => {
    expect(decide([WATCH, job("plan", "queued", BOX, 9)]).out).toBe("wait");
  });

  it("a box job running: wait, even with another queued past its minutes (the box is busy, not gone)", () => {
    const r = decide([
      WATCH,
      job("gates / checks (22.13.0)", "in_progress", BOX, 12),
      job("gates / checks (24.13.0)", "queued", BOX, 12),
    ]);
    expect(r.out).toBe("wait");
  });

  it("hosted jobs queued long never trigger it: only box jobs count", () => {
    const r = decide([
      WATCH,
      job("plan", "completed", BOX, 40),
      job("gates / tests (22.13.0, 1)", "queued", HOSTED, 30),
    ]);
    expect(r.out).toBe("wait");
  });

  it("the last job (gates / pack) completed, and every other job: done", () => {
    const r = decide([
      WATCH,
      job("plan", "completed", BOX, 40),
      job("gates / pack", "completed", BOX, 5),
      job("gates / tests (22.13.0, 1)", "completed", HOSTED, 30),
    ]);
    expect(r.out).toBe("done");
  });

  // Reviewer B: the jobs API lists only the jobs that exist so far. Between
  // plan's end and GitHub creating the gates' jobs, everything listed is
  // completed, and that isn't the end.
  it("plan completed and no gates jobs yet: wait, not done", () => {
    expect(decide([WATCH, job("plan", "completed", BOX, 1)]).out).toBe("wait");
    // the watch's own job never counts
    expect(decide([WATCH]).out).toBe("wait");
  });

  it("all listed jobs completed on two polls in a row, with no pack (plan failed, so the gates never ran): done", () => {
    expect(
      decide([WATCH, job("plan", "completed", BOX, 3)], "10", "yes").out,
    ).toBe("done");
  });

  // Reviewer B: one box runner takes the matrix's legs one after another. A
  // leg that waited behind a long one is healthy, not stuck.
  it("a box job queued 12 min while another box job finished 5 s ago: wait (the box is working)", () => {
    const r = decide([
      WATCH,
      done(job("gates / checks (22.13.0)", "completed", BOX, 12), 5 / 60),
      job("gates / checks (24.13.0)", "queued", BOX, 12),
    ]);
    expect(r.out).toBe("wait");
  });

  it("a box job queued 12 min and the box's last job finished 11 min ago: fall back", () => {
    const r = decide([
      WATCH,
      done(job("plan", "completed", BOX, 30), 11),
      job("gates / checks (24.13.0)", "queued", BOX, 12),
    ]);
    expect(r.out.split("\n")[0]).toBe("fallback");
  });

  it("the minutes come from the argument; a bad value falls back to 10", () => {
    const jobs = [WATCH, job("plan", "queued", BOX, 6)];
    expect(decide(jobs, "5").out.split("\n")[0]).toBe("fallback");
    expect(decide(jobs, "nope").out).toBe("wait");
    expect(decide(jobs, "").out).toBe("wait");
  });

  it("a job list it can't read exits 2", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-watch-"));
    const file = path.join(dir, "jobs.json");
    fs.writeFileSync(file, "not json");
    const r = spawnSync(process.execPath, [SCRIPT, "decide", file, NOW, "10"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(r.status).toBe(2);
  });
});
