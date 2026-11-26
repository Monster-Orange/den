import { describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = path.join(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "test-health.mjs");
const REPO = "o/r";
const NOW = "2026-11-30T16:00:00Z";
const SINCE = "2026-11-23";

interface Health {
  window: { since: string; until: string };
  pr: {
    heads: number;
    p50Min: number | null;
    p90Min: number | null;
    capped: boolean;
  };
  firstRed: { runs: number; p50Min: number | null; p90Min: number | null };
  flakes: {
    runs: number;
    flakyRuns: number;
    flakyJobs: string[];
    rate: number | null;
  };
  bed: {
    runs: number;
    p50Min: number | null;
    p90Min: number | null;
    longestMin: number | null;
  } | null;
  brittle: Record<string, number> | null;
}

const run = (o: Record<string, unknown>): Record<string, unknown> => ({
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  ...o,
});
const job = (name: string, conclusion: string, start: string, end: string) => ({
  name,
  conclusion,
  started_at: start,
  completed_at: end,
});

function fakeApi(): Record<string, unknown> {
  const runs = [
    run({
      id: 1,
      head_sha: "a",
      created_at: "2026-11-24T10:00:00Z",
      updated_at: "2026-11-24T10:10:00Z",
    }),
    run({
      id: 2,
      head_sha: "a",
      created_at: "2026-11-24T10:01:00Z",
      updated_at: "2026-11-24T10:20:00Z",
    }),
    run({
      id: 3,
      head_sha: "b",
      created_at: "2026-11-25T10:00:00Z",
      updated_at: "2026-11-25T10:30:00Z",
      conclusion: "failure",
    }),
    run({
      id: 4,
      head_sha: "c",
      created_at: "2026-11-26T10:00:00Z",
      updated_at: "2026-11-26T11:00:00Z",
      run_attempt: 2,
    }),
    run({
      id: 5,
      head_sha: "d",
      created_at: "2026-11-27T10:00:00Z",
      updated_at: "2026-11-27T10:05:00Z",
      status: "in_progress",
      conclusion: null,
    }),
  ];
  const byDay: Record<string, unknown> = {};
  for (let d = 23; d <= 30; d++) {
    const date = `2026-11-${d}`;
    byDay[
      `repos/${REPO}/actions/runs?event=pull_request&created=${date}&per_page=100&page=1`
    ] = {
      workflow_runs: runs.filter((r) => String(r.created_at).startsWith(date)),
    };
  }
  return {
    ...byDay,
    [`repos/${REPO}/actions/runs/3/attempts/1/jobs?per_page=100`]: {
      jobs: [
        job("fast", "success", "2026-11-25T10:01:00Z", "2026-11-25T10:02:00Z"),
        job(
          "pr-shards (1)",
          "failure",
          "2026-11-25T10:02:00Z",
          "2026-11-25T10:09:00Z",
        ),
        job(
          "pr-shards (2)",
          "failure",
          "2026-11-25T10:02:00Z",
          "2026-11-25T10:25:00Z",
        ),
      ],
    },
    [`repos/${REPO}/actions/runs/4/attempts/1/jobs?per_page=100`]: {
      jobs: [
        job("fast", "success", "2026-11-26T10:01:00Z", "2026-11-26T10:02:00Z"),
        job(
          "pr-shards (3)",
          "failure",
          "2026-11-26T10:02:00Z",
          "2026-11-26T10:05:00Z",
        ),
      ],
    },
    [`repos/${REPO}/actions/runs/4/attempts/2/jobs?per_page=100`]: {
      jobs: [
        job("fast", "success", "2026-11-26T10:40:00Z", "2026-11-26T10:41:00Z"),
        job(
          "pr-shards (3)",
          "success",
          "2026-11-26T10:41:00Z",
          "2026-11-26T11:00:00Z",
        ),
      ],
    },
  };
}

function bedDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-health-bed-"));
  const put = (name: string, startedAt: string, wallMs: number) => {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(
      path.join(dir, name, "verdict.json"),
      JSON.stringify({ tag: name, startedAt, wallMs, clauses: [] }),
    );
  };
  put("v1-dev.1", "2026-11-24T04:00:00Z", 10 * 60_000);
  put("v1-dev.2", "2026-11-25T04:00:00Z", 30 * 60_000);
  put("old", "2026-11-10T04:00:00Z", 99 * 60_000);
  fs.mkdirSync(path.join(dir, "no-verdict"));
  return dir;
}

