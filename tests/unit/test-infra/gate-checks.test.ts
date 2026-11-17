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
        "notes.mjs: the name is not <issue number>.mjs",
      ],
    });
  });

  it("every file in gate/ has the shape", () => {
    expect(shape(path.join(ROOT, "gate")).problems).toEqual([]);
  });
});
