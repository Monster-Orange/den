import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const CLEAN = "a clean full run under the same load is the check, not a re-run";
const SHA = "abc1234def5678abc1234def5678abc1234def56";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

type Job = { name: string; conclusion: string | null };
interface Gh {
  runs?: {
    id: number;
    run_attempt: number;
    status: string;
    conclusion: string | null;
    html_url: string;
    event?: string;
  }[];
  jobs?: Job[];
  down?: boolean;
  tgz?: string | null;
}

const shards = (bad?: string): Job[] => [
  { name: "fast", conclusion: "success" },
  { name: "pr (24.13.0)", conclusion: "success" },
  ...[1, 2, 3].map((n) => ({
    name: `pr-shards (24.13.0, ${n})`,
    conclusion: `pr-shards (24.13.0, ${n})` === bad ? "failure" : "success",
  })),
  { name: "den-ui-nav", conclusion: "success" },
  { name: "checks", conclusion: "skipped" },
];

function runGate(gh: Gh) {
  const js = `
    const gh = ${JSON.stringify(gh)};
    const sha = ${JSON.stringify(SHA)};
    const asked = [];
    globalThis.fetch = async (u) => {
      const url = String(u);
      asked.push(url);
      if (gh.down) throw new Error("getaddrinfo ENOTFOUND api.github.com");
      const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (/\\/repos\\/acme\\/widget\\/commits\\/[0-9a-f]+$/.test(url)) return ok({ sha });
      if (url.includes("/repos/acme/widget/actions/workflows/ci.yml/runs?") && url.includes("head_sha=" + sha))
        return ok({ workflow_runs: gh.runs ?? [] });
      const m = /\\/repos\\/acme\\/widget\\/actions\\/runs\\/(\\d+)\\/attempts\\/1\\/jobs/.exec(url);
      if (m) return ok({ jobs: gh.jobs ?? [] });
      return new Response("{}", { status: 404 });
    };
    const page = {
      waitForSelector: async () => {},
      evaluate: async (_f, ids) => ids.map((id) => ({ id, shown: true, value: 10, min: "1", max: "3600" })),
      locator: () => ({ scrollIntoViewIfNeeded: async () => {} }),
    };
    const files = {
      "package.json": JSON.stringify({ dependencies: { "@monster-orange/den": gh.tgz === null ? "^0.4.90" : "file:./monster-orange-den-0.4.90-dev.7-" + (gh.tgz ?? "abc1234") + ".tgz" } }),
      "node_modules/@monster-orange/den/package.json": JSON.stringify({ repository: { type: "git", url: "git+https://github.com/acme/widget.git" } }),
    };
    const ctx = {
      api: async (p) => (p === "/api/settings" ? { web_ready: { probeSeconds: 10, startSeconds: 120 } } : {}),
      goto: async () => {},
      shot: async () => {},
      newPage: () => page,
      readBed: (rel) => files[rel] ?? null,
      sleep: async () => {},
      now: () => Date.now(),
    };
    const g = await import("./gate/143.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const out = await runLikeBed("143.mjs", g, ctx);
    console.log(JSON.stringify({ asked, ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    asked: string[];
    rows?: Row[];
    error?: string;
  };
}

const clean = (r: ReturnType<typeof runGate>) =>
  (r.rows ?? []).find((x) => x.clause === CLEAN);
const RUN = {
  id: 777,
  run_attempt: 1,
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/acme/widget/actions/runs/777",
  event: "pull_request",
};

describe("gate/143.mjs: the clean-run clause reads CI's first attempt on the bed's commit", () => {
  it("every shard green on attempt 1: PASS, naming the run with its link", () => {
    const r = runGate({ runs: [RUN], jobs: shards() });
    expect(r.error).toBeUndefined();
    const row = clean(r)!;
    expect(row.ok).toBe(true);
    expect(row.detail).toContain(
      "https://github.com/acme/widget/actions/runs/777",
    );
    expect(row.detail).toContain("abc1234");
  });

  it("a shard that failed: FAIL, naming the shard and the run", () => {
    const r = runGate({
      runs: [{ ...RUN, conclusion: "failure" }],
      jobs: shards("pr-shards (24.13.0, 2)"),
    });
    const row = clean(r)!;
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("pr-shards (24.13.0, 2)");
    expect(row.detail).toContain("actions/runs/777");
  });

  it("a run that was re-run: FAIL, even when its last attempt is green", () => {
    const r = runGate({
      runs: [{ ...RUN, run_attempt: 2 }],
      jobs: shards(),
    });
    const row = clean(r)!;
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/re-run|attempt 2/);
  });

  it("a first attempt with a failed shard stays FAIL after a green re-run", () => {
    const r = runGate({
      runs: [{ ...RUN, run_attempt: 3, conclusion: "success" }],
      jobs: shards("pr-shards (24.13.0, 1)"),
    });
    expect(clean(r)!.ok).toBe(false);
  });

  it("no ci run for the commit: FAIL, saying so", () => {
    const row = clean(runGate({ runs: [], jobs: [] }))!;
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("no ci run");
  });

  it("CI still running: not judged yet, with the run's link", () => {
    const row = clean(
      runGate({
        runs: [{ ...RUN, status: "in_progress", conclusion: null }],
        jobs: [],
      }),
    )!;
    expect(row.ok).toBeNull();
    expect(row.skip).toBe("needs-ci-finished");
    expect(row.detail).toContain("actions/runs/777");
  });

  it("GitHub can't be reached: not judged, saying why", () => {
    const row = clean(runGate({ down: true }))!;
    expect(row.ok).toBeNull();
    expect(row.skip).toBe("needs-github-api");
    expect(row.detail).toContain("ENOTFOUND");
  });

  it("the bed's commit unknown (no packed build): not judged", () => {
    const row = clean(runGate({ tgz: null, runs: [RUN], jobs: shards() }))!;
    expect(row.ok).toBeNull();
    expect(row.skip).toBe("needs-bed-commit");
  });

  it("asks GitHub once per call, for the repo the bed's Den names, never twice per cell", () => {
    const r = runGate({ runs: [RUN], jobs: shards() });
    expect(
      r.asked.every((u) =>
        u.startsWith("https://api.github.com/repos/acme/widget/"),
      ),
    ).toBe(true);
    expect(r.asked).toHaveLength(3);
  });

  it("the setting clause is judged as before", () => {
    const r = runGate({ runs: [RUN], jobs: shards() });
    const first = (r.rows ?? []).find((x) => x.clause !== CLEAN)!;
    expect(first.ok).toBe(true);
  });
});
