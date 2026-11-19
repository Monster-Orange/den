/**
 * Issue 448's live check (gate/448.mjs) must prove the clauses found live
 * on 11-18, not only the four per-project ones:
 *   5. under All projects, Terminal opens the running shell used most
 *      recently, across projects;
 *   6. Terminal never opens an exited shell; with none running in scope,
 *      it starts one.
 * The gate's run() and expect() on a fake bed (tests/fixtures/
 * gate448-fake-den.mjs: a Playwright-like page over a fake Den), in a
 * child node: the gate file is ESM. A fake Den that opens the first shell
 * listed must fail clause 5; one that opens an exited shell must fail
 * clause 6. The gate puts the view back and closes only its own shells.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

const ALL =
  "under All projects, Terminal opens the running shell used most recently, across projects";
const EXITED =
  "Terminal never opens an exited shell; with none running in scope, it starts one";

interface Row {
  clause: string;
  ok: boolean | null;
  detail?: string;
}

/** gate/448 on a fake bed whose rail Terminal follows `policy`. */
function runGate(policy: "good" | "first" | "exited", pre: string[] = []) {
  const js = `
    const g = await import("./gate/448.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate448-fake-den.mjs");
    const bed = fakeBed({ policy: ${JSON.stringify(policy)} });
    // Shells the bed had before the check (never the check's to close).
    const pre = ${JSON.stringify(pre)}.map((ws) => {
      bed.den.sessions.push({ id: "pre-" + ws, workspace: ws, kind: "session", startedAt: 1, usedAt: 0, exited: false });
      return "pre-" + ws;
    });
    let error = null, result = null, rows = null;
    try {
      const state = await g.setup(bed.ctx);
      result = await g.run(bed.ctx, state);
      await g.teardown(bed.ctx, state);
      rows = g.expect([{ result }]);
    } catch (e) { error = String(e?.stack ?? e); }
    console.log(JSON.stringify({
      clauses: g.clauses,
      rows,
      error,
      scope: bed.scope(),
      preLeft: pre.filter((id) => bed.den.sessions.some((s) => s.id === id)),
      preClosed: bed.den.closes.filter((id) => pre.includes(id)),
      ownLeft: bed.den.sessions.filter((s) => !pre.includes(s.id) && !s.exited).map((s) => s.id),
    }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    rows: Row[] | null;
    error: string | null;
    scope: string;
    preLeft: string[];
    preClosed: string[];
    ownLeft: string[];
  };
}

const row = (rows: Row[] | null, clause: string) =>
  (rows ?? []).find((r) => r.clause === clause);

describe("gate/448.mjs clauses 5 and 6", () => {
  it("names both clauses", () => {
    const r = runGate("good");
    expect(r.clauses).toEqual(expect.arrayContaining([ALL, EXITED]));
  });

  it("a Den that does it right passes every clause, puts the view back, closes only its own shells", () => {
    const r = runGate("good", ["south"]);
    expect(r.error).toBeNull();
    expect(r.rows?.length).toBe(r.clauses.length);
    expect((r.rows ?? []).filter((x) => x.ok !== true)).toEqual([]);
    expect(row(r.rows, ALL)?.ok).toBe(true);
    expect(row(r.rows, EXITED)?.ok).toBe(true);
    expect(r.scope).toBe("all");
    expect(r.preLeft).toEqual(["pre-south"]);
    expect(r.preClosed).toEqual([]);
    expect(r.ownLeft).toEqual([]);
  });

  it("a Den that opens the first shell listed fails clause 5", () => {
    const r = runGate("first");
    expect(r.error).toBeNull();
    expect(row(r.rows, ALL)?.ok).toBe(false);
  });

  it("a Den that opens an exited shell fails clause 6", () => {
    const r = runGate("exited");
    expect(r.error).toBeNull();
    expect(row(r.rows, EXITED)?.ok).toBe(false);
    expect(r.ownLeft).toEqual([]);
  });
});
