/**
 * Issue 271's live check, run as the bed runs it (runLikeBed: setup, run
 * per matrix cell, expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate271-fake-den.mjs). The issue's "en/es/ja": the Hub
 * project row (label, "Create a Hub project named …", the button) read in
 * each language. English or catalog keys in es or ja fail; the language is
 * put back; without a Hub the row is not run, for the same cause.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const WORDS = "the picker's words have en, es and ja text";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function runGate(opts: Record<string, unknown> = {}) {
  const js = `
    const g = await import("./gate/271.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate271-fake-den.mjs");
    const bed = fakeBed(${JSON.stringify(opts)});
    const out = await runLikeBed("271.mjs", g, bed.ctx);
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

const row = (r: ReturnType<typeof runGate>) =>
  (r.rows ?? []).find((x) => x.clause === WORDS);

describe("gate/271.mjs as the bed runs it: en/es/ja", () => {
  it("names the en/es/ja clause", () => {
    expect(runGate().clauses).toContain(WORDS);
  });

  it("the row in en, es and ja: passes, and the language is put back", () => {
    const r = runGate();
    expect(r.error).toBeUndefined();
    expect(row(r)?.ok).toBe(true);
    expect(r.language).toBe("en");
  });

  it("English in es and ja: fails", () => {
    const r = runGate({ words: "english" });
    expect(row(r)?.ok).toBe(false);
    expect(r.language).toBe("en");
  });

  it("catalog keys in es and ja: fails", () => {
    expect(row(runGate({ words: "keys" }))?.ok).toBe(false);
  });

  it("no Hub: not run, for the same cause as the first clause", () => {
    const r = runGate({ state: "offline" });
    expect(row(r)?.ok).toBeNull();
    expect(row(r)?.skip).toBe("needs-hub");
  });
});
