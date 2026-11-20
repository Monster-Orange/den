/**
 * Issues 701, 659 and 658's live checks, run as the bed runs them
 * (runLikeBed) on a fake bed (tests/fixtures/gate701-fake-den.mjs).
 *
 * 701: a Den that types a Hub comment into an agent that asked its person
 * a question, clears the question on the person's own comment, and holds
 * a comment on a dialog with its reason (Hub acked queued, the row and
 * doctor say it) passes; the reported Den (the question held every
 * comment, Hub heard nothing) fails clauses 1 and 3. A comment Den saw as
 * not from the install's person skips clause 2; no Hub skips all.
 *
 * 659: a message to an agent showing the trust question answers 409
 * dialog_open and types nothing on a fixed Den, and is typed with Enter
 * on the reported one. Clauses 2 and 3 skip with what the bed needs.
 *
 * 658: every clause skips (the bed's stub always writes its transcript).
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

function runGate(file: string, opts: Record<string, unknown> = {}) {
  const js = `
    const g = await import("./gate/${file}");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate701-fake-den.mjs");
    const ctx = fakeBed(${JSON.stringify(opts)});
    const out = await runLikeBed(${JSON.stringify(file)}, g, ctx);
    console.log(JSON.stringify({ clauses: g.clauses, ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    rows?: Row[];
    error?: string;
  };
}

const row = (r: ReturnType<typeof runGate>, i: number) => {
  const got = (r.rows ?? []).filter((x) => x.clause === r.clauses[i]);
  expect(got).toHaveLength(1);
  return got[0];
};

describe("gate/701.mjs as the bed runs it", () => {
  it("a fixed Den passes every clause when the comment is the person's own", () => {
    const r = runGate("701.mjs", { den: "fixed", own: true });
    expect(r.error).toBeUndefined();
    for (let i = 0; i < 3; i++) expect(row(r, i).ok).toBe(true);
  });

  it("the reported Den (a question holds every comment, Hub hears nothing) fails clauses 1 and 3", () => {
    const r = runGate("701.mjs", { den: "unfixed", own: true });
    expect(r.error).toBeUndefined();
    expect(row(r, 0).ok).toBe(false);
    expect(row(r, 1).ok).toBe(false);
    expect(row(r, 2).ok).toBe(false);
    expect(row(r, 2).detail).toMatch(/reason Den told Hub/);
  });

  it("a comment Den saw as from someone else skips clause 2, saying who", () => {
    const r = runGate("701.mjs", { den: "fixed", own: false });
    expect(r.error).toBeUndefined();
    expect(row(r, 0).ok).toBe(true);
    expect(row(r, 1).ok).toBeNull();
    expect(row(r, 1).skip).toBe("needs-owner-comment");
    expect(row(r, 1).detail).toMatch(/an agent/);
    expect(row(r, 2).ok).toBe(true);
  });

  it("a bed without a Hub skips every clause", () => {
    const r = runGate("701.mjs", { hub: false });
    expect(r.error).toBeUndefined();
    for (let i = 0; i < 3; i++) expect(row(r, i).skip).toBe("needs-hub");
  });
});

describe("gate/659.mjs as the bed runs it", () => {
  it("a fixed Den refuses the message with 409 dialog_open and types nothing", () => {
    const r = runGate("659.mjs", { den: "fixed" });
    expect(r.error).toBeUndefined();
    expect(row(r, 0).ok).toBe(true);
  });

  it("the reported Den types the message, Enter and all, into the trust question", () => {
    const r = runGate("659.mjs", { den: "unfixed" });
    expect(r.error).toBeUndefined();
    expect(row(r, 0).ok).toBe(false);
    expect(row(r, 0).detail).toMatch(/status 200/);
  });

  it("the row and bell clauses skip with what the bed needs", () => {
    const r = runGate("659.mjs", { den: "fixed" });
    for (const i of [1, 2]) {
      expect(row(r, i).ok).toBeNull();
      expect(row(r, i).skip).toBe("needs-stub-trust-start");
      expect(row(r, i).detail).toMatch(/writes no transcript until Yes/);
    }
  });
});

describe("gate/658.mjs as the bed runs it", () => {
  it("every clause skips: the bed's stub writes its transcript at start", () => {
    const r = runGate("658.mjs");
    expect(r.error).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      expect(row(r, i).ok).toBeNull();
      expect(row(r, i).skip).toBe("needs-stub-unwritten-start");
    }
  });
});
