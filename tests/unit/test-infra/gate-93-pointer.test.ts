/**
 * Issue 187 (a bell row that opens shows the pointer cursor) is proved by
 * issue 93's live check (gate/93.mjs): it declares items [93, 187], and a
 * fifth clause reads the cursor over each question's row (the row, its
 * dot and its time) before it clicks. Its expect() on recorded results:
 *
 *  - every measured spot shows the pointer: the clause passes;
 *  - one spot shows the arrow (0.4.84's rows): the clause fails, with it
 *    in the detail;
 *  - nothing measured: the clause fails, never passes empty.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface Row {
  clause: string;
  ok: boolean | null;
  detail?: string;
}

function gate(cursor: unknown): {
  items: number[];
  clauses: string[];
  rows: Row[];
} {
  const js = `
    const g = await import("./gate/93.mjs");
    const cursor = ${JSON.stringify(cursor)};
    const rows = g.expect([{ cell: { browser: "webkit", width: 390 }, result: { width: 390, cursor } }]);
    console.log(JSON.stringify({ items: g.items, clauses: g.clauses, rows }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

const POINTER = /pointer cursor/;
const pointerRow = (rows: Row[]) => rows.find((r) => POINTER.test(r.clause));

describe("gate/93.mjs proves issue 187's pointer cursor", () => {
  it("declares items [93, 187] and a pointer clause", () => {
    const g = gate({});
    expect(g.items).toEqual([93, 187]);
    expect(g.clauses.filter((c) => POINTER.test(c))).toHaveLength(1);
  });

  it("every spot on both rows shows the pointer: passes", () => {
    const all = { row: "pointer", dot: "pointer", time: "pointer" };
    expect(pointerRow(gate({ long: all, short: all }).rows)?.ok).toBe(true);
  });

  it("the arrow anywhere (0.4.84's rows): fails, and says where", () => {
    const r = pointerRow(
      gate({
        long: { row: "pointer", dot: "pointer", time: "pointer" },
        short: { row: "auto", dot: "auto", time: "auto" },
      }).rows,
    );
    expect(r?.ok).toBe(false);
    expect(r?.detail).toContain("auto");
  });

  it("nothing measured: fails, never passes empty", () => {
    expect(pointerRow(gate({}).rows)?.ok).toBe(false);
  });
});
