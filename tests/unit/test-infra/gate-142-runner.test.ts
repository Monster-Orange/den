/**
 * Issue 142's live check, run as the bed runs it (runLikeBed: setup, run,
 * expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate142-fake-den.mjs).
 *  - Clause 4's held-write half: the check raises a held write as the
 *    person, sees it counted in the bell, withdraws it (never a person's
 *    decision) and sees its item go. A Den that doesn't count it, or
 *    can't withdraw it, fails; teardown withdraws whatever is left.
 *  - The update ask: when the bed has none, the skip says why, from the
 *    bed's last update check (GET /api/settings update_check).
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

const HELD =
  "a held write waiting on the person's Allow counts, and its item goes when it is withdrawn";
const UPDATE = "Den's Allow-the-update ask counts";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function runGate(opts: Record<string, unknown> = {}) {
  const js = `
    const g = await import("./gate/142.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate142-fake-den.mjs");
    const bed = fakeBed(${JSON.stringify(opts)});
    const out = await runLikeBed("142.mjs", g, bed.ctx);
    console.log(JSON.stringify({ clauses: g.clauses, asked: bed.asked, withdrawn: bed.withdrawn, left: bed.pendingNow(), ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    asked: { action: string; note?: string; args: Record<string, unknown> }[];
    withdrawn: string[];
    left: string[];
    rows?: Row[];
    error?: string;
  };
}

const row = (r: ReturnType<typeof runGate>, clause: string) =>
  (r.rows ?? []).find((x) => x.clause === clause);

describe("gate/142.mjs as the bed runs it", () => {
  it("a Den that counts a held write and lets its asker withdraw it: the clause passes, nothing is left waiting", () => {
    const r = runGate();
    expect(r.error).toBeUndefined();
    expect(r.clauses).toContain(HELD);
    expect(row(r, HELD)?.ok).toBe(true);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0].note).toBeTruthy();
    expect(r.withdrawn).toHaveLength(1);
    expect(r.left).toEqual([]);
  }, 120_000);

  it("a Den that doesn't count a held write fails the clause, and still withdraws it", () => {
    const r = runGate({ held: "none" });
    expect(r.error).toBeUndefined();
    expect(row(r, HELD)?.ok).toBe(false);
    expect(r.left).toEqual([]);
  }, 120_000);

  it("a Den with no withdraw fails the clause", () => {
    const r = runGate({ withdraw: false });
    expect(r.error).toBeUndefined();
    expect(row(r, HELD)?.ok).toBe(false);
  }, 120_000);

  it("held writes turned off: not run, and says so", () => {
    const r = runGate({ approvals: false });
    expect(r.error).toBeUndefined();
    expect(row(r, HELD)).toMatchObject({
      ok: null,
      skip: "needs-held-writes-on",
    });
  }, 120_000);

  it("no update ask on the bed: the skip names the last update check", () => {
    const r = runGate({
      update: { did: "skipped", why: "this Den runs from a checkout" },
    });
    const u = row(r, UPDATE);
    expect(u).toMatchObject({ ok: null, skip: "needs-pending-update" });
    expect(u?.detail).toContain("skipped");
    expect(u?.detail).toContain("this Den runs from a checkout");
  }, 120_000);

  it("no update check yet: the skip says so", () => {
    const r = runGate();
    expect(row(r, UPDATE)?.detail).toContain("no update check");
  }, 120_000);

  it("the update ask on the bed counts", () => {
    const r = runGate({ update: "pending" });
    expect(row(r, UPDATE)?.ok).toBe(true);
  }, 120_000);
});
