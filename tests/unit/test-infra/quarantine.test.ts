/**
 * Issue 397: a flaky test with evidence is quarantined (tests/quarantine.json).
 * On a pull request it runs in a separate step that does not block, and
 * the job summary says whether it passed. On main and in the release
 * nothing is left out: the switch (DEN_TEST_QUARANTINE) is off unless set.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const q = require("../../quarantine.cjs") as {
  ageDays(added: string, today?: Date): number;
  entryMatches(
    e: Entry,
    file: string,
    fullName: string,
    title: string,
  ): boolean;
  isQuarantined(
    es: Entry[],
    file: string,
    fullName: string,
    title: string,
  ): boolean;
  loadQuarantine(env?: NodeJS.ProcessEnv): Doc;
  maxAgeDays(doc: Doc, env?: NodeJS.ProcessEnv): number;
  quarantineMode(env?: NodeJS.ProcessEnv): string;
  quarantineProblems(doc: Doc, today?: Date, env?: NodeJS.ProcessEnv): string[];
};

type Entry = {
  file: string;
  test: string;
  issue?: number;
  added?: string;
  evidence?: Record<string, unknown>;
};
type Doc = { max_age_days?: number; entries: Entry[] };

const ROOT = path.join(__dirname, "../../..");
const FIXTURE = "tests/fixtures/quarantine/flaky.fixture.ts";
const FLAKY = "quarantine fixture the flaky one";
const ev = { failed_run: 1, passed_run: 2, sha: "abc" };

describe("which tests a quarantine entry names", () => {
  const e: Entry = {
    file: "tests/unit/a.test.ts",
    test: "group the flaky one",
  };
  it("exactly: the full name or the title, in that file only", () => {
    expect(
      q.entryMatches(
        e,
        "tests/unit/a.test.ts",
        "group the flaky one",
        "the flaky one",
      ),
    ).toBe(true);
    expect(
      q.entryMatches(
        { ...e, test: "the flaky one" },
        "tests/unit/a.test.ts",
        "group the flaky one",
        "the flaky one",
      ),
    ).toBe(true);
    // Its neighbour, a longer name that starts the same, and another file: no.
    expect(
      q.entryMatches(
        e,
        "tests/unit/a.test.ts",
        "group the flaky one's neighbour",
        "the flaky one's neighbour",
      ),
    ).toBe(false);
    expect(
      q.entryMatches(
        e,
        "tests/unit/a.test.ts",
        "group the flaky one too",
        "the flaky one too",
      ),
    ).toBe(false);
    expect(
      q.entryMatches(
        e,
        "tests/unit/b.test.ts",
        "group the flaky one",
        "the flaky one",
      ),
    ).toBe(false);
  });
  it("a /regex/ is tested against the full name", () => {
    const r = { ...e, test: "/^group at 390px, \\w+ shows/" };
    expect(
      q.isQuarantined(
        [r],
        "tests/unit/a.test.ts",
        "group at 390px, focus shows as Tabs",
        "x",
      ),
    ).toBe(true);
    expect(
      q.isQuarantined(
        [r],
        "tests/unit/a.test.ts",
        "group at 1440px, focus shows",
        "x",
      ),
    ).toBe(false);
  });
});

describe("the switch", () => {
  it("is off unless set, and takes only exclude or only", () => {
    expect(q.quarantineMode({})).toBe("");
    expect(q.quarantineMode({ DEN_TEST_QUARANTINE: " " })).toBe("");
    expect(q.quarantineMode({ DEN_TEST_QUARANTINE: "exclude" })).toBe(
      "exclude",
    );
    expect(() => q.quarantineMode({ DEN_TEST_QUARANTINE: "on" })).toThrow(
      /exclude or only/,
    );
  });

  /** jest.config.js as jest reads it, with `env` (an ES module: a child Node). */
  const config = (env: Record<string, string>): Record<string, unknown> => {
    const base = { ...process.env };
    delete base.DEN_TEST_QUARANTINE;
    delete base.DEN_TEST_DOCKER;
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "console.log(JSON.stringify((await import('./jest.config.js')).default))",
        ],
        { cwd: ROOT, env: { ...base, ...env }, encoding: "utf-8" },
      ),
    ) as Record<string, unknown>;
  };
  it("off: jest's config leaves nothing out (main and the release)", () => {
    const c = config({});
    expect(c.testEnvironment).toBe("node");
    expect(c.reporters).toBeUndefined();
    expect(c.testPathIgnorePatterns).toBeUndefined();
  });
  it("on: the quarantine environment and reporter; only also narrows to the files", () => {
    const ex = config({ DEN_TEST_QUARANTINE: "exclude" });
    expect(ex.testEnvironment).toBe("<rootDir>/tests/quarantine-env.cjs");
    expect(ex.testPathIgnorePatterns).toBeUndefined();
    const only = config({ DEN_TEST_QUARANTINE: "only" });
    const pat = (only.testPathIgnorePatterns as string[]).map(
      (p) => new RegExp(p),
    );
    const ignored = (f: string) => pat.some((p) => p.test(path.join(ROOT, f)));
    expect(ignored(q.loadQuarantine().entries[0].file)).toBe(false);
    expect(ignored("tests/unit/test-infra/quarantine.test.ts")).toBe(true);
  });
});

