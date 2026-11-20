/**
 * Issue 160's live check, run as the bed runs it (runLikeBed: setup, run
 * per matrix cell, expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate160-fake-den.mjs). Clause 4's "en/es/ja": the
 * install's approval-policy rows (Agent writes, watched, always ask) read
 * on Settings in each language. English words or empty ones in es or ja
 * fail; the language is put back.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

const WORDS = "the policy's settings have en, es and ja text";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function runGate(opts: Record<string, unknown> = {}) {
  const js = `
    const g = await import("./gate/160.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate160-fake-den.mjs");
    const bed = fakeBed(${JSON.stringify(opts)});
    const out = await runLikeBed("160.mjs", g, bed.ctx);
    console.log(JSON.stringify({ clauses: g.clauses, language: bed.language(), ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    language: string;
    rows?: Row[];
    error?: string;
  };
}

const row = (r: ReturnType<typeof runGate>, clause: string) =>
  (r.rows ?? []).find((x) => x.clause === clause);

describe("gate/160.mjs as the bed runs it", () => {
  it("names the en/es/ja clause", () => {
    expect(runGate().clauses).toContain(WORDS);
  });

  it("a Den with the rows in en, es and ja: passes, and the language is put back", () => {
    const r = runGate();
    expect(r.error).toBeUndefined();
    expect(row(r, WORDS)?.ok).toBe(true);
    expect(r.language).toBe("en");
  });

  it("English words in es and ja fail", () => {
    const r = runGate({ words: "english" });
    expect(r.error).toBeUndefined();
    expect(row(r, WORDS)?.ok).toBe(false);
    expect(r.language).toBe("en");
  });

  it("empty words in es and ja fail", () => {
    const r = runGate({ words: "keys" });
    expect(row(r, WORDS)?.ok).toBe(false);
  });
});
