/**
 * Live checks: each pull request that closes a clause of an issue ships
 * gate/<issue>.mjs, run against a bed (a running Den: its URL and its CLI)
 * on every dev tag, with no agent turn. scripts/gate-shape.mjs holds every
 * file in gate/ to the shape the bed harness loads (CONTRIBUTING.md, "Live
 * checks"); this test runs it, on planted files and on gate/ itself.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const FIX = path.join(ROOT, "tests", "fixtures", "gate");

function shape(dir: string): { code: number | null; problems: string[] } {
  const r = spawnSync(process.execPath, ["scripts/gate-shape.mjs", dir], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  return { code: r.status, problems: JSON.parse(r.stdout || "null") };
}

describe("live checks: gate/<issue>.mjs", () => {
  it("a well-formed check passes", () => {
    expect(shape(path.join(FIX, "good"))).toEqual({ code: 0, problems: [] });
  });

  it("refuses what the harness couldn't run, and says why", () => {
    expect(shape(path.join(FIX, "bad"))).toEqual({
      code: 1,
      problems: [
        "407.mjs: issue is 406, the file name says 407",
        "407.mjs: run is not a function",
        "408.mjs: clauses is empty (name each clause it proves)",
        "409.mjs: teardown is not a function",
        "409.mjs: matrix.browsers must list chromium or webkit",
        "409.mjs: matrix.widths must be widths in px (200 or more)",
        "409.mjs: timeoutMs is not a positive whole number",
        "410.mjs: expect takes one argument, the result (the harness calls expect(result)); it declares 2",
        "411.mjs: line 8: a plain fetch against ctx.url runs on the host and reaches the live edge; use ctx.hostUrl (or ctx.fetch)",
        "411.mjs: line 11: a plain fetch against ctx.url runs on the host and reaches the live edge; use ctx.hostUrl (or ctx.fetch)",
        '412.mjs: line 4: skip reason "needs a test Hub" is not "person" or "needs-<thing>" (put the words in why)',
        '412.mjs: line 6: skip reason "needs ctx.hub" is not "person" or "needs-<thing>" (put the words in why)',
        "413.mjs: items must list its own issue (413)",
        "413.mjs: items must be issue numbers (whole numbers above 0)",
        "414.mjs: items must be on one line, `export const items = [414, …];` (the bed reads it from the source)",
        "notes.mjs: the name is not <issue number>.mjs",
      ],
    });
  });

  it("checks expect's rows: ok null only with a skip reason, every clause answered once", () => {
    const js = `
      const { checkRows } = await import("./scripts/gate-shape.mjs");
      const c = ["a", "b"];
      console.log(JSON.stringify({
        good: checkRows([{ clause: "a", ok: true }, { clause: "b", ok: null, skip: "needs-signed-in-cli", evidence: ["log"] }], c),
        nullNoSkip: checkRows([{ clause: "a", ok: null }, { clause: "b", ok: false }], c),
        skipWithOk: checkRows([{ clause: "a", ok: true, skip: "person" }, { clause: "b", ok: true }], c),
        missing: checkRows([{ clause: "a", ok: true }], c),
        stranger: checkRows([{ clause: "a", ok: true }, { clause: "b", ok: "yes" }, { clause: "z", ok: true }], c),
        twice: checkRows([{ clause: "a", ok: true }, { clause: "b", ok: true }, { clause: "a", ok: true }], c),
      }));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(JSON.parse(r.stdout)).toEqual({
      good: [],
      nullNoSkip: ['row 1: ok null needs skip "person" or "needs-<thing>"'],
      skipWithOk: ["row 1: skip only goes with ok null"],
      missing: ['clause "b" has no row'],
      stranger: [
        "row 2: ok is not true, false or null",
        'row 3: clause "z" is not one of clauses',
      ],
      // CONTRIBUTING.md: expect answers each clause once.
      twice: ['row 3: clause "a" is answered more than once'],
    });
  });

  it("every file in gate/ has the shape", () => {
    expect(shape(path.join(ROOT, "gate")).problems).toEqual([]);
  });
});
