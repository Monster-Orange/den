/**
 * Flakes made visible: on a pull request a failed test file runs once
 * more (scripts/flake-retry.js); a pass on retry never goes silent. It is
 * in the job summary's "Flaky on retry" table, in flaky-on-retry.json (a
 * CI artifact), and a warning annotation names it when tests/quarantine.json
 * doesn't. A file red twice still blocks. A push to main and the release
 * never retry: every failure blocks.
 *
 * The runs here use a fake jest (FLAKE_RETRY_JEST): no real jest, no gh.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { failedFiles, retryArgs } from "../../../scripts/flake-retry.js";

const ROOT = process.cwd();
const QUARANTINED = "tests/unit/server/bell-v6.browser.test.ts";

// A jest stand-in: each file named in FAKE_FLAKY fails on its first run
// and passes after; each in FAKE_BROKEN always fails; the rest pass. It
// writes jest's --json shape and exits 1 on a failure, as jest does.
const FAKE = `
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith("--outputFile=")).slice(13);
const files = args.filter((a) => !a.startsWith("-"));
const state = process.env.FAKE_STATE;
const seen = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf-8")) : {};
const list = (v) => (process.env[v] || "").split(",").filter(Boolean);
fs.appendFileSync(state + ".calls", JSON.stringify(args) + "\\n");
const results = files.map((f) => {
  const n = (seen[f] = (seen[f] || 0) + 1);
  const fail = list("FAKE_BROKEN").includes(f) || (list("FAKE_FLAKY").includes(f) && n === 1);
  return {
    name: path.resolve(f),
    status: fail ? "failed" : "passed",
    assertionResults: [{ fullName: "a suite " + (fail ? "the red one" : "the green one"), status: fail ? "failed" : "passed" }],
  };
});
fs.writeFileSync(state, JSON.stringify(seen));
fs.writeFileSync(out, JSON.stringify({ testResults: results }));
process.exit(results.some((r) => r.status === "failed") ? 1 : 0);
`;

let tmp: string;
let fake: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flake-retry-"));
  fake = path.join(tmp, "fake-jest.cjs");
  fs.writeFileSync(fake, FAKE);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function retry(
  name: string,
  args: string[],
  env: Record<string, string>,
): {
  code: number | null;
  stdout: string;
  summary: string;
  artifact: Record<string, unknown>[] | null;
  calls: string[][];
} {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  const out = path.join(dir, "flaky-on-retry.json");
  const sum = path.join(dir, "summary.md");
  fs.writeFileSync(sum, "");
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "flake-retry.js"), "--", ...args],
    {
      cwd: ROOT,
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH ?? "",
        FLAKE_RETRY_JEST: `${process.execPath} ${fake}`,
        FLAKE_RETRY_OUT: out,
        FAKE_STATE: path.join(dir, "state.json"),
        GITHUB_STEP_SUMMARY: sum,
        GITHUB_SHA: "c0ffee",
        GITHUB_RUN_ID: "42",
        GITHUB_JOB: "pr",
        ...env,
      },
    },
  );
  return {
    code: r.status,
    stdout: r.stdout,
    summary: fs.readFileSync(sum, "utf-8"),
    artifact: fs.existsSync(out)
      ? (JSON.parse(fs.readFileSync(out, "utf-8")) as Record<string, unknown>[])
      : null,
    calls: fs
      .readFileSync(path.join(dir, "state.json.calls"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]),
  };
}

describe("a pull request's retry (scripts/flake-retry.js)", () => {
  it("a file that passes on retry: the step passes, and the summary and the artifact name it", () => {
    const r = retry(
      "flaky",
      [
        "--passWithNoTests",
        "--shard=2/4",
        "tests/a.test.ts",
        "tests/b.test.ts",
      ],
      { FAKE_FLAKY: "tests/a.test.ts" },
    );
    expect(r.code).toBe(0);
    expect(r.summary).toContain("### Flaky on retry");
    expect(r.summary).toMatch(
      /\| `tests\/a\.test\.ts` \| a suite the red one \| \*\*no\*\* \|/,
    );
    expect(r.artifact).toEqual([
      expect.objectContaining({
        file: "tests/a.test.ts",
        tests: ["a suite the red one"],
        quarantined: false,
        sha: "c0ffee",
        run: 42,
        job: "pr",
      }),
    ]);
    // the retry: the failed file alone, the same flags but the shard
    expect(
      r.calls[1].filter(
        (a) => !a.startsWith("--json") && !a.startsWith("--outputFile"),
      ),
    ).toEqual(["--passWithNoTests", "tests/a.test.ts"]);
  });

  it("not in tests/quarantine.json: a warning annotation, never a failure", () => {
    const r = retry("warn", ["tests/a.test.ts"], {
      FAKE_FLAKY: "tests/a.test.ts",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /^::warning file=tests\/a\.test\.ts::Flaky on retry: tests\/a\.test\.ts failed, then passed/m,
    );
  });

  it("a file tests/quarantine.json has: in the table, no warning", () => {
    const r = retry("listed", [QUARANTINED], { FAKE_FLAKY: QUARANTINED });
    expect(r.code).toBe(0);
    expect(r.summary).toMatch(/\| yes \|/);
    expect(r.stdout).not.toMatch(/::warning/);
  });

  it("a file red twice blocks, and isn't called a flake", () => {
    const r = retry("broken", ["tests/a.test.ts", "tests/b.test.ts"], {
      FAKE_BROKEN: "tests/b.test.ts",
      FAKE_FLAKY: "tests/a.test.ts",
    });
    expect(r.code).toBe(1);
    expect(r.artifact?.map((f) => f.file)).toEqual(["tests/a.test.ts"]);
    expect(r.calls).toHaveLength(2);
  });

  it("all green: one run, no table, no artifact", () => {
    const r = retry("green", ["tests/a.test.ts"], {});
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.summary).toBe("");
    expect(r.artifact).toBeNull();
  });

  it("reads jest's failed files and keeps the flags but the shard", () => {
    expect(
      failedFiles(
        {
          testResults: [
            {
              name: `${ROOT}/tests/x.test.ts`,
              status: "failed",
              assertionResults: [
                { fullName: "x one", status: "failed" },
                { fullName: "x two", status: "passed" },
              ],
            },
            { name: `${ROOT}/tests/y.test.ts`, status: "passed" },
          ],
        },
        ROOT,
      ),
    ).toEqual([{ file: "tests/x.test.ts", tests: ["x one"] }]);
    expect(
      retryArgs(["--shard=1/4", "--passWithNoTests", "a", "b"], ["b"]),
    ).toEqual(["--passWithNoTests", "b"]);
  });
});

describe("in CI: pull requests retry, main and the release never do", () => {
  interface Step {
    run?: string;
    uses?: string;
    if?: string;
    with?: Record<string, unknown>;
  }
  const wf = (f: string) =>
    yaml.parse(
      fs.readFileSync(path.join(ROOT, ".github", "workflows", f), "utf-8"),
    ) as { jobs: Record<string, { if?: string; steps: Step[] }> };
  const ci = wf("ci.yml");

  it("the pr job's and pr-shards' blocking test steps go through the retry", () => {
    for (const name of ["pr", "pr-shards"]) {
      const runs = ci.jobs[name].steps
        .map((s) => s.run ?? "")
        .filter((r) => /affected\.txt && /.test(r));
      expect([name, runs.length]).toEqual([name, 2]);
      for (const r of runs)
        expect([name, r]).toEqual([
          name,
          expect.stringMatching(/node scripts\/flake-retry\.js -- /),
        ]);
    }
  });

  it("each uploads flaky-on-retry.json as an artifact, red or green", () => {
    for (const name of ["pr", "pr-shards"]) {
      const up = ci.jobs[name].steps.find((s) =>
        s.uses?.startsWith("actions/upload-artifact@"),
      );
      expect([name, up?.with?.path]).toEqual([name, "flaky-on-retry.json"]);
      expect(up?.if).toMatch(/!cancelled\(\)/);
      expect(up?.with?.["if-no-files-found"]).toBe("ignore");
    }
  });

  it("a push to main (and the nightly run) never retries: every failure blocks", () => {
    for (const [name, job] of Object.entries(ci.jobs)) {
      if (name === "pr" || name === "pr-shards") continue;
      const text = JSON.stringify(job);
      expect([name, /flake-retry|retryTimes|--retry/.test(text)]).toEqual([
        name,
        false,
      ]);
    }
    const tests = ci.jobs.tests.steps.map((s) => s.run ?? "").join("\n");
    expect(tests).toMatch(/npm test -- --shard=/);
  });

  it("nor does the release, nor jest's own config", () => {
    expect(
      fs.readFileSync(
        path.join(ROOT, ".github", "workflows", "release.yml"),
        "utf-8",
      ),
    ).not.toMatch(/flake-retry|retryTimes/);
    for (const f of ["jest.config.js", "tests/setup.ts"])
      expect([
        f,
        /retryTimes/.test(fs.readFileSync(path.join(ROOT, f), "utf-8")),
      ]).toEqual([f, false]);
  });
});
