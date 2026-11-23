/**
 * Issue 843: the static checks that fail most often run first, in seconds.
 * One list (scripts/fast-checks.json, run by scripts/fast-checks.mjs) is
 * shared by CI's `fast` job and the pre-push hook. The test jobs and shards
 * wait for `fast`, so a planted version mismatch fails the run in about a
 * minute instead of after a ten-minute shard.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = process.cwd();

interface Step {
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: unknown;
  "timeout-minutes"?: number;
  steps?: Step[];
}

const list = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts", "fast-checks.json"), "utf-8"),
) as { commands: { name: string; run: string[] }[]; jest: string[] };

const ci = yaml.parse(
  fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf-8"),
) as { jobs: Record<string, Job> };

const needs = (j: Job): string[] => ([] as string[]).concat(j.needs ?? []);

describe("issue 843: the fast static checks", () => {
  it("the list names files that exist, and only static ones (no browser, Docker or integration suites)", () => {
    expect(list.jest.length).toBeGreaterThan(0);
    for (const f of list.jest) {
      expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
      expect(f).toMatch(/^tests\/unit\/.+\.test\.ts$/);
      expect(f).not.toMatch(/\.(browser|integration)\.test\.ts$/);
    }
    for (const c of list.commands) {
      expect(c.run[0]).toBe("node");
      expect(fs.existsSync(path.join(ROOT, c.run[1]))).toBe(true);
    }
  });

  it("the list holds the checks that failed most often", () => {
    for (const f of [
      "tests/unit/version-sync.test.ts",
      "tests/unit/scripts/words.test.ts",
      "tests/unit/server/ui-color-tokens.test.ts",
      "tests/unit/den-ui/tokens.test.ts",
    ])
      expect(list.jest).toContain(f);
    const scripts = list.commands.map((c) => c.run[1]);
    expect(scripts).toContain("scripts/words-gate.mjs");
    expect(scripts).toContain("packages/den-ui/bin/den-ui-parity.mjs");
  });

  it("ci.yml: a `fast` job runs the list, on a GitHub-hosted runner, with a short limit", () => {
    const fast = ci.jobs.fast;
    expect(fast).toBeDefined();
    expect(fast["runs-on"]).toBe("ubuntu-latest");
    expect(needs(fast)).toEqual([]);
    expect(fast["timeout-minutes"]).toBeLessThanOrEqual(5);
    const runs = (fast.steps ?? []).map((s) => s.run ?? "");
    expect(runs).toContain("node scripts/fast-checks.mjs");
    // The npm cache keeps npm ci inside the minute.
    const node = (fast.steps ?? []).find((s) =>
      (s.uses ?? "").startsWith("actions/setup-node@"),
    );
    expect(node?.with?.cache).toBe("npm");
  });

  it("ci.yml: the test jobs and shards wait for `fast`", () => {
    for (const name of [
      "tests",
      "pr",
      "pr-shards",
      "den-ui-nav",
      "dist-smoke",
    ]) {
      expect(needs(ci.jobs[name])).toContain("fast");
    }
    // pr-shards and den-ui-nav keep waiting for pr.
    expect(needs(ci.jobs["pr-shards"])).toContain("pr");
    expect(needs(ci.jobs["den-ui-nav"])).toContain("pr");
  });

  it("ci.yml: a job that runs on !cancelled() still stops when `fast` failed", () => {
    for (const [name, job] of Object.entries(ci.jobs)) {
      if (!needs(job).includes("fast")) continue;
      // ci-ok runs no work: it is the verdict, so it must run when fast
      // failed, to fail the required check (ci-ok.test.ts).
      if (name === "ci-ok") continue;
      if (!/!cancelled\(\)|always\(\)/.test(job.if ?? "")) continue;
      expect(`${name}: ${job.if}`).toContain("needs.fast.result == 'success'");
    }
  });

  it("ci.yml: a job that waits for `fast` never runs fast's commands again", () => {
    // A check runs once per tree: the jobs after `fast` keep their other
    // gates (typecheck, lint, org names) and leave the listed ones to it.
    const scripts = list.commands.map((c) => c.run[1]);
    for (const [name, job] of Object.entries(ci.jobs)) {
      if (!needs(job).includes("fast")) continue;
      const text = (job.steps ?? []).map((s) => s.run ?? "").join("\n");
      for (const script of scripts)
        expect([name, script, text.includes(script)]).toEqual([
          name,
          script,
          false,
        ]);
      expect([name, text.includes("gate:den-ui")]).toEqual([name, false]);
    }
  });

  it("ci.yml: on push and dispatch the per-Node checks wait for `fast` too", () => {
    expect(needs(ci.jobs.checks)).toContain("fast");
  });

  describe("the pull request's subset and shards leave out what `fast` ran", () => {
    const fastFile = list.jest[0];
    const other = "tests/unit/server/server-smoke.test.ts";

    // affected-tests.mjs is an ES module: run it in a child Node.
    const affected = (code: string): unknown => {
      const r = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(
            path.join(ROOT, "scripts", "affected-tests.mjs"),
          )}); ${code}`,
        ],
        { cwd: ROOT, encoding: "utf-8" },
      );
      expect(r.stderr).toBe("");
      return JSON.parse(r.stdout);
    };

    it("affected-tests: ranFirstTests() is the list's jest files", () => {
      expect(
        affected("console.log(JSON.stringify(m.ranFirstTests()));"),
      ).toEqual(list.jest);
    });

    it("affected-tests: a selection never holds a file `fast` ran, even one the change touched", () => {
      const input = {
        changed: [fastFile, other],
        allTests: [fastFile, other],
        related: [fastFile],
        map: { everything: [], rules: [], smoke: [] },
        ranFirst: list.jest,
      };
      expect(
        affected(
          `const sel = m.selectTests(${JSON.stringify(input)}); console.log(JSON.stringify([...sel.files.keys()]));`,
        ),
      ).toEqual([other]);
    });

    it("shard-plan: the shards never hold a file `fast` ran (the whole-suite list included)", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-fast-shards-"));
      try {
        const files = path.join(dir, "files.txt");
        fs.writeFileSync(files, [fastFile, other].join("\n") + "\n");
        const out: string[] = [];
        for (let shard = 1; shard <= 6; shard++) {
          const r = spawnSync(
            process.execPath,
            [
              path.join(ROOT, "scripts", "shard-plan.cjs"),
              "--files",
              files,
              "--shard",
              String(shard),
            ],
            { cwd: ROOT, encoding: "utf-8" },
          );
          expect(r.status).toBe(0);
          out.push(...r.stdout.split("\n").filter(Boolean));
        }
        expect(out).toEqual([other]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it(".husky/pre-push runs the same list, with DEN_PREPUSH_FAST=0 to skip it", () => {
    const hook = fs.readFileSync(
      path.join(ROOT, ".husky", "pre-push"),
      "utf-8",
    );
    expect(hook).toContain("scripts/fast-checks.mjs");
    expect(hook).toMatch(/DEN_PREPUSH_FAST:-1\}" != "0"/);
    // The org-name checks stay.
    expect(hook).toContain("scripts/org-name-commits.mjs");
    expect(hook).toContain("scripts/org-name-gate.mjs");
  });

  describe("the hook, run", () => {
    // A stand-in root: a fast-checks script that fails, and no org names
    // (so the hook's org-name part passes quietly).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-fast-hook-"));
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.writeFileSync(
      path.join(dir, "scripts", "fast-checks.mjs"),
      'console.error("planted fast failure"); process.exit(1);\n',
    );
    fs.writeFileSync(
      path.join(dir, "scripts", "org-names.js"),
      "export const orgPatterns = () => [];\n",
    );
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    const push = (env: Record<string, string>) =>
      spawnSync("sh", [path.join(ROOT, ".husky", "pre-push")], {
        cwd: ROOT,
        input: "",
        encoding: "utf-8",
        env: { PATH: process.env.PATH ?? "", DEN_HOOK_ROOT: dir, ...env },
      });

    it("a failing fast check stops the push", () => {
      const r = push({});
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("planted fast failure");
      expect(r.stderr).toContain("DEN_PREPUSH_FAST=0");
    });

    it("DEN_PREPUSH_FAST=0 skips them", () => {
      const r = push({ DEN_PREPUSH_FAST: "0" });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain("planted fast failure");
    });
  });
});