describe("the list stays short-lived (the weekly rule)", () => {
  const today = new Date("2026-11-30T12:00:00Z");
  const entry = (e: Partial<Entry>): Entry => ({
    file: FIXTURE,
    test: FLAKY,
    issue: 397,
    added: "2026-11-20",
    evidence: ev,
    ...e,
  });
  it("every entry in tests/quarantine.json has its issue, its evidence, and is at most the Setting's days old", () => {
    const doc = q.loadQuarantine({});
    expect(q.maxAgeDays(doc, {})).toBe(14);
    expect(q.quarantineProblems(doc, new Date(), {})).toEqual([]);
  });
  it("an entry older than the Setting's days fails; the Setting comes from the file or the env", () => {
    expect(
      q.quarantineProblems(
        { entries: [entry({ added: "2026-11-16" })] },
        today,
        {},
      ),
    ).toEqual([]);
    expect(
      q.quarantineProblems(
        { entries: [entry({ added: "2026-11-15" })] },
        today,
        {},
      ),
    ).toEqual([expect.stringMatching(/15 days old, over 14/)]);
    expect(
      q.quarantineProblems(
        { max_age_days: 7, entries: [entry({})] },
        today,
        {},
      ),
    ).toEqual([expect.stringMatching(/10 days old, over 7/)]);
    expect(
      q.quarantineProblems({ entries: [entry({})] }, today, {
        DEN_QUARANTINE_MAX_AGE_DAYS: "5",
      }),
    ).toEqual([expect.stringMatching(/over 5/)]);
  });
  it("an entry with no issue, or no evidence, fails", () => {
    expect(
      q.quarantineProblems(
        { entries: [entry({ issue: undefined })] },
        today,
        {},
      ),
    ).toEqual([expect.stringMatching(/no issue/)]);
    expect(
      q.quarantineProblems(
        { entries: [entry({ evidence: { failed_run: 1, sha: "a" } })] },
        today,
        {},
      ),
    ).toEqual([expect.stringMatching(/passed_run, or a note/)]);
  });
});

