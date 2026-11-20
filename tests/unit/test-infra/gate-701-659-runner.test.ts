/**
 * Issues 701, 659 and 658's live checks, run as the bed runs them
 * (runLikeBed) on a fake bed with the stub's start modes
 * (tests/fixtures/gate701-fake-den.mjs).
 *
 * 701: a Den that types a Hub comment into an agent that asked its person
 * a question, clears the question on the person's own comment, and holds
 * a comment on a dialog with its reason (Hub acked queued, the row and
 * doctor say it) passes; the reported Den (the question held every
 * comment, Hub heard nothing) fails. A comment not from the install's
 * person skips clause 2; no Hub skips all.
 *
 * 659: a message to an agent showing the trust question answers 409 and
 * types nothing; a start on the trust screen (both shapes, "No, exit"
 * highlighted) is named on the row and in the bell with no Enter from
 * Den, and a No is said. The reported Den types Enter into it.
 *
 * 658: a relaunch whose start writes nothing is undone (handoff.md back,
 * rotation due), Resume then starts from the handoff with 200, and an
 * agent with no handoff starts fresh under the same id. The reported Den
 * leaves the handoff archived and answers 502.
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

  it("the reported Den (a question holds every comment, Hub hears nothing) fails", () => {
    const r = runGate("701.mjs", { den: "unfixed", own: true });
    expect(r.error).toBeUndefined();
    expect(row(r, 0).ok).toBe(false);
    expect(row(r, 1).ok).toBe(false);
    expect(row(r, 2).ok).toBe(false);
    expect(row(r, 2).detail).toMatch(/reason Den told Hub/);
  });

  it("a comment not from the install's person skips clause 2 for the person's check list", () => {
    const r = runGate("701.mjs", { den: "fixed", own: false });
    expect(r.error).toBeUndefined();
    expect(row(r, 0).ok).toBe(true);
    expect(row(r, 1).ok).toBeNull();
    expect(row(r, 1).skip).toBe("needs-owner-comment");
    expect(row(r, 1).detail).toMatch(/person's check list/);
    expect(row(r, 2).ok).toBe(true);
  });

  it("a bed without a Hub skips every clause", () => {
    const r = runGate("701.mjs", { hub: false });
    expect(r.error).toBeUndefined();
    for (let i = 0; i < 3; i++) expect(row(r, i).skip).toBe("needs-hub");
  });
});

describe("gate/659.mjs as the bed runs it", () => {
  it("a fixed Den: 409 to the message, the waiting words in both shapes with no Enter, and the No said", () => {
    const r = runGate("659.mjs", { den: "fixed" });
    expect(r.error).toBeUndefined();
    for (let i = 0; i < 3; i++) expect(row(r, i).ok).toBe(true);
  });

  it("the reported Den types into the trust question (Enter picks No) and never names it", () => {
    const r = runGate("659.mjs", { den: "unfixed" });
    expect(r.error).toBeUndefined();
    expect(row(r, 0).ok).toBe(false);
    expect(row(r, 0).detail).toMatch(/status 200/);
    expect(row(r, 1).ok).toBe(false);
    expect(row(r, 1).detail).toMatch(/Enter keys from Den 1/);
    expect(row(r, 2).ok).toBe(false);
  });

  it("a bed without the stub's start modes skips clauses 2 and 3", () => {
    const r = runGate("659.mjs", { den: "fixed", modes: false });
    expect(r.error).toBeUndefined();
    expect(row(r, 0).ok).toBe(true);
    for (const i of [1, 2]) {
      expect(row(r, i).ok).toBeNull();
      expect(row(r, i).skip).toBe("needs-stub-start-modes");
    }
  });
});

describe("gate/658.mjs as the bed runs it", () => {
  it("a fixed Den: the unbegun relaunch is undone, Resume starts from the handoff, and with none starts fresh under the same id", () => {
    const r = runGate("658.mjs", { den: "fixed" });
    expect(r.error).toBeUndefined();
    for (let i = 0; i < 3; i++) expect(row(r, i).ok).toBe(true);
  });

  it("the reported Den: the handoff stays archived and Resume answers 502", () => {
    const r = runGate("658.mjs", { den: "unfixed" });
    expect(r.error).toBeUndefined();
    for (let i = 0; i < 3; i++) expect(row(r, i).ok).toBe(false);
    expect(row(r, 2).detail).toMatch(/502/);
  });

  it("a bed without the stub's start modes skips every clause", () => {
    const r = runGate("658.mjs", { modes: false });
    expect(r.error).toBeUndefined();
    for (let i = 0; i < 3; i++)
      expect(row(r, i).skip).toBe("needs-stub-start-modes");
  });
});
