/**
 * Issue 441: `<cli> verify import <file> --env <env> --project <p>`, an
 * outside runner's gate results kept as a Verify run, and `verify remove
 * <run>` for an imported run only. A person's or the CLI's: an agent's
 * session is refused. The environment must be one of verify.environments.
 * Invented names.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cmdVerify } from "../../../src/ui/cli/verify-command.js";
import {
  readRunRecord,
  writeRunRecord,
} from "../../../src/shared/verify/records.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-cli-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const stateDir = path.join(tmp, "state");
const file = path.join(tmp, "verdict.json");
fs.writeFileSync(
  file,
  JSON.stringify({
    tag: "v9.9.9-dev.2",
    sha: "e4f5a6b",
    startedAt: "2026-11-17T21:36:24Z",
    endedAt: "2026-11-17T21:39:56Z",
    clauses: [
      { issue: 7, clause: "a person signs in", verdict: "PASS", ms: 5 },
      {
        issue: 8,
        clause: "the bell clears",
        verdict: "FAIL",
        ms: 5,
        note: "still there",
      },
    ],
  }),
);

async function run(
  args: string[],
  over: { env?: Record<string, string>; verify?: unknown } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdVerify(args, {
    stateDir,
    env: over.env ?? {},
    verifyConfig: () => over.verify ?? { environments: ["bed"] },
    projectExists: (p) => p === "north",
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("verify import", () => {
  it("keeps the file as a run on the imported environment, and says what it holds", async () => {
    const r = await run(["import", file, "--env", "bed", "--project", "north"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /v9\.9\.9-dev\.2 on bed: failed · 2 checks, 2 clauses \(1 passed, 1 failed\)/,
    );
    expect(readRunRecord(stateDir, "north", "v9.9.9-dev.2")).toMatchObject({
      env: "bed",
      source: "import",
      verdict: "failed",
    });
  });

  it("refuses an agent's session, an environment that isn't imported, a project that isn't", async () => {
    const agent = await run(
      ["import", file, "--env", "bed", "--project", "north"],
      {
        env: { DEN_ACTOR_TOKEN: "x" },
      },
    );
    expect([agent.code, agent.err]).toEqual([
      1,
      expect.stringMatching(/a person's: an agent can't change/),
    ]);
    const env = await run([
      "import",
      file,
      "--env",
      "staging",
      "--project",
      "north",
    ]);
    expect([env.code, env.err]).toEqual([
      1,
      expect.stringMatching(/verify\.environments/),
    ]);
    const proj = await run([
      "import",
      file,
      "--env",
      "bed",
      "--project",
      "nowhere",
    ]);
    expect([proj.code, proj.err]).toEqual([
      1,
      expect.stringMatching(/no project "nowhere"/),
    ]);
  });

  it("an untrusted file that isn't a verdict: nothing kept, and why", async () => {
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ tag: "x", clauses: "no" }));
    const r = await run(["import", bad, "--env", "bed", "--project", "north"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not a gate verdict/);
  });

  it("usage: a missing file or flag is exit 2", async () => {
    expect((await run(["import"])).code).toBe(2);
    expect((await run(["import", file, "--project", "north"])).code).toBe(2);
  });
});

describe("verify remove", () => {
  it("removes an imported run only", async () => {
    writeRunRecord(stateDir, {
      runId: "local-1",
      project: "north",
      env: "local",
      scope: "all",
      verdict: "passed",
      exitCode: 0,
      startedAt: "2026-11-17T21:36:24Z",
      endedAt: "2026-11-17T21:39:56Z",
      modules: [],
    });
    const keep = await run(["remove", "local-1", "--project", "north"]);
    expect([keep.code, keep.err]).toEqual([
      1,
      expect.stringMatching(/not an imported run/),
    ]);
    expect(readRunRecord(stateDir, "north", "local-1")).not.toBeNull();
    const gone = await run(["remove", "v9.9.9-dev.2", "--project", "north"]);
    expect(gone.code).toBe(0);
    expect(readRunRecord(stateDir, "north", "v9.9.9-dev.2")).toBeNull();
  });
});
