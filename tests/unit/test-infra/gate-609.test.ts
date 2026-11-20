/**
 * Issue 609's live check (gate/609.mjs), judged on made-up results: every
 * mark shown and cleared with no refusal passes; a lost mark, a refusal
 * of the agent's own call, or an unplaced caller whose row names no
 * reason fails its clause. And it reads only its own agent's rows, from
 * the run's start. In a child node: the gate file is ESM.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function judge(result: unknown): { ok: unknown; skip?: string }[] {
  const js = `
    const g = await import("./gate/609.mjs");
    const r = ${JSON.stringify(result)};
    process.stdout.write(JSON.stringify(g.expect(r)));
  `;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout);
}

function rowsOf(audit: string, id: string, since: number): unknown[] {
  const js = `
    const g = await import("./gate/609.mjs");
    process.stdout.write(JSON.stringify(g.tokenRows(${JSON.stringify(audit)}, ${JSON.stringify(id)}, ${since})));
  `;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (p.status !== 0) throw new Error(p.stderr);
  return JSON.parse(p.stdout);
}

const mark = (i: number | string, shown: number | null = 900) => ({
  name: `Gate609Tool${i}`,
  shown,
  cleared: shown === null ? null : 400,
  ms: 1500,
});
const good = {
  id: "gate609-calls",
  start: 0,
  burners: 4,
  loadBefore: 3,
  loadDuring: 9,
  marks: Array.from({ length: 10 }, (_, i) => mark(i)),
  down: 0,
  downMs: 800,
  up: 0,
  upMs: 6000,
  restart: mark("R"),
  rows: [],
};
const unplaced = (why: string) => ({
  verb: "agent-token",
  outcome: "refused",
  detail: `agent:gate609-calls's token from a process Den couldn't place (${why}pid ?, agent pid 4): POST /api/agents/self/attention`,
});

describe("gate/609.mjs", () => {
  it("every mark shown, no refusals: the run clauses pass; the host restart is not run", () => {
    const rows = judge(good);
    expect(rows.map((r) => r.ok)).toEqual([true, true, true, null]);
    expect(rows[3].skip).toBe("needs-host-restart");
  });

  it("one mark never shown: the load clause fails", () => {
    const marks = [...good.marks];
    marks[4] = mark(4, null);
    expect(judge({ ...good, marks })[0].ok).toBe(false);
  });

  it("a refusal of its own call fails the load clause; one with no reason fails the reason clause too", () => {
    const named = judge({
      ...good,
      rows: [unplaced("the lookup timed out; ")],
    });
    expect(named[0].ok).toBe(false);
    expect(named[1].ok).toBe(true);
    const bare = judge({ ...good, rows: [unplaced("")] });
    expect(bare[1].ok).toBe(false);
  });

  it("the web never came back, or its mark never showed: the restart clause fails", () => {
    expect(judge({ ...good, upMs: null })[2].ok).toBe(false);
    expect(judge({ ...good, restart: mark("R", null) })[2].ok).toBe(false);
  });

  it("reads only this agent's agent-token rows since the run began", () => {
    const line = (o: object) => JSON.stringify(o);
    const audit = [
      line({
        ts: "2026-11-19T10:00:00Z",
        verb: "agent-token",
        principal: "agent:gate609-calls",
      }),
      line({
        ts: "2026-11-19T12:00:00Z",
        verb: "agent-token",
        principal: "agent:gate609-calls",
      }),
      line({
        ts: "2026-11-19T12:00:00Z",
        verb: "agent-token",
        principal: "agent:other",
      }),
      line({
        ts: "2026-11-19T12:00:00Z",
        verb: "agent-start",
        principal: "agent:gate609-calls",
      }),
      "not json",
    ].join("\n");
    expect(
      rowsOf(audit, "gate609-calls", Date.parse("2026-11-19T11:00:00Z")),
    ).toHaveLength(1);
  });
});