describe("in CI", () => {
  type Step = {
    run?: string;
    env?: Record<string, string>;
    "continue-on-error"?: unknown;
    if?: string;
    id?: string;
  };
  const wf = (f: string) =>
    yaml.parse(
      fs.readFileSync(path.join(ROOT, ".github", "workflows", f), "utf-8"),
    ) as {
      jobs: Record<
        string,
        {
          env?: Record<string, string>;
          steps: Step[];
          strategy?: { matrix: { shard: number[] } };
          "timeout-minutes"?: number;
        }
      >;
    };
  it("only a pull request turns it on, and the quarantined step can't block", () => {
    // Issue 398: pull requests run in the pr job (a small subset) or
    // pr-shards (a large one); main's tests job never sets it.
    const jobs = wf("ci.yml").jobs;
    expect(jobs.tests.env?.DEN_TEST_QUARANTINE).toBeUndefined();
    for (const name of ["pr", "pr-shards"]) {
      const j = jobs[name];
      expect([name, j.env?.DEN_TEST_QUARANTINE]).toEqual([name, "exclude"]);
      const qs = j.steps.filter((s) => s.env?.DEN_TEST_QUARANTINE === "only");
      expect(qs).toHaveLength(1);
      expect(qs[0]["continue-on-error"]).toBe(true);
      expect(qs[0].if).toMatch(/^\$\{\{ !cancelled\(\)/);
    }
    const shardStep = jobs["pr-shards"].steps.find(
      (s) => s.env?.DEN_TEST_QUARANTINE === "only",
    );
    // The big pull-request run splits as many ways as main's tests job, and
    // has the same room: in four parts a shard ran past a 20-min limit.
    const pick = (
      jobs.pr.steps.find((s) => s.id === "select")?.run ?? ""
    ).match(/shards=\[([\d,]+)\]/);
    const n = pick ? pick[1].split(",").length : 0;
    expect(n).toBe(wf("ci.yml").jobs.tests.strategy!.matrix.shard.length);
    for (const st of jobs["pr-shards"].steps.filter((s) =>
      (s.run ?? "").includes("--shard="),
    ))
      expect(st.run).toContain(`--shard=\${{ matrix.shard }}/${n}`);
    expect(shardStep?.run).toContain(`--shard=\${{ matrix.shard }}/${n}`);
    expect(jobs["pr-shards"]["timeout-minutes"]).toBeGreaterThanOrEqual(30);
  });
  it("the release never sets it", () => {
    for (const f of ["release.yml", "release-gates.yml", "release-dry-run.yml"])
      expect([
        f,
        /DEN_TEST_QUARANTINE/.test(
          fs.readFileSync(path.join(ROOT, ".github", "workflows", f), "utf-8"),
        ),
      ]).toEqual([f, false]);
  });
});

describe("a quarantined test that fails (red first)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-quarantine-"));
  const list = path.join(dir, "quarantine.json");
  fs.writeFileSync(
    list,
    JSON.stringify({
      entries: [
        {
          file: FIXTURE,
          test: FLAKY,
          issue: 397,
          added: "2026-11-17",
          evidence: ev,
        },
      ],
    }),
  );
  /** The fixture in a child jest, with the flaky test failing. */
  const run = (mode: string) => {
    const out = path.join(dir, `${mode || "off"}.json`);
    const summary = path.join(dir, `${mode || "off"}.md`);
    fs.writeFileSync(summary, "");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEN_QUARANTINE_FIXTURE_FAIL: "1",
      GITHUB_STEP_SUMMARY: summary,
    };
    delete env.DEN_TEST_DOCKER;
    delete env.JEST_WORKER_ID;
    if (mode) {
      env.DEN_TEST_QUARANTINE = mode;
      env.DEN_TEST_QUARANTINE_FILE = list;
    } else delete env.DEN_TEST_QUARANTINE;
    const r = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "node_modules", "jest", "bin", "jest.js"),
        "--forceExit",
        "--ci",
        "--maxWorkers=1",
        "--testMatch",
        "**/tests/fixtures/quarantine/*.fixture.ts",
        "--json",
        "--outputFile",
        out,
      ],
      { cwd: ROOT, env, encoding: "utf-8", timeout: 120_000 },
    );
    const json = JSON.parse(fs.readFileSync(out, "utf-8")) as {
      testResults: {
        assertionResults: { fullName: string; status: string }[];
      }[];
    };
    const status = Object.fromEntries(
      json.testResults.flatMap((f) =>
        f.assertionResults.map((a) => [a.fullName, a.status]),
      ),
    );
    return {
      code: r.status,
      status,
      summary: fs.readFileSync(summary, "utf-8"),
    };
  };

  it("a PR's blocking run leaves it out (exit 0) and says so; its neighbour still runs", () => {
    const r = run("exclude");
    expect(r.status).toEqual({
      [FLAKY]: "pending",
      [`${FLAKY}'s neighbour`]: "passed",
    });
    expect(r.code).toBe(0);
    expect(r.summary).toMatch(/left out of this blocking run/);
    expect(r.summary).toContain(
      `| left out (runs in the quarantine step) | ${FLAKY} | ${FIXTURE} | #397 |`,
    );
  }, 150_000);

  it("the PR's quarantine step runs only it, and the summary says it failed", () => {
    const r = run("only");
    expect(r.status).toEqual({
      [FLAKY]: "failed",
      [`${FLAKY}'s neighbour`]: "pending",
    });
    // Red: CI's continue-on-error is what keeps this from blocking.
    expect(r.code).not.toBe(0);
    expect(r.summary).toContain(`| failed | ${FLAKY} | ${FIXTURE} | #397 |`);
  }, 150_000);

  it("main and the release (switch off): it runs and blocks", () => {
    const r = run("");
    expect(r.status).toEqual({
      [FLAKY]: "failed",
      [`${FLAKY}'s neighbour`]: "passed",
    });
    expect(r.code).not.toBe(0);
    expect(r.summary).toBe("");
  }, 150_000);
});

