/**
 * Fail fast: the static tests (tests/static-tests.json) run first, in
 * ci.yml's static job, and every test job waits for it. A red version-sync
 * or token check then fails in about a minute, not after the 10-13 minute
 * shards (the test-cycle audit: the most frequent failing files were these).
 *
 * The list is picked by a rule (scripts/static-tests.mjs), not by hand:
 * each listed file, and everything it imports from this repo, reaches no
 * child-process, server, browser or Docker module; and it runs in under
 * the list's max_seconds, which the static job checks on CI's own clock.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import {
  listProblems,
  loadList,
  specifiers,
  staticViolations,
  timing,
} from "../../../scripts/static-tests.js";

const ROOT = process.cwd();

interface Step {
  name?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  strategy?: { matrix?: { node?: unknown } };
  steps?: Step[];
}

function ci(): Record<string, Job> {
  return (
    yaml.parse(
      fs.readFileSync(
        path.join(ROOT, ".github", "workflows", "ci.yml"),
        "utf-8",
      ),
    ) as { jobs: Record<string, Job> }
  ).jobs;
}

const needs = (j: Job | undefined): string[] =>
  ([] as string[]).concat(j?.needs ?? []);

const runsTests = (j: Job): boolean =>
  (j.steps ?? []).some((s) => /\b(npm test|npx jest)\b/.test(s.run ?? ""));

describe("the static tests (tests/static-tests.json)", () => {
  it("every listed file follows the rule", () => {
    const doc = loadList(ROOT);
    expect(doc.files.length).toBeGreaterThan(0);
    expect(listProblems(doc, ROOT)).toEqual([]);
  });

  it("the audit's fast consistency tests are on it", () => {
    const files = loadList(ROOT).files;
    for (const f of [
      "tests/unit/version-sync.test.ts",
      "tests/unit/server/ui-color-tokens.test.ts",
      "tests/unit/scripts/words.test.ts",
      "tests/unit/cli/cli-page-controls.test.ts",
      "tests/unit/den-ui/tokens.test.ts",
      "tests/unit/cli/no-server-imports.test.ts",
      "tests/unit/server/busy-writes-ratchet.test.ts",
    ])
      expect(files).toContain(f);
  });

  it("the limit is a few seconds a file", () => {
    const doc = loadList(ROOT);
    expect(doc.max_seconds).toBeGreaterThan(0);
    expect(doc.max_seconds).toBeLessThanOrEqual(15);
  });

  describe("the rule", () => {
    let dir: string;
    const write = (f: string, body: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    };
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "static-rule-"));
      write("src/pure.ts", 'import * as fs from "fs";\nexport const a = 1;\n');
      write(
        "src/spawns.ts",
        'import { spawn } from "node:child_process";\nexport const b = spawn;\n',
      );
      write("src/serves.ts", 'export { createServer } from "http";\n');
      write(
        "src/mid.ts",
        'import { b } from "./spawns.js";\nexport const c = b;\n',
      );
      write(
        "src/typed.ts",
        'import type { ChildProcess } from "child_process";\nexport type T = ChildProcess;\n',
      );
      write("tests/child-servers.ts", "export const x = 1;\n");
      write("tests/a.test.ts", 'import { a } from "../src/pure.js";\n');
      write("tests/b.test.ts", 'import { c } from "../src/mid.js";\n');
      write("tests/c.test.ts", 'const s = await import("../src/serves");\n');
      write("tests/d.test.ts", 'import { x } from "./child-servers";\n');
      write(
        "tests/e.test.ts",
        'import type { T } from "../src/typed.js";\n// import "child_process"\n',
      );
      write("tests/f.test.ts", 'const pw = require("playwright");\n');
      write("tests/g.browser.test.ts", 'import { a } from "../src/pure.js";\n');
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("a file that reaches only pure code passes", () => {
      expect(staticViolations("tests/a.test.ts", dir)).toEqual([]);
    });

    it("a child process, two imports away, fails it", () => {
      expect(staticViolations("tests/b.test.ts", dir)).toEqual([
        "tests/b.test.ts > src/mid.ts > src/spawns.ts: imports node:child_process",
      ]);
    });

    it("a server module, by dynamic import and re-export, fails it", () => {
      expect(staticViolations("tests/c.test.ts", dir)).toEqual([
        "tests/c.test.ts > src/serves.ts: imports http",
      ]);
    });

    it("a test helper that starts children fails it", () => {
      expect(staticViolations("tests/d.test.ts", dir)[0]).toMatch(
        /child-servers\.ts: a test helper that starts a server or a child/,
      );
    });

    it("type-only imports and comments don't count", () => {
      expect(staticViolations("tests/e.test.ts", dir)).toEqual([]);
    });

    it("a browser driver by require fails it", () => {
      expect(staticViolations("tests/f.test.ts", dir)).toEqual([
        "tests/f.test.ts: imports playwright",
      ]);
    });

    it("a browser test is never static, even with pure imports", () => {
      expect(
        listProblems(
          { max_seconds: 5, files: ["tests/g.browser.test.ts"] },
          dir,
        ),
      ).toEqual([
        "tests/g.browser.test.ts: a browser or integration test is never static",
      ]);
    });

    it("reads import, export-from, import() and require()", () => {
      expect(
        specifiers(
          'import a from "x";\nimport { b } from \'y\';\nexport * from "z";\nawait import("w");\nrequire("v");\nimport "side";\n',
        ),
      ).toEqual(["x", "y", "z", "w", "v", "side"]);
    });
  });

  describe("the time limit, on CI's clock", () => {
    const doc = {
      max_seconds: 5,
      files: ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"],
    };
    const res = {
      testResults: [
        {
          name: `${ROOT}/tests/a.test.ts`,
          startTime: 1000,
          endTime: 2500,
          status: "passed",
        },
        {
          name: `${ROOT}/tests/b.test.ts`,
          startTime: 1000,
          endTime: 9000,
          status: "passed",
        },
      ],
    };

    it("a file over max_seconds is slow, and a listed file that never ran is missing", () => {
      const t = timing(res, doc, ROOT);
      expect(t.slow.map((r) => [r.file, r.seconds])).toEqual([
        ["tests/b.test.ts", 8],
      ]);
      expect(t.missing).toEqual(["tests/c.test.ts"]);
      expect(t.rows[0].file).toBe("tests/b.test.ts");
    });
  });
});

describe("ci.yml: the static job runs first (fail fast)", () => {
  it("is one short job on Node 22, on pull requests and on push", () => {
    const s = ci().static;
    expect(s).toBeDefined();
    expect(s!.if).toBeUndefined();
    expect(s!.strategy).toBeUndefined();
    const nodes = (s!.steps ?? [])
      .map((st) => st.with?.["node-version"])
      .filter(Boolean);
    expect(nodes).toEqual(["22.13.0"]);
    expect(needs(s)).toEqual([]);
  });

  it("runs the list, checks the rule and each file's time, and reports its wall time", () => {
    const run = (ci().static?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(run).toMatch(/static-tests\.mjs --check/);
    expect(run).toMatch(/static-tests\.mjs --list/);
    expect(run).toMatch(/npx jest .*--json/);
    expect(run).toMatch(
      /static-tests\.mjs --timing .*--summary "\$GITHUB_STEP_SUMMARY"/,
    );
    expect(run).toMatch(/STATIC_WALL_SECONDS/);
  });

  it("every job that runs tests, every shard and the pr job needs it", () => {
    const j = ci();
    const testJobs = Object.entries(j)
      .filter(([name, job]) => name !== "static" && runsTests(job))
      .map(([name]) => name);
    expect(testJobs).toEqual(
      expect.arrayContaining(["tests", "pr", "pr-shards", "den-ui-nav"]),
    );
    for (const name of testJobs)
      expect([name, needs(j[name])]).toEqual([
        name,
        expect.arrayContaining(["static"]),
      ]);
  });

  it("a job with !cancelled() still waits for the static job to pass", () => {
    const j = ci();
    for (const [name, job] of Object.entries(j))
      if (needs(job).includes("static") && /!cancelled\(\)/.test(job.if ?? ""))
        expect([name, job.if]).toEqual([
          name,
          expect.stringContaining("needs.static.result == 'success'"),
        ]);
  });

  it("the checks and the install smoke keep running beside it, not after", () => {
    const j = ci();
    expect(needs(j.checks)).not.toContain("static");
    expect(needs(j["dist-smoke"])).not.toContain("static");
  });
});
