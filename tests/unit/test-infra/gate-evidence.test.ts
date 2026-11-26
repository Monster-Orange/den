import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.join(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "gate-evidence.mjs");

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-evidence-"));
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
  DEN_ORG_NAMES: "",
};
const git = (...a: string[]) =>
  spawnSync("git", a, { cwd: repo, env, encoding: "utf-8" }).stdout.trim();
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};

const mod = (n: number) =>
  put(path.join("gate", `${n}.mjs`), `export const issue = ${n};\n`);

git("init", "-q", "-b", "main");
mod(101);
put("gate/README.md", "x\n");
git("add", ".");
git("commit", "-q", "-m", "base");
git("checkout", "-q", "-b", "pr");
mod(459);
mod(828);
put("gate/README.md", "y\n");
git("add", ".");
git("commit", "-q", "-m", "pr");

const DIR =
  "/Users/someone/Library/Logs/den-probe/auto/v0.4.90-dev.6-modules-1";
function verdict(clauses: unknown[]) {
  return {
    tag: "v0.4.90-dev.6",
    sha: "cc7fba2f64b6ca2a2a0e9029cf734e36ce6b3c8f",
    overall: "PASS",
    startedPT: "2026-11-25 20:17:15 PST",
    modulesFrom: { commit: "bfb2a91170b44ffd81e26cbacfb352e464fb57de" },
    clauses,
  };
}
const row = (
  issue: number | string,
  verdict: string,
  note = "",
  ms = 1200,
) => ({
  issue,
  clause: `clause of ${issue} ${verdict}`,
  verdict,
  ms,
  evidence: [`${DIR}/evidence/${issue}-shot.png`],
  note,
});

function run(v: unknown, extra: string[] = []) {
  const f = path.join(repo, `v-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(v));
  const r = spawnSync(
    process.execPath,
    [SCRIPT, f, "--base", "main", "--repo", repo, ...extra],
    { encoding: "utf-8", env },
  );
  fs.rmSync(f);
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("gate-evidence: a bed run's verdict as a pull request block (issue 1652)", () => {
  it("prints the tag, the source commit and each clause, and exits 0 when all pass", () => {
    const r = run(
      verdict([
        row(
          459,
          "PASS",
          `connected; view {"url":"http://127.0.0.1:53912/events"} log ${DIR}/harness.log`,
        ),
        row(828, "PASS"),
        row(828, "NOT_RUN", "skip: needs-attested-edge"),
      ]),
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("v0.4.90-dev.6");
    expect(r.out).toContain("bfb2a91170b4");
    expect(r.out).toMatch(/459.*clause of 459 PASS.*PASS/);
    expect(r.out).toContain("needs-attested-edge");
    expect(r.out).toContain("459-shot.png");
    expect(r.out).not.toContain("/Users/");
    expect(r.out).not.toContain("127.0.0.1");
    expect(r.out).not.toContain("den-probe");
  });

  it("lists FAIL and ERROR rows first and exits non-zero", () => {
    const r = run(
      verdict([
        row(459, "PASS"),
        row(828, "PASS"),
        row(828, "FAIL", "the wait ended late"),
        row(459, "ERROR", "module threw"),
      ]),
    );
    expect(r.code).toBe(1);
    const lines = r.out
      .split("\n")
      .filter((l) => l.startsWith("| 4") || l.startsWith("| 8"));
    expect(lines[0]).toMatch(/FAIL|ERROR/);
    expect(lines[1]).toMatch(/FAIL|ERROR/);
    expect(lines[2]).toMatch(/PASS/);
  });

  it("refuses a verdict that misses a module the pull request changes, naming it", () => {
    const r = run(verdict([row(459, "PASS")]));
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("828");
    expect(r.err).not.toContain("459,");
  });

  it("refuses output that names an org from the org-names list", () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "-", "--base", "main", "--repo", repo],
      {
        encoding: "utf-8",
        env: { ...env, DEN_ORG_NAMES: "acme-corp" },
        input: JSON.stringify(
          verdict([row(459, "PASS", "seen at acme-corp"), row(828, "PASS")]),
        ),
      },
    );
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/org name/i);
  });
});
