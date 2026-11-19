/**
 * Issue 95's live check, run as the bed runs it (runLikeBed: setup, run
 * per matrix cell, expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate95-fake-den.mjs). Den's pages drawn by the UI kit:
 * the kit shipped and served unchanged, its tokens, the shell and ☰'s
 * drawer, the version chip and What's new, Report, the working pop-up, the
 * update pill, 0.7.0's bell, ◐ ▾ and My reports, and no copy of a kit file.
 * What's new and Report are left closed; nothing is sent.
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

function runGate(den: string) {
  const js = `
    const g = await import("./gate/95.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate95-fake-den.mjs");
    const bed = fakeBed({ den: ${JSON.stringify(den)} });
    const out = await runLikeBed("95.mjs", g, bed.ctx);
    console.log(JSON.stringify({ clauses: g.clauses, after: bed.state(), ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    after: { report: boolean; whatsNew: boolean };
    rows?: Row[];
    error?: string;
  };
}

const oks = (r: ReturnType<typeof runGate>) => (r.rows ?? []).map((x) => x.ok);
/** Every clause passes but `i`, which fails, and the update pill (not run). */
const allBut = (i: number) =>
  Array.from({ length: 9 }, (_, j) =>
    j === i ? false : j === 6 ? null : true,
  );

describe("gate/95.mjs as the bed runs it", () => {
  it("Den as built: every clause passes but the update pill, not run with no update waiting", () => {
    const r = runGate("good");
    expect(r.error).toBeUndefined();
    expect(r.clauses).toHaveLength(9);
    expect(oks(r)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      null,
      true,
      true,
    ]);
    expect(r.rows?.[6].skip).toBe("needs-pending-update");
    expect(r.after).toEqual({ report: false, whatsNew: false });
  });

  it("a newer Den waiting: the update pill clause runs and passes", () => {
    expect(runGate("stale").rows?.[6].ok).toBe(true);
  });

  it.each([
    ["ownShell", 2],
    ["noDrawer", 2],
    ["oldChip", 3],
    ["noReport", 4],
    ["changed", 0],
    ["busyOwn", 5],
    ["copy", 8],
  ])("%s: only clause %i fails", (den, i) => {
    const r = runGate(den);
    expect(r.error).toBeUndefined();
    expect(r.rows?.[i].ok).toBe(false);
    expect(oks(r)).toEqual(only(r, i).map((ok, j) => (j === i ? false : ok)));
  });

  it("no engine named in the bed: the file clauses are not run, saying why", () => {
    const r = runGate("noEngine");
    expect(r.rows?.[0]).toMatchObject({ ok: null, skip: "needs-engine-files" });
    expect(r.rows?.[8]).toMatchObject({ ok: null, skip: "needs-engine-files" });
  });
});
