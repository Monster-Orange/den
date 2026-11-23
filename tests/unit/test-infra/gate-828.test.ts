/**
 * Issue 828's live check (gate/828.mjs), judged on made-up results, as the
 * bed would hand them back (issue 1104): the question as an "asked" wait
 * with its text, in the Agents list and the bell, kept over a restart and
 * ended by the tool's run, passes. A question read as a permission for
 * AskUserQuestion, a lost row after the restart, a wait the tool's run
 * didn't end, or an elicitation notice that marked nothing fails its
 * clause. In a child node: the gate file is ESM.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const GATE = process.env.DEN_GATE_828 ?? "./gate/828.mjs";

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
const judge = (r: unknown) =>
  call(`g.expect(${JSON.stringify(r)})`) as { ok: unknown; detail: string }[];

const Q = "Gate check 828: which colour, red or blue?";
const askedRow = { why: "asked", what: Q };
const bellRow = { kind: "waiting", text: `gate-828-ask asked: ${Q}` };
const good = {
  start: 0,
  runningMs: 4000,
  raised: { ms: 900, tries: 1 },
  waits: [askedRow],
  row: { waiting: true, why: "asked" },
  bell: [bellRow],
  down: 0,
  downMs: 700,
  up: 0,
  upMs: 6000,
  afterWaits: [askedRow],
  afterBell: [bellRow],
  endedMs: 1200,
  eStart: 0,
  eRunningMs: 4000,
  elicit: { ms: 800, tries: 1 },
  eWaits: [{ why: "asked", what: "Claude needs your input: gate check 828" }],
  eRow: { waiting: true, why: "asked" },
};

describe("gate/828.mjs", () => {
  it("proves issues 828 and 1104, with items on one line", () => {
    expect(call("{ issue: g.issue, items: g.items, q: g.QUESTION }")).toEqual({
      issue: 828,
      items: [828, 1104],
      q: Q,
    });
  });

  it("the question waits, survives a restart and ends on its tool's run: every clause passes", () => {
    expect(judge(good).map((r) => r.ok)).toEqual([true, true, true, true]);
  });

  it("read as a permission for AskUserQuestion: the first clause fails", () => {
    const perm = {
      kind: "waiting",
      text: "gate-828-ask needs your permission: AskUserQuestion",
    };
    expect(
      judge({
        ...good,
        waits: [{ why: "permission", what: "AskUserQuestion" }],
        row: { waiting: true, why: "permission" },
        bell: [perm],
      })[0].ok,
    ).toBe(false);
    // The question shows, but a permission row for it shows too.
    expect(judge({ ...good, bell: [bellRow, perm] })[0].ok).toBe(false);
    expect(
      judge({
        ...good,
        waits: [askedRow, { why: "permission", what: null }],
      })[0].ok,
    ).toBe(false);
  });

  it("the Agents list doesn't show it waiting on a question: the first clause fails", () => {
    expect(judge({ ...good, row: null })[0].ok).toBe(false);
    expect(judge({ ...good, row: { waiting: true, why: "input" } })[0].ok).toBe(
      false,
    );
  });

  it("an elicitation notice that marks nothing: the second clause fails", () => {
    expect(
      judge({
        ...good,
        elicit: { ms: null, tries: 3 },
        eWaits: [],
        eRow: null,
      })[1].ok,
    ).toBe(false);
  });

  it("the row is gone after the restart, or the web never came back: the third clause fails", () => {
    expect(judge({ ...good, afterWaits: [], afterBell: [] })[2].ok).toBe(false);
    expect(judge({ ...good, upMs: null })[2].ok).toBe(false);
  });

  it("the tool ran and it still waits: the fourth clause fails", () => {
    expect(judge({ ...good, endedMs: null })[3].ok).toBe(false);
  });

  it("no run at all fails every clause", () => {
    expect(judge(null).map((r) => r.ok)).toEqual([false, false, false, false]);
  });

  it("reads only this agent's bell items, Needs you and Updates", () => {
    const n = {
      groups: [
        {
          subjects: [
            {
              subject: "agent:gate-828-ask",
              items: [{ kind: "waiting", text: "a" }],
            },
            { subject: "agent:other", items: [{ kind: "waiting", text: "b" }] },
          ],
        },
      ],
      updates: {
        groups: [
          {
            subjects: [
              { subject: "agent:gate-828-ask", items: [{ kind: "finished" }] },
            ],
          },
        ],
      },
    };
    expect(call(`g.bellItems(${JSON.stringify(n)}, "gate-828-ask")`)).toEqual([
      { kind: "waiting", text: "a" },
      { kind: "finished", text: "" },
    ]);
  });
});
