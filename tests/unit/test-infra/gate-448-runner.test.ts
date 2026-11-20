/**
 * Issue 448's live check, run as the bed runs it (runLikeBed: setup, run
 * per matrix cell, expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate448-fake-den.mjs). The check must also answer the
 * issue's last two clauses:
 *   5. every new string has en, es and ja text: the shell bar's New
 *      terminal and its tip, read on the page in each language;
 *   6. the e2e case: the rail's Terminal clicked twice gives one shell
 *      session and the same pane focused.
 * A Den with no es/ja words, or one that starts a shell on every click,
 * fails its own clause; the language is put back.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

const WORDS =
  "every new string (New terminal and its tip) has en, es and ja text";
const E2E =
  "the e2e case: the rail's Terminal clicked twice gives one shell session and the same pane focused";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function runGate(opts: { policy?: string; words?: string } = {}) {
  const js = `
    const g = await import("./gate/448.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate448-fake-den.mjs");
    const bed = fakeBed(${JSON.stringify(opts)});
    const out = await runLikeBed("448.mjs", g, bed.ctx);
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

describe("gate/448.mjs as the bed runs it", () => {
  it("names the en/es/ja clause and the e2e clause", () => {
    const r = runGate();
    expect(r.clauses).toEqual(expect.arrayContaining([WORDS, E2E]));
  });

  it("a Den that does it right: no error, every clause passes, the language is put back", () => {
    const r = runGate();
    expect(r.error).toBeUndefined();
    expect(r.rows?.length).toBe(r.clauses.length);
    expect((r.rows ?? []).filter((x) => x.ok !== true)).toEqual([]);
    expect(r.language).toBe("en");
  });

  it("a Den with English words in es and ja fails the en/es/ja clause", () => {
    const r = runGate({ words: "english" });
    expect(r.error).toBeUndefined();
    expect(row(r, WORDS)?.ok).toBe(false);
    expect(r.language).toBe("en");
  });

  it("a Den that shows catalog keys in es and ja fails the en/es/ja clause", () => {
    const r = runGate({ words: "keys" });
    expect(r.error).toBeUndefined();
    expect(row(r, WORDS)?.ok).toBe(false);
  });

  it("a Den that starts a shell on every click fails the e2e clause", () => {
    const r = runGate({ policy: "new" });
    expect(r.error).toBeUndefined();
    expect(row(r, E2E)?.ok).toBe(false);
  });
});
