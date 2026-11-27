/**
 * Issue 1217's live check (gate/1217.mjs): an old id-only pin never
 * vanishes. The gate's setup, run, teardown and expect on a fake bed
 * (tests/fixtures/gate1217-fake-den.mjs), in a child node: the gate file
 * is ESM.
 *
 * - a Den that keeps 1217's rule passes every clause it can reach, skips
 *   the hand-edit clause by name, and teardown puts the pins and view back;
 * - 0.4.85's rule (a repo in two projects goes to none) fails the
 *   two-project clause;
 * - a pin migrated on save, which doctor does not list, still passes it.
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
}

const BEFORE = [{ item: "shop", project: "north" }];

function runGate(policy: string) {
  const js = `
    const g = await import("./gate/1217.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate1217-fake-den.mjs");
    const bed = fakeBed({ policy: ${JSON.stringify(policy)} });
    bed.seed(${JSON.stringify(BEFORE)});
    await bed.ctx.api("/api/scope", { method: "POST", body: JSON.stringify({ scope: "south" }) });
    let error = null, result = null, rows = null, state = null;
    try {
      state = await g.setup(bed.ctx);
      result = await g.run(bed.ctx, state);
    } catch (e) { error = String(e?.stack ?? e); }
    try { await g.teardown(bed.ctx, state); } catch (e) { error = error ?? String(e?.stack ?? e); }
    try { rows = g.expect([{ cell: { browser: "chromium", width: 1280 }, result }]); }
    catch (e) { error = error ?? String(e?.stack ?? e); }
    console.log(JSON.stringify({ clauses: g.clauses, rows, error, scope: bed.scope(), pins: bed.pins() }));`;
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
    pins: unknown[];
  };
}

const row = (r: ReturnType<typeof runGate>, i: number) =>
  (r.rows ?? []).find((x) => x.clause === r.clauses[i]);

describe("gate/1217.mjs: an old-format pin never vanishes", () => {
  it("names issue 1217's five clauses", () => {
    const r = runGate("good");
    expect(r.clauses).toHaveLength(5);
    expect(r.clauses.join(" ")).toMatch(/two or more projects/);
    expect(r.clauses.join(" ")).toMatch(
      /kept with no project and shown under All/,
    );
  });

  it("a Den that keeps 1217's rule passes every clause it reaches, skips the hand-edit one by name, and puts the pins and view back", () => {
    const r = runGate("good");
    expect(r.error).toBeNull();
    expect(r.rows?.length).toBe(r.clauses.length);
    for (const i of [0, 1, 2, 4]) expect([i, row(r, i)?.ok]).toEqual([i, true]);
    expect(row(r, 3)).toMatchObject({ ok: null, skip: "needs-a-hand-edit" });
    expect(r.scope).toBe("south");
    expect(r.pins).toEqual(BEFORE);
  });

  it("0.4.85's rule (a repo in two projects goes to none) fails the two-project clause", () => {
    const r = runGate("one-owner");
    expect(r.error).toBeNull();
    expect(row(r, 1)?.ok).toBe(false);
    expect(row(r, 0)?.ok).toBe(true);
  });

  it("a pin migrated on save, which doctor no longer lists as kept, passes the no-project clause", () => {
    const r = runGate("no-doctor");
    expect(r.error).toBeNull();
    expect(row(r, 2)?.ok).toBe(true);
    expect(row(r, 2)?.detail).toMatch(/a migrated pin needn't be listed/);
    expect(row(r, 0)?.ok).toBe(true);
  });
});
