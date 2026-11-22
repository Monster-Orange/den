/**
 * Issue 441 (review): the overview's runs, read newest first. It stops once
 * it has the newest `limit` runs and each imported environment's newest
 * import, so many runs (an import can be 5 MB) are never all parsed on
 * every request. Invented names.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  recentRuns,
  removeRunRecord,
  writeRunRecord,
  type RunRecord,
} from "../../../src/shared/verify/records.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-recent-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const base = Date.parse("2026-11-20T00:00:00.000Z");
/** A run that ended `min` minutes after base, written then. */
function put(runId: string, env: string, min: number, imported = false) {
  const at = new Date(base + min * 60_000).toISOString();
  writeRunRecord(stateDir, {
    runId,
    project: "north",
    env,
    scope: imported ? "imported" : "all",
    ...(imported ? { source: "import" } : {}),
    verdict: "passed",
    exitCode: 0,
    startedAt: at,
    endedAt: at,
    modules: [],
  } as RunRecord);
  const file = path.join(
    stateDir,
    "verify",
    "north",
    "runs",
    runId,
    "run.json",
  );
  fs.utimesSync(
    file,
    new Date(base + min * 60_000),
    new Date(base + min * 60_000),
  );
}

put("bed-old", "bed", 0, true);
for (let n = 1; n <= 60; n++) put(`local-${n}`, "local", n);

describe("recentRuns", () => {
  it("the newest runs, newest first, and an old import the limit would hide", () => {
    const r = recentRuns(stateDir, "north", 50, ["bed"]);
    expect(r.runs.slice(0, 3).map((x) => x.runId)).toEqual([
      "local-60",
      "local-59",
      "local-58",
    ]);
    expect(r.runs).toHaveLength(51);
    expect(r.runs.at(-1)?.runId).toBe("bed-old");
  });

  it("stops reading once it has the limit and every imported environment's import", () => {
    put("bed-new", "bed", 61, true);
    const r = recentRuns(stateDir, "north", 10, ["bed"]);
    expect(r.runs.map((x) => x.runId).slice(0, 2)).toEqual([
      "bed-new",
      "local-60",
    ]);
    // 10 read, not 62.
    expect(r.read).toBe(10);
  });

  it("with no imported environment, reads only the limit", () => {
    expect(recentRuns(stateDir, "north", 5, []).read).toBe(5);
  });

  it("an imported environment with no import yet reads only the limit", () => {
    const r = recentRuns(stateDir, "north", 10, ["bed", "never"]);
    expect(r.read).toBe(10);
  });

  it("an old import behind many runs is read through its pointer, not a scan", () => {
    removeRunRecord(stateDir, "north", "bed-new");
    const r = recentRuns(stateDir, "north", 10, ["bed"]);
    expect(r.runs.at(-1)?.runId).toBe("bed-old");
    expect(r.read).toBe(11);
  });

  it("removing the pointed-at import points at the next newest, or at none", () => {
    put("bed-mid", "bed", 30, true);
    removeRunRecord(stateDir, "north", "bed-mid");
    expect(recentRuns(stateDir, "north", 5, ["bed"]).runs.at(-1)?.runId).toBe(
      "bed-old",
    );
    removeRunRecord(stateDir, "north", "bed-old");
    const r = recentRuns(stateDir, "north", 5, ["bed"]);
    expect(r.runs.some((x) => x.env === "bed")).toBe(false);
    expect(r.read).toBe(5);
  });
});
