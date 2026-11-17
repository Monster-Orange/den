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
    for (const f of ["ci.yml", "release.yml"]) {
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
});
