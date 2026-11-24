/**
 * Issue 1407's live check (gate/1407.mjs): its rows from a run's result.
 * The check itself runs on the bed's throwaway second Den; here only its
 * expect(), in a child node (the gate file is ESM), on results shaped as
 * its run() returns them:
 *
 * - a Den that answers per agent passes all four rows;
 * - a Den that waits silently on the job (state "turn", nothing named)
 *   fails row 2, and its row line without the job fails row 3;
 * - no den2, or a stub that keeps no background shell, skips by name.
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

function rows(result: unknown): Row[] {
  const js = `
    const g = await import("./gate/1407.mjs");
    console.log(JSON.stringify(g.expect([{ cell: { browser: "chromium", width: 1280 }, result: ${JSON.stringify(result)} }])));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as Row[];
}

const good = {
  status: 202,
  stale: ["g1407-idle", "g1407-job"],
  agents: [
    { id: "g1407-idle", workspace: "gate-1407", state: "now" },
    {
      id: "g1407-job",
      workspace: "gate-1407",
      state: "job",
      job: { command: "sleep 270; :", minutes: 0 },
    },
  ],
  before: { idle: { session: "s1", token: "t1" }, job: { session: "s2" } },
  idleBackMs: 4000,
  idleAfter: { session: "s3", token: "t1", denVersion: "9.9.9" },
  jobSameSession: true,
  jobAliveAfter: true,
  rowSeen: true,
  pageState: "job",
  pageLine: "g1407-job: waiting: a background job (sleep 270; :, 0 min).",
  pageNow: 1,
  nowBy: "page",
  nowMs: 3000,
  jobAliveEnd: false,
};

describe("gate/1407.mjs: a restart answers per agent", () => {
  it("names the items it proves", async () => {
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const g = await import("./gate/1407.mjs"); console.log(JSON.stringify({ items: g.items, n: g.clauses.length }));`,
      ],
      { cwd: ROOT, encoding: "utf-8" },
    );
    expect(JSON.parse(r.stdout.trim())).toEqual({ items: [1407], n: 4 });
  });

  it("a Den that answers per agent passes every row", () => {
    expect(rows(good).map((r) => r.ok)).toEqual([true, true, true, true]);
  });

  it("a silent wait on the job fails rows 2 and 3", () => {
    const silent = {
      ...good,
      agents: [
        good.agents[0],
        { id: "g1407-job", workspace: "gate-1407", state: "turn" },
      ],
      pageState: "turn",
      pageLine: "g1407-job: restarts when its turn ends",
      pageNow: 0,
      nowBy: "api",
    };
    expect(rows(silent).map((r) => r.ok)).toEqual([true, false, false, true]);
  });

  it("a new conversation (another resume token) fails row 1", () => {
    const lost = { ...good, idleAfter: { ...good.idleAfter, token: "t9" } };
    expect(rows(lost)[0].ok).toBe(false);
  });

  it("no den2, or no background shell: every row skips by name", () => {
    expect(rows({ skip: "needs-den2" }).map((r) => r.skip)).toEqual(
      Array(4).fill("needs-den2"),
    );
    expect(
      rows({ skip: "needs-background-job", bg: 409 }).map((r) => r.skip),
    ).toEqual(Array(4).fill("needs-background-job"));
  });
});