function health(bed: string | null): Health {
  const data = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-health-")),
    "api.json",
  );
  fs.writeFileSync(data, JSON.stringify(fakeApi()));
  const js = `
    import * as fs from "node:fs";
    const { health } = await import("./scripts/test-health.mjs");
    const data = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, "utf-8"));
    const api = async (p) => { if (!(p in data)) throw new Error("unexpected GET " + p); return data[p]; };
    const h = await health({ api, repo: ${JSON.stringify(REPO)}, now: new Date(${JSON.stringify(NOW)}), days: 7,
      bedDir: ${JSON.stringify(bed)}, brittle: () => ({ sleeps: 3, positional: 4 }) });
    console.log(JSON.stringify(h));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", js], {
      cwd: ROOT,
      encoding: "utf-8",
    }),
  ) as Health;
}

describe("test health, measured weekly (issue 846)", () => {
  const h = health(bedDir());

  it("covers the last 7 days", () => {
    expect(h.window).toEqual({ since: SINCE, until: "2026-11-30" });
  });

  it("PR CI time per head: first run created to last run finished, p50 and p90; a running head is left out", () => {
    expect(h.pr.heads).toBe(3);
    expect(h.pr.p50Min).toBe(30);
    expect(h.pr.p90Min).toBe(60);
    expect(h.pr.capped).toBe(false);
  });

  it("time to first red: a red run's first job start to its first failed job's end", () => {
    expect(h.firstRed.runs).toBe(2);
    expect(h.firstRed.p50Min).toBe(4);
    expect(h.firstRed.p90Min).toBe(8);
  });

  it("flake rate: a job that failed and then passed on a re-run, over finished runs", () => {
    expect(h.flakes.runs).toBe(4);
    expect(h.flakes.flakyRuns).toBe(1);
    expect(h.flakes.flakyJobs).toEqual(["pr-shards (3)"]);
    expect(h.flakes.rate).toBe(0.25);
  });

  it("live-check bed wall time from the bed's verdict files in the window", () => {
    expect(h.bed).toEqual({ runs: 2, p50Min: 10, p90Min: 30, longestMin: 30 });
  });

  it("the brittle-pattern ratchet's totals", () => {
    expect(h.brittle).toEqual({ sleeps: 3, positional: 4 });
  });

  it("with no bed folder, the bed row is absent, not zero", () => {
    expect(health(null).bed).toBeNull();
  });

  it("prints a table of every number, with a row that says the bed wasn't read", () => {
    const js = `
      const { markdown } = await import("./scripts/test-health.mjs");
      console.log(markdown(${JSON.stringify({ ...h, bed: null })}));`;
    const md = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", js],
      {
        cwd: ROOT,
        encoding: "utf-8",
      },
    );
    for (const want of [
      /PR CI time \| 30\.0 min \| 60\.0 min \| 3 heads/,
      /Time to first red \| 4\.0 min \| 8\.0 min \| 2 red runs/,
      /Flake rate \| 25% \| 1 of 4 runs \| pr-shards \(3\)/,
      /Live-check bed wall time \| not read here/,
      /Brittle patterns \| 7 \| +\| sleeps 3, positional 4/,
    ])
      expect(md).toMatch(want);
  });

  it("refuses to run with no token, naming what it needs", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--repo", REPO], {
      cwd: ROOT,
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/GITHUB_TOKEN/);
  });

  it("runs each Monday, reading Actions only, into the run's summary", () => {
    const wf = yaml.parse(
      fs.readFileSync(
        path.join(ROOT, ".github", "workflows", "test-health.yml"),
        "utf-8",
      ),
    ) as {
      on: { schedule: { cron: string }[] };
      permissions: Record<string, string>;
      jobs: { report: { steps: { run?: string }[] } };
    };
    expect(wf.on.schedule[0]!.cron).toMatch(/^\S+ \S+ \* \* 1$/);
    expect(wf.permissions).toEqual({ actions: "read", contents: "read" });
    const runs = wf.jobs.report.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toMatch(/node scripts\/test-health\.mjs/);
    expect(runs).toMatch(/GITHUB_STEP_SUMMARY/);
  });
});
