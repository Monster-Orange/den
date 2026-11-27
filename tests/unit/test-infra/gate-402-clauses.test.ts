/**
 * Issue 402's live check (gate/402.mjs) proves the 11-18 model, clauses
 * 2 to 6: a pin is (company, project or none, person, item). The gate's
 * setup, run, teardown and expect on a fake bed (tests/fixtures/
 * gate402-fake-den.mjs: a Playwright-like page over a fake Den), in a
 * child node: the gate file is ESM. The fake's ctx.until answers the ms
 * it took (0 counts) or null, as the real bed's does.
 *
 * - a Den that keeps the model passes every clause, and teardown puts the
 *   person's pins and view back;
 * - 0.4.66's model (ids only, filtered by the item's own project) fails
 *   clauses 2 and 4's neighbours: 2, 3 and 5;
 * - ★ under All that unpins one pin and offers no Undo fails the Undo clause;
 * - an old id-only pin that always becomes none fails clause 6.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

const BEFORE = [
  { item: "shop", project: "north" },
  { item: "blog", project: null },
];

function runGate(policy: string, persons: unknown[] = []) {
  const js = `
    const g = await import("./gate/402.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate402-fake-den.mjs");
    const bed = fakeBed({ policy: ${JSON.stringify(policy)}, persons: ${JSON.stringify(persons)} });
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

const ok = (rows: Row[] | null, i: number, clauses: string[]) =>
  (rows ?? []).find((r) => r.clause === clauses[i])?.ok;

describe("gate/402.mjs: the pin is (project or none, item)", () => {
  it("names clauses 2 to 6 and the Undo decision", () => {
    const r = runGate("good");
    expect(r.clauses).toHaveLength(6);
    expect(r.clauses.join(" ")).toMatch(/project picked at that moment/);
    expect(r.clauses.join(" ")).toMatch(/Undo/);
    expect(r.clauses.join(" ")).toMatch(/exactly one/);
  });

  it("a Den that keeps the model passes every clause, and teardown puts the pins and view back", () => {
    const r = runGate("good");
    expect(r.error).toBeNull();
    expect(r.rows?.length).toBe(r.clauses.length);
    expect((r.rows ?? []).filter((x) => x.ok !== true)).toEqual([]);
    expect(r.scope).toBe("south");
    expect(r.pins).toEqual(BEFORE);
  });

  it("the person already has pins, which a fixture save never removes (issue 946): every clause still passes, and their pins stay", () => {
    // As on the bed: old id-only pins in the person's user.yml, one of an
    // item the check would otherwise test (shop/db, north's alone).
    const persons = ["shop/db", "common"];
    const r = runGate("good", persons);
    expect(r.error).toBeNull();
    expect((r.rows ?? []).filter((x) => x.ok !== true)).toEqual([]);
    expect(r.pins).toEqual(
      expect.arrayContaining([
        { item: "shop/db", project: "north" },
        { item: "common", project: null },
      ]),
    );
  });

  it("0.4.66's model (ids only, the item's own project) fails clauses 2, 3 and 5", () => {
    const r = runGate("repo-filter");
    expect(r.error).toBeNull();
    expect(ok(r.rows, 0, r.clauses)).toBe(false);
    expect(ok(r.rows, 1, r.clauses)).toBe(false);
    expect(ok(r.rows, 3, r.clauses)).toBe(false);
    expect(r.pins).toEqual(
      BEFORE.map((p) => ({ item: p.item, project: null })),
    );
  });

  it("★ under All that unpins one pin, with no Undo, fails the Undo clause only", () => {
    const r = runGate("one-unpin");
    expect(r.error).toBeNull();
    expect(ok(r.rows, 4, r.clauses)).toBe(false);
    for (const i of [0, 1, 2, 3, 5])
      expect(ok(r.rows, i, r.clauses)).toBe(true);
  });

  it("an old id-only pin that always becomes none fails clause 6", () => {
    const r = runGate("no-migrate");
    expect(r.error).toBeNull();
    expect(ok(r.rows, 5, r.clauses)).toBe(false);
    expect(ok(r.rows, 0, r.clauses)).toBe(true);
  });
});
