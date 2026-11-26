/**
 * Issue 252's live check, run as the bed runs it (runLikeBed: setup, run
 * per matrix cell, expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate252-fake-den.mjs). A person sets one stub agent's
 * mode from its ⋯ menu: Den restarts it at idle in that mode with an audit
 * row, and the row says "from its own setting"; Follow project returns
 * it. No restart, no audit row, or the old CLI wording each fail; a stub
 * runtime without modes is not run, saying why. The agent is removed after.
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
    const g = await import("./gate/252.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate252-fake-den.mjs");
    const bed = fakeBed({ den: ${JSON.stringify(den)} });
    const out = await runLikeBed("252.mjs", g, bed.ctx);
    console.log(JSON.stringify({ clauses: g.clauses, removed: bed.removed(), ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    removed: boolean;
    rows?: Row[];
    error?: string;
  };
}

const oks = (r: ReturnType<typeof runGate>) => (r.rows ?? []).map((x) => x.ok);

describe("gate/252.mjs as the bed runs it", () => {
  it("Den as built: every clause passes, and the agent is removed", () => {
    const r = runGate("good");
    expect(r.error).toBeUndefined();
    expect(r.clauses).toHaveLength(4);
    expect(oks(r)).toEqual([true, true, true, true]);
    expect(r.removed).toBe(true);
  });

  it("no restart at idle: the live clause fails", () => {
    const r = runGate("noRestart");
    expect(r.rows?.[3].ok).toBe(false);
    expect(r.removed).toBe(true);
  });

  it("no audit row: the audit clause fails", () => {
    const r = runGate("noAudit");
    expect(r.rows?.[1].ok).toBe(false);
    expect(r.rows?.[3].ok).toBe(true);
  });

  it("the button never shows busy while the mode applies: the menu clause fails", () => {
    const r = runGate("noBusy");
    expect(r.rows?.[0].ok).toBe(false);
    expect(r.rows?.[3].ok).toBe(true);
  });

  it.each([
    ["busyElsewhere", "busy on another element, not the ⋯ pressed"],
    ["noFollowBusy", "no busy for Follow project"],
  ])("%s (%s): the menu clause fails", (den) => {
    const r = runGate(den);
    expect(r.rows?.[0].ok).toBe(false);
    expect(r.rows?.[3].ok).toBe(true);
  });

  it("an old run's restart rows, none new: the audit clause fails", () => {
    const r = runGate("oldAudit");
    expect(r.rows?.[1].ok).toBe(false);
    expect(r.rows?.[3].ok).toBe(true);
  });

  it("the row says own by its data only, not its words: the live clause fails", () => {
    const r = runGate("noOwnWords");
    expect(r.rows?.[3].ok).toBe(false);
    expect(r.rows?.[0].ok).toBe(true);
  });

  it("no session at run time, though setup started it: fails, never skipped", () => {
    const r = runGate("noSession");
    expect(oks(r)).toEqual([false, false, true, false]);
    expect((r.rows ?? []).some((x) => x.skip)).toBe(false);
  });

  it("it starts with a mode of its own: the live clause fails", () => {
    expect(runGate("startsOwn").rows?.[3].ok).toBe(false);
  });

  it('the CLI still says "from its next start": the CLI clause fails', () => {
    expect(runGate("oldCli").rows?.[2].ok).toBe(false);
  });

  it('no "ag.openName" in the page\'s words: an error naming the key, not a TypeError', () => {
    const r = runGate("noOpenWords");
    expect(r.error).toContain('the page\'s "ag.openName" has no one {id}');
    expect(r.error).not.toContain("TypeError");
    expect(r.removed).toBe(true);
  });

  it("a stub runtime without modes: not run, saying why; the CLI clause still runs", () => {
    const r = runGate("noRuntime");
    expect(r.error).toBeUndefined();
    expect(oks(r)).toEqual([null, null, true, null]);
    expect(r.rows?.[0].skip).toBe("needs-mode-runtime");
  });
});
