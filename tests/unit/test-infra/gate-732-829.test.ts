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

  it("a first comment that couldn't be posted leaves clause 2 not run, and says why", () => {
    const rows = judge({
      ...good,
      postThrew: "ctx.hub.doc: no slug (status 404): {}",
      id1: undefined,
      typed1Ms: undefined,
      turnWrite: undefined,
      turnStarted: undefined,
    });
    expect(rows[0].ok).toBe(false);
    expect(rows[0].detail).toMatch(/no slug/);
    expect(rows[1].ok).toBeNull();
    expect(rows[1].skip).toBe("needs-hub-comment");
    expect(rows[1].detail).toMatch(/no slug/);
    expect(rows[1].detail).not.toMatch(/shell write/);
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

  it("when the stub's shell can't say, the check looks from its own process", () => {
    const got = call(`await (async () => {
      const { spawn } = await import("node:child_process");
      const name = "g732own" + process.pid;
      const job = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "snapshot-zsh-" + "1-" + name + ".sh"], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 300));
      const a = { sh: async () => { throw new Error("stalled"); } };
      const unknown = { sh: async () => ({ out: "unknown" }) };
      const r = [await g.jobPresent(a, name), await g.jobPresent(unknown, name), await g.jobPresent(a, name + "x")];
      job.kill();
      return r;
    })()`) as (boolean | null)[];
    expect(got).toEqual([true, true, false]);
  });

  it("the job's /bg is typed straight into the stub, never sent through Den's /say", () => {
    const got = call(`await (async () => {
      const lines = [];
      const paths = [];
      const a = { start: () => ({ code: null }), running: async () => 1, print() {}, hook: async () => {},
        line: (t) => lines.push(t), sh: async () => ({ out: "no", status: 0 }) };
      const ctx = { agent: () => a, sleep: async () => {}, transcriptPath: () => null, readBed: () => null,
        fetch: async (p) => { paths.push(p); return { status: 202, body: "{}" }; } };
      const r = await g.run(ctx, { id: "s1", hub: true });
      return { lines, say: paths.filter((p) => p.endsWith("/say")).length, bg: r.bg };
    })()`) as { lines: string[]; say: number; bg: unknown };
    expect(got.lines.some((l) => /^\/bg 270 g732[a-z0-9]+$/.test(l))).toBe(
      true,
    );
    expect(got.say).toBe(0);
    expect(got.bg).toBe("line");
  });

  it("a stub with no line to type into skips every clause as needs-stub-line", () => {
    const got = call(`await (async () => {
      const a = { start: () => ({ code: null }), running: async () => 1, print() {}, hook: async () => {} };
      const ctx = { agent: () => a, sleep: async () => {}, transcriptPath: () => null, readBed: () => null,
        fetch: async () => ({ status: 202, body: "{}" }) };
      const r = await g.run(ctx, { id: "s1", hub: true });
      return g.expect(r).map((x) => x.skip);
    })()`) as string[];
    expect(got).toEqual([
      "needs-stub-line",
      "needs-stub-line",
      "needs-stub-line",
    ]);
  });

  it("nobody could look: every clause skips as needs-background-job", () => {
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
