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

  it("a stub nobody could look in skips, saying it couldn't look, never that no shell runs", () => {
    const rows = judge({
      ...good,
      seen: false,
      probe: { status: 202, code: null },
      jobPresent: null,
    });
    expect(rows.map((r) => r.skip)).toEqual([
      "needs-background-job",
      "needs-background-job",
      "needs-background-job",
    ]);
    expect(rows[0].detail).toMatch(/couldn't look/);
    expect(rows[0].detail).not.toMatch(
      /none runs there|kept no background shell/,
    );
  });

  it("a stub with no background shell running says so", () => {
    const rows = judge({
      ...good,
      seen: false,
      probe: { status: 202, code: null },
      jobPresent: false,
    });
    expect(rows[0].detail).toMatch(/none runs there/);
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
  const looked = (out: string, name = "g732t1") =>
    call(`await (async () => {
      const sent = [];
      const a = { sh: async (cmd) => { sent.push(cmd); return { out: ${JSON.stringify(out)} }; } };
      const got = await g.jobPresent(a, ${JSON.stringify(name)});
      return { got, sent };
    })()`) as { got: boolean | null; sent: string[] };

  it("the job is looked for by this run's own name, under the stub's STUB_HOME only", () => {
    const { got, sent } = looked("yes", "g732abc");
    expect(got).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('[ -n "$STUB_HOME" ]');
    expect(sent[0]).toContain(
      "$STUB_HOME/shell-snapshots/snapshot-zsh-[0-9]+-g732abc\\.sh",
    );
  });

  it("an empty STUB_HOME answers unknown: null, and every clause skips as needs-background-job", () => {
    expect(looked("unknown").got).toBeNull();
    const rows = judge({
      ...good,
      seen: false,
      probe: { status: 202, code: null },
      jobPresent: null,
    });
    expect(rows.map((r) => r.skip)).toEqual([
      "needs-background-job",
      "needs-background-job",
      "needs-background-job",
    ]);
  });

  it("each run names its job anew, so two runs on one machine don't see each other's", () => {
    const [a, b] = call("[g.jobName(1000), g.jobName(2000)]") as string[];
    expect(a).toMatch(/^g732[a-z0-9]+$/);
    expect(b).toMatch(/^g732[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});