describe("scripts/flake-evidence.mjs (fake Actions API data, no network)", () => {
  const SHA = "f00dfeed";
  const log = (lines: string[]) =>
    lines.map((l) => `2026-11-17T20:04:43.0000000Z ${l}`).join("\n");
  const failing = log([
    "FAIL tests/unit/server/x.browser.test.ts (20.4 s)",
    "  ● group › the flaky one",
    "    expect(received).toBe(expected)",
    "  ● Console",
    "PASS tests/unit/server/y.test.ts",
  ]);
  const sibling = log([
    "PASS tests/unit/server/x.browser.test.ts (12 s)",
    "FAIL tests/unit/z.test.ts",
    "  ● z › real red",
  ]);
  /** GET path → answer; the module under test asks only these. */
  const fake = (rerun: boolean): Record<string, unknown> => {
    const jobs1 = {
      jobs: [
        { id: 11, name: "tests (22.13.0, 4)", conclusion: "failure" },
        { id: 12, name: "tests (24.13.0, 4)", conclusion: "failure" },
        { id: 13, name: "checks (22.13.0)", conclusion: "success" },
      ],
    };
    return {
      "actions/runs/100": {
        id: 100,
        head_sha: SHA,
        workflow_id: 7,
        run_attempt: 1,
      },
      [`actions/runs?head_sha=${SHA}&per_page=100`]: {
        workflow_runs: [
          { id: 100, workflow_id: 7, run_attempt: 1 },
          ...(rerun ? [{ id: 200, workflow_id: 7, run_attempt: 1 }] : []),
          { id: 300, workflow_id: 9, run_attempt: 1 },
        ],
      },
      "actions/runs/100/attempts/1/jobs?per_page=100": jobs1,
      "actions/runs/200/attempts/1/jobs?per_page=100": {
        jobs: [{ id: 21, name: "tests (22.13.0, 4)", conclusion: "success" }],
      },
      "actions/jobs/11/logs": failing,
      "actions/jobs/12/logs": sibling,
    };
  };
  const evidence = (rerun: boolean): Entry[] => {
    const data = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "den-flake-")),
      "api.json",
    );
    fs.writeFileSync(data, JSON.stringify(fake(rerun)));
    const js = `
      import * as fs from "node:fs";
      const { evidenceFor } = await import("./scripts/flake-evidence.mjs");
      const data = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, "utf-8"));
      const api = async (p) => { if (!(p in data)) throw new Error("unexpected GET " + p); return data[p]; };
      console.log(JSON.stringify(await evidenceFor(100, api)));`;
    return JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", js], {
        cwd: ROOT,
        encoding: "utf-8",
      }),
    ) as Entry[];
  };

  it("a rerun on the same sha where the job passed: a ready entry", () => {
    const es = evidence(true);
    expect(es.map((e) => [e.file, e.test, e.issue])).toEqual([
      ["tests/unit/server/x.browser.test.ts", "group the flaky one", 397],
      ["tests/unit/z.test.ts", "z real red", 397],
    ]);
    expect(es[0].evidence).toEqual({
      failed_run: 100,
      failed_job: 11,
      job: "tests (22.13.0, 4)",
      sha: SHA,
      passed_run: 200,
      passed_job: 21,
    });
    expect(es[0].added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("no rerun: the same shard on the other Node, said so in a note; a test red there too has no evidence", () => {
    const [flaky, real] = evidence(false);
    expect(flaky.evidence).toMatchObject({
      failed_run: 100,
      passed_run: 100,
      passed_job: 12,
    });
    expect(String(flaky.evidence?.note)).toMatch(
      /no other run on this sha.*other Node/,
    );
    expect(real.evidence?.passed_run).toBeUndefined();
    expect(String(real.evidence?.note)).toMatch(/find a passing run/);
  });
});
