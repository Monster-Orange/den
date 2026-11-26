/**
 * A pull request runs its version-sensitive tests on Node 22 too (the
 * `pr-node22` job, scripts/node22-tests.mjs). The pr job runs Node 24 (npm
 * 11) only (issue 998), so PR 1145's change to
 * tests/unit/scripts/org-names-not-packed.test.ts passed there and failed
 * only in v0.4.90-dev.1's release dry run, on Node 22: npm 10 printed
 * husky's prepare line before `npm pack --json`'s JSON.
 *
 *   - PR 1145's affected list picks that test for Node 22;
 *   - with ALL, every test over Den's scripts and every test that runs npm,
 *     never a browser test and never a test that runs neither;
 *   - a change that touches none of them picks nothing;
 *   - ci.yml runs the job on every pull request on Node 22, with the
 *     script's list, and ci-ok requires it.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "node22-tests.mjs");
const PACKED = "tests/unit/scripts/org-names-not-packed.test.ts";

/** The script's list for these affected lines. */
function pick(lines: string[]): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-node22-"));
  try {
    const list = path.join(dir, "affected.txt");
    fs.writeFileSync(list, `${lines.join("\n")}\n`);
    const r = spawnSync(process.execPath, [SCRIPT, list], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    return r.stdout.split("\n").filter(Boolean);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("the tests a pull request runs again on Node 22", () => {
  it("PR 1145's change: its packed-files test runs on Node 22", () => {
    // What scripts/affected-tests.mjs listed for PR 1145: the changed tests
    // and the words gate's.
    expect(
      pick([
        PACKED,
        "tests/unit/scripts/words.test.ts",
        "tests/unit/server/approvals.test.ts",
      ]),
    ).toEqual([PACKED, "tests/unit/scripts/words.test.ts"]);
  });

  it("ALL: every scripts test and every test that runs npm, no browser test, nothing else", () => {
    const all = pick(["ALL"]);
    expect(all).toContain(PACKED);
    // Runs npm itself (npm pack of the kit), outside tests/unit/scripts.
    expect(all).toContain("tests/unit/den-ui/pin-nav-fonts-esm.test.ts");
    expect(all).not.toContain(
      "tests/unit/scripts/doc-shots-guard.browser.test.ts",
    );
    expect(all).not.toContain("tests/unit/server/approvals.test.ts");
    expect(all.some((f) => f.endsWith(".browser.test.ts"))).toBe(false);
    // A small set: Node 22 never doubles a run.
    expect(all.length).toBeLessThan(60);
  });

  it("a change that touches none of them: nothing", () => {
    expect(
      pick([
        "tests/unit/server/approvals.test.ts",
        "tests/unit/server/agents-layout.browser.test.ts",
      ]),
    ).toEqual([]);
  });
});

describe("ci.yml's pr-node22 job", () => {
  interface Job {
    needs?: string | string[];
    if?: string;
    strategy?: { matrix?: { node?: string[] } };
    steps: { run?: string; with?: Record<string, unknown> }[];
  }
  const ci = yaml.parse(
    fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf-8"),
  ) as { jobs: Record<string, Job> };
  const job = ci.jobs["pr-node22"];

  it("runs on every pull request and merge group, on Node 22, with the script's list", () => {
    expect(job).toBeDefined();
    expect(job.if).toMatch(/pull_request/);
    expect(job.if).toMatch(/merge_group/);
    const node = job.steps.find((s) => s.with?.["node-version"])?.with?.[
      "node-version"
    ];
    expect(String(node)).toMatch(/^22\./);
    const runs = job.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toMatch(/scripts\/affected-tests\.mjs/);
    expect(runs).toMatch(/scripts\/node22-tests\.mjs/);
    expect(runs).toMatch(/npm test/);
  });

  it("a merge-queue run or a version commit takes every version-sensitive test, as the pr job (issue 996)", () => {
    const pick = job.steps.find((s) =>
      (s.run ?? "").includes("node22-tests.mjs"),
    )?.run;
    expect(pick).toMatch(
      /ci-force-all\.mjs "\$GITHUB_EVENT_NAME" "\$BASE"\)" = yes \]; then echo ALL > affected\.txt/,
    );
    // Before the pick, so ALL reaches it.
    expect(pick!.indexOf("ci-force-all.mjs")).toBeLessThan(
      pick!.indexOf("node22-tests.mjs"),
    );
  });

  it("ci-ok requires it", () => {
    expect(([] as string[]).concat(ci.jobs["ci-ok"].needs ?? [])).toContain(
      "pr-node22",
    );
    expect(
      fs.readFileSync(path.join(ROOT, "scripts", "ci-ok.mjs"), "utf-8"),
    ).toMatch(/"pr-node22"/);
  });
});
