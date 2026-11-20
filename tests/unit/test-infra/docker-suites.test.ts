/**
 * Issue 296: a test file that starts Docker containers is listed in
 * tests/docker-suites.mjs, so CI runs it after the browser tests and never
 * beside them (a container's interface change fails a page's requests in
 * Chromium with net::ERR_NETWORK_CHANGED). And CI's test jobs run the two
 * halves one after the other.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = path.join(__dirname, "../../..");

/** The list, as jest.config.js reads it (an ES module: a child Node). */
const DOCKER_SUITES = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "console.log(JSON.stringify((await import('./tests/docker-suites.mjs')).DOCKER_SUITES));",
    ],
    { cwd: ROOT, encoding: "utf-8" },
  ),
) as string[];

/** Every *.test.ts under tests/, relative to the checkout. */
function testFiles(dir = path.join(ROOT, "tests")): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(p));
    else if (e.name.endsWith(".test.ts"))
      out.push(path.relative(ROOT, p).split(path.sep).join("/"));
  }
  return out;
}

/** Starts a container: `docker run`, or the edge helpers' dockerOk(). */
const STARTS = /dockerOk\(|["']docker["'],\s*\[\s*["']run["']/;

describe("test files that start Docker containers (issue 296)", () => {
  it("are the ones tests/docker-suites.mjs lists", () => {
    const found = testFiles()
      .filter((f) => f !== "tests/unit/test-infra/docker-suites.test.ts")
      .filter((f) => STARTS.test(fs.readFileSync(path.join(ROOT, f), "utf-8")))
      .sort();
    expect(found).toEqual([...DOCKER_SUITES].sort());
  });

  it("run after the rest in CI's and the release's test jobs", () => {
    // the release's tests: release-gates.yml, which release.yml and its dry run call (issue 615)
    for (const f of ["ci.yml", "release-gates.yml"]) {
      const doc = yaml.parse(
        fs.readFileSync(path.join(ROOT, ".github", "workflows", f), "utf-8"),
      ) as {
        jobs: {
          tests: { steps: { run?: string; env?: Record<string, string> }[] };
        };
      };
      const runs = doc.jobs.tests.steps
        .filter((s) => s.run?.startsWith("npm test"))
        .map((s) => [s.env?.DEN_TEST_DOCKER ?? null]);
      expect([f, runs]).toEqual([f, [["skip"], ["only"]]]);
    }
  });

  it("gate every publish in the release: both halves pass before anything ships", () => {
    type Job = {
      needs?: string | string[];
      "continue-on-error"?: unknown;
      steps?: { run?: string; "continue-on-error"?: unknown }[];
    };
    const doc = yaml.parse(
      fs.readFileSync(
        path.join(ROOT, ".github", "workflows", "release.yml"),
        "utf-8",
      ),
    ) as { jobs: Record<string, Job> };
    const needs = (j: string): string[] => {
      const n = doc.jobs[j]?.needs ?? [];
      return typeof n === "string" ? [n] : n;
    };
    /** Every job `j` waits on, directly or through another job. */
    const upstream = (j: string, seen = new Set<string>()): Set<string> => {
      for (const n of needs(j))
        if (!seen.has(n)) {
          seen.add(n);
          upstream(n, seen);
        }
      return seen;
    };
    // A failed step fails the tests job (in release-gates.yml, the gates
    // job here), and every publishing job waits on it.
    for (const j of ["publish", "den-ui"])
      expect([j, upstream(j).has("gates")]).toEqual([j, true]);
    expect((doc.jobs.gates as { uses?: string } | undefined)?.uses).toBe(
      "./.github/workflows/release-gates.yml",
    );
    const gates = yaml.parse(
      fs.readFileSync(
        path.join(ROOT, ".github", "workflows", "release-gates.yml"),
        "utf-8",
      ),
    ) as { jobs: Record<string, Job> };
    const t = gates.jobs.tests;
    expect(t["continue-on-error"]).toBeUndefined();
    for (const s of (t.steps ?? []).filter((x) =>
      x.run?.startsWith("npm test"),
    ))
      expect(s["continue-on-error"]).toBeUndefined();
  });
});
