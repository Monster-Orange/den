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
  over: {
    env?: Record<string, string>;
    verify?: unknown;
    orgEnvs?: string[];
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdVerify(args, {
    stateDir,
    env: over.env ?? {},
    verifyConfig: () => over.verify ?? { environments: ["bed"] },
    projectExists: (p) => p === "north",
    orgEnvironments: () => over.orgEnvs ?? ["local", "staging", "production"],
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

describe("issue 441 review: what an import may touch", () => {
  const imp = (env = "bed", o: Parameters<typeof run>[1] = {}) =>
    run(["import", file, "--env", env, "--project", "north"], o);

  it("refuses an agent's session with only DEN_AGENT, no token", async () => {
    const r = await imp("bed", { env: { DEN_AGENT: "release-helper" } });
    expect([r.code, r.err]).toEqual([
      1,
      expect.stringMatching(/a person's: an agent can't change/),
    ]);
  });

  it("never replaces one of Den's own runs with the same id", async () => {
    writeRunRecord(stateDir, {
      runId: "v9.9.9-dev.2",
      project: "north",
      env: "local",
      scope: "all",
      verdict: "passed",
      exitCode: 0,
      startedAt: "2026-11-17T20:00:00.000Z",
      endedAt: "2026-11-17T20:01:00.000Z",
      modules: [],
    } as never);
    const r = await imp();
    expect([r.code, r.err]).toEqual([
      1,
      expect.stringMatching(/"v9\.9\.9-dev\.2" is already one of Den's runs/),
    ]);
    expect(readRunRecord(stateDir, "north", "v9.9.9-dev.2")?.env).toBe("local");
    fs.rmSync(path.join(stateDir, "verify", "north", "runs", "v9.9.9-dev.2"), {
      recursive: true,
    });
  });

  it("never replaces the same tag imported to another environment", async () => {
    const verify = { environments: ["bed", "bed2"] };
    expect((await imp("bed", { verify })).code).toBe(0);
    const r = await imp("bed2", { verify });
    expect([r.code, r.err]).toEqual([
      1,
      expect.stringMatching(/already imported to bed/),
    ]);
    expect(readRunRecord(stateDir, "north", "v9.9.9-dev.2")?.env).toBe("bed");
    // The same environment again replaces it.
    expect((await imp("bed", { verify })).code).toBe(0);
  });

  it("refuses an imported environment named like one of the org's, naming the setting", async () => {
    const r = await imp("local", { verify: { environments: ["local"] } });
    expect([r.code, r.err]).toEqual([
      1,
      expect.stringMatching(
        /"local" is one of Den's own environments: verify\.environments can't name it/,
      ),
    ]);
  });

  it("keeps the times as ISO", async () => {
    expect((await imp()).code).toBe(0);
    expect(readRunRecord(stateDir, "north", "v9.9.9-dev.2")?.endedAt).toBe(
      "2026-11-17T21:39:56.000Z",
    );
  });

  it("reads a regular file only (not a FIFO or a device)", async () => {
    const r = await run([
      "import",
      "/dev/zero",
      "--env",
      "bed",
      "--project",
      "north",
    ]);
    expect([r.code, r.err]).toEqual([
      1,
      expect.stringMatching(/not a regular file/),
    ]);
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
