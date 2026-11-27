import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = path.join(__dirname, "../../..");
const JEST = path.join(ROOT, "node_modules", "jest", "bin", "jest.js");

function listed(env: Record<string, string>): string[] {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.DEN_TEST_DOCKER;
  delete base.DEN_TEST_BROWSER;
  delete base.DEN_TEST_QUARANTINE;
  return execFileSync(process.execPath, [JEST, "--listTests"], {
    cwd: ROOT,
    env: { ...base, ...env },
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean)
    .map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
}

const isBrowser = (f: string) => f.endsWith(".browser.test.ts");

type Step = { run?: string; env?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

function testSteps(file: string, job: string): (string | null)[][] {
  const doc = yaml.parse(
    fs.readFileSync(path.join(ROOT, ".github", "workflows", file), "utf-8"),
  ) as Workflow;
  return (doc.jobs[job]?.steps ?? [])
    .filter((s) => /(^|&& )npm test /.test(s.run ?? ""))
    .map((s) => [
      s.env?.DEN_TEST_DOCKER ?? null,
      s.env?.DEN_TEST_BROWSER ?? null,
    ]);
}

describe("browser files run apart from the rest (issue 1833)", () => {
  it("DEN_TEST_BROWSER=only lists just the browser files, =skip none of them", () => {
    const all = listed({});
    const only = listed({ DEN_TEST_BROWSER: "only" });
    const skip = listed({ DEN_TEST_BROWSER: "skip" });
    expect(only.length).toBeGreaterThan(0);
    expect(only.every(isBrowser)).toBe(true);
    expect(skip.some(isBrowser)).toBe(false);
    expect([...only, ...skip].sort()).toEqual([...all].sort());
  }, 60_000);

  it("refuses another value", () => {
    expect(() => listed({ DEN_TEST_BROWSER: "first" })).toThrow(
      /DEN_TEST_BROWSER is skip or only/,
    );
  }, 60_000);

  it("every test job runs the browser files, then the rest, then the Docker files", () => {
    const order = [
      ["skip", "only"],
      ["skip", "skip"],
      ["only", null],
    ];
    for (const [file, job] of [
      ["ci.yml", "tests"],
      ["ci.yml", "pr"],
      ["ci.yml", "pr-shards"],
      ["ci.yml", "nightly-node22"],
      ["release-gates.yml", "tests"],
    ])
      expect([file, job, testSteps(file, job)]).toEqual([file, job, order]);
  });
});
