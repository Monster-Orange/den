import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = path.join(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "brittle-ratchet.mjs");

const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
);
GIT_ENV.GIT_CONFIG_GLOBAL = os.devNull;
GIT_ENV.GIT_CONFIG_NOSYSTEM = "1";
GIT_ENV.GIT_AUTHOR_NAME = GIT_ENV.GIT_COMMITTER_NAME = "test";
GIT_ENV.GIT_AUTHOR_EMAIL = GIT_ENV.GIT_COMMITTER_EMAIL = "test@example.invalid";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: dir,
    env: GIT_ENV,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir: string, files: Record<string, string | null>): string {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (body === null) fs.rmSync(p);
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "change");
  return git(dir, "rev-parse", "HEAD");
}

function run(dir: string, args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, ...args], {
    cwd: dir,
    env: GIT_ENV,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

const sleeps = (n: number) =>
  `test("x", async ({ page }) => {\n${"  await page.waitForTimeout(500);\n".repeat(n)}});\n`;

function week(): { dir: string; then: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brittle-week-"));
  git(dir, "init", "-q", "-b", "main");
  const then = commit(dir, {
    "tests/a.browser.test.ts": sleeps(3),
    "tests/b.browser.test.ts": sleeps(2),
    "gate/7.mjs": sleeps(1),
    "README.md": "x\n",
  });
  commit(dir, {
    "tests/a.browser.test.ts": sleeps(1),
    "gate/7.mjs": null,
    "tests/c.browser.test.ts": sleeps(1),
  });
  return { dir, then };
}

describe("the weekly brittle report (issue 841)", () => {
  it("--report --since counts then and now, and names the files that shrank or grew", () => {
    const { dir, then } = week();
    const r = run(dir, ["--report", "--since", then, "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as {
      totals: Record<string, number>;
      since: { commit: string; totals: Record<string, number> };
      down: { file: string; before: number; after: number }[];
      up: { file: string; before: number; after: number }[];
    };
    expect(j.since.commit).toBe(then);
    expect(j.since.totals.sleeps).toBe(6);
    expect(j.totals.sleeps).toBe(4);
    expect(j.down).toEqual([
      { file: "gate/7.mjs", before: 1, after: 0 },
      { file: "tests/a.browser.test.ts", before: 3, after: 1 },
    ]);
    expect(j.up).toEqual([
      { file: "tests/c.browser.test.ts", before: 0, after: 1 },
    ]);
  });

  it("prints each kind then -> now, and the shrunk files, never failing", () => {
    const { dir, then } = week();
    const r = run(dir, ["--report", "--since", then]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/sleeps\s+6 -> 4 \(-2\)/);
    expect(r.out).toMatch(/2 files went down/);
    expect(r.out).toContain("tests/a.browser.test.ts: 3 -> 1");
    expect(r.out).toMatch(/1 file went up/);
    expect(r.out).toMatch(/both counted with this script's patterns/);
  });

  it("--since alone, or an unknown ref, is refused", () => {
    const { dir } = week();
    expect(run(dir, ["--since", "HEAD~1"]).code).toBe(2);
    const r = run(dir, ["--report", "--since", "no-such-ref"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/no-such-ref/);
  });

  it("a weekly workflow posts it against the last commit of a week ago", () => {
    const wf = yaml.parse(
      fs.readFileSync(
        path.join(ROOT, ".github/workflows/brittle-weekly.yml"),
        "utf8",
      ),
    ) as {
      on: { schedule?: { cron: string }[]; workflow_dispatch?: unknown };
      permissions: Record<string, string>;
      jobs: Record<
        string,
        {
          "runs-on": string;
          steps: {
            run?: string;
            shell?: string;
            uses?: string;
            with?: Record<string, unknown>;
          }[];
        }
      >;
    };
    const cron = wf.on.schedule?.[0]?.cron.split(/\s+/) ?? [];
    expect(cron).toHaveLength(5);
    expect(cron[4]).toMatch(/^[0-6]$/); // one day a week
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(wf.permissions).toEqual({ contents: "read" });
    const [job] = Object.values(wf.jobs);
    expect(job["runs-on"]).toBe("ubuntu-latest");
    const checkout = job.steps.find((s) =>
      (s.uses ?? "").startsWith("actions/checkout"),
    );
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const step = job.steps.find((s) =>
      (s.run ?? "").includes("brittle-ratchet.mjs"),
    );
    expect(step?.run).toMatch(/--before[= ]"?7 days ago/);
    expect(step?.run).toMatch(/--report --since/);
    expect(step?.run).toContain("GITHUB_STEP_SUMMARY");
    expect(
      step?.shell === "bash" || /set -o pipefail/.test(step?.run ?? ""),
    ).toBe(true);
  });
});
