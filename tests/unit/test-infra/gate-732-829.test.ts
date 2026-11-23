/**
 * Issue 829: gate/732.mjs as fail-first proof, judged on made-up results
 * as the bed hands them back. Den not seeing a background job that is
 * really running under the stub fails; only a stub with no job (no /bg
 * verb) skips. A setup whose turn never started skips clause 2 as
 * needs-turn, with the shell write's status, never a Den failure. In a
 * child node: the gate file is ESM.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const GATE = process.env.DEN_GATE_732 ?? "./gate/732.mjs";

function call(expr: string): unknown {
  const js = `
    const g = await import(${JSON.stringify(GATE)});
    process.stdout.write(JSON.stringify(${expr}));
  `;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout);
}
type Row = { ok: boolean | null; skip?: string; detail: string };
const judge = (r: unknown) => call(`g.expect(${JSON.stringify(r)})`) as Row[];

const JOB = { status: 409, code: "job_running", job: { minutes: 4 } };
const good = {
  hub: true,
  agent: "gate-732-x",
  running: true,
  transcript: true,
  bg: { status: 200, code: null },
  probe: JOB,
  seen: true,
  sameSession: true,
  id1: "c1",
  typed1Ms: 900,
  turnWrite: 0,
  turnStarted: true,
  id2: "c2",
  typedWhileBusy: false,
  reason: "the agent is busy with a turn",
  reasonMs: 400,
  probe2: JOB,
  typed2Ms: 800,
};

describe("gate/732.mjs (issue 829)", () => {
  it("proves issues 732 and 829", () => {
    expect(call("{ issue: g.issue, items: g.items }")).toEqual({
      issue: 732,
      items: [732, 829],
    });
  });

  it("a good run passes every clause", () => {
    expect(judge(good).map((r) => r.ok)).toEqual([true, true, true]);
  });

  it("a job running under the stub that Den doesn't see fails every clause", () => {
    const rows = judge({
      ...good,
      seen: false,
      probe: { status: 202, code: null },
      jobPresent: true,
    });
    expect(rows.map((r) => r.ok)).toEqual([false, false, false]);
    expect(rows.every((r) => r.skip === undefined)).toBe(true);
    expect(rows[0].detail).toMatch(/Den saw no job/);
    expect(rows[0].detail).toMatch(/running under the stub/);
  });

  it("only a stub with no background job (no /bg verb) skips", () => {
    const rows = judge({
      ...good,
      seen: false,
      probe: { status: 202, code: null },
      jobPresent: false,
    });
    expect(rows.map((r) => [r.ok, r.skip])).toEqual([
      [null, "needs-background-job"],
      [null, "needs-background-job"],
      [null, "needs-background-job"],
    ]);
  });

  it("a turn that never started skips clause 2 as needs-turn, with the write's status", () => {
    const rows = judge({
      ...good,
      turnWrite: null,
      turnStarted: false,
      id2: undefined,
      typedWhileBusy: undefined,
      reason: null,
      probe2: undefined,
      typed2Ms: undefined,
    });
    expect(rows[0].ok).toBe(true);
    expect(rows[2].ok).toBe(true);
    expect(rows[1].ok).toBeNull();
    expect(rows[1].skip).toBe("needs-turn");
    expect(rows[1].detail).toMatch(/shell write/);
    expect(rows[1].detail).toMatch(/null/);
  });

  it("a turn that started but a comment typed mid-turn still fails clause 2", () => {
    const rows = judge({ ...good, typedWhileBusy: true });
    expect(rows[1].ok).toBe(false);
    expect(rows[1].skip).toBeUndefined();
  });
});
