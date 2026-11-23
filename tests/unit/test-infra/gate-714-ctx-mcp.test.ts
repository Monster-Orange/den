/**
 * Issue 1213: a live check can hold one MCP session for its whole run
 * (ctx.mcp). The 714 check uses it for clause 1 (the grant line wakes an
 * idle agent; unclaimed, the slot goes to the next in line, and the agent
 * is back in line and told). Without ctx.mcp clause 1 is not run; clauses
 * 2 to 4 need person-only settings (issue 814).
 *
 * Subject: gate/714.mjs, tests/fixtures/gate-mcp-session.mjs and
 * tests/fixtures/gate-runner-like.mjs. No bed: a scripted one
 * (tests/fixtures/gate714-fake-bed.mjs, run as its own node process, as
 * the bed runs a check) stands in for it; the reference session runs
 * against a tiny stdio MCP server.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
type Row = {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
};
type Out = {
  rows?: Row[];
  error?: string;
  crash?: string;
  closed?: string[];
  removed?: string[];
  server?: string[];
  r?: { text: string; isError: boolean };
};

function scenario(name: string): Out {
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, "tests/fixtures/gate714-fake-bed.mjs"), name],
    { cwd: ROOT, encoding: "utf-8", timeout: 60_000 },
  );
  const line = (r.stdout || "").trim().split("\n").pop() || "";
  try {
    return JSON.parse(line) as Out;
  } catch {
    return { crash: (r.stderr || r.stdout || "").slice(-800) };
  }
}

describe("issue 1213: the 714 check, without ctx.mcp", () => {
  it("clause 1 is not run (needs-mcp-session); 2 to 4 are person, under issue 814", () => {
    const out = scenario("none");
    expect(out.crash ?? out.error).toBeUndefined();
    expect(out.rows!.map((r) => r.skip)).toEqual([
      "needs-mcp-session",
      "person",
      "person",
      "person",
    ]);
    for (const r of out.rows!.slice(1)) expect(r.detail).toMatch(/issue 814/);
  }, 60_000);
});

describe("issue 1213: the 714 check, with ctx.mcp", () => {
  it("clause 1 passes: grant line, passed on to the next in line, back in line and told", () => {
    const out = scenario("pass");
    expect(out.crash ?? out.error).toBeUndefined();
    expect(out.rows![0]).toMatchObject({ ok: true });
    // Two sessions, both closed; both stub agents removed.
    expect([...out.closed!].sort()).toEqual([
      expect.stringMatching(/^gate714-a-/),
      expect.stringMatching(/^gate714-b-/),
    ]);
    expect(out.removed).toHaveLength(2);
  }, 60_000);

  it("clause 1 fails when Den never types the grant line", () => {
    const out = scenario("no-grant-line");
    expect(out.rows![0]!.ok).toBe(false);
    expect(out.rows![0]!.detail).toMatch(/grant line typed after never/);
  }, 60_000);

  it("the harness closes every session even when the check throws", () => {
    const out = scenario("throws");
    expect(out.error).toMatch(/the bed went away/);
    expect(out.closed).toHaveLength(2);
  }, 60_000);
});

describe("issue 1213: a session only for an agent the check started", () => {
  it("refuses an agent the check didn't start in this run, without naming it; opens its own once started", () => {
    const out = scenario("foreign") as Out & {
      foreign?: string;
      beforeStart?: string;
      own?: string;
      realStart?: number | null;
      realAfterStart?: string;
    };
    expect(out.crash).toBeUndefined();
    expect(out.foreign).toMatch(/refused: not an agent this check started/);
    expect(out.foreign).not.toContain("den-server");
    expect(out.beforeStart).toMatch(/refused: not an agent this check started/);
    expect(out.own).toBe("opened");
    // start() on a real agent's id is refused by the bed (non-zero), so
    // ctx.mcp still refuses it.
    expect(out.realStart).not.toBe(0);
    expect(out.realAfterStart).toMatch(
      /refused: not an agent this check started/,
    );
    expect(out.closed).toEqual(["gate714-own"]);
  }, 60_000);
});

describe("issue 1213: the reference ctx.mcp session", () => {
  it("calls a tool over stdio as the configured server, masks codes, and closes", () => {
    const out = scenario("echo");
    expect(out.crash).toBeUndefined();
    expect(out.server).toContain("mcp");
    expect(out.r).toEqual({
      text: "hello •••• (agent gate714-b)",
      isError: false,
    });
  }, 60_000);
});
