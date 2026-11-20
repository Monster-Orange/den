/**
 * Issue 415's live check, run as the bed runs it (runLikeBed: setup, run
 * per matrix cell, expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate415-fake-den.mjs; GitHub's API stood in, no network).
 * Beyond clauses 1–3 it must answer:
 *   4. unknown visibility shows "not known" with the caution kept: never
 *      the Public repository pill, never a private claim (the bed's
 *      visibility cache says which target Den couldn't learn);
 *   5. with several repos in the drop-down, the pill and note follow the
 *      selected repo;
 *   6. en/es/ja text for the pill, the warning and the note.
 * Each broken part fails its own clause; nothing is sent; the language is
 * put back.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

const UNKNOWN =
  "unknown visibility shows a not-known pill and the caution: never the Public repository pill, never a private claim";
const FOLLOWS =
  "with several repos in the drop-down, the pill and note follow the selected repo";
const WORDS =
  "the pill, the warning and the audience note have en, es and ja text";
const PRIVATE =
  "a private or internal target shows its own pill and no public warning";
const API = "Den gives each report target its real visibility on GitHub";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

const PUB = { repo: "acme/engine", visibility: "public", real: "public" };
const PRIV = { repo: "acme/vault", visibility: "private", real: "not-public" };
const UNK = {
  repo: "acme/nowhere",
  visibility: "unknown",
  real: "not-public",
  unknown: true,
};
/** The old contract: Den said public for a target it couldn't learn. */
const UNK_AS_PUBLIC = { ...UNK, visibility: "public" };

function runGate(opts: Record<string, unknown> = {}) {
  const js = `
    const { fakeBed } = await import("./tests/fixtures/gate415-fake-den.mjs");
    const bed = fakeBed(${JSON.stringify(opts)});
    globalThis.fetch = bed.fetch;
    const g = await import("./gate/415.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const out = await runLikeBed("415.mjs", g, bed.ctx);
    console.log(JSON.stringify({ clauses: g.clauses, sent: bed.sent, language: bed.language(), ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    sent: string[];
    language: string;
    rows?: Row[];
    error?: string;
  };
}

const row = (r: ReturnType<typeof runGate>, clause: string) =>
  (r.rows ?? []).find((x) => x.clause === clause);

describe("gate/415.mjs as the bed runs it", () => {
  it("names clauses 4, 5 and 6", () => {
    const r = runGate();
    expect(r.clauses).toEqual(
      expect.arrayContaining([UNKNOWN, FOLLOWS, WORDS]),
    );
  });

  it("a public and a private target, done right: every clause it can judge passes, nothing sent, language put back", () => {
    const r = runGate({ targets: [PUB, PRIV] });
    expect(r.error).toBeUndefined();
    for (const c of [API, PRIVATE, FOLLOWS, WORDS])
      expect(row(r, c)?.ok).toBe(true);
    expect(row(r, UNKNOWN)).toMatchObject({
      ok: null,
      skip: "needs-unknown-visibility-target",
    });
    expect(r.sent).toEqual([]);
    expect(r.language).toBe("en");
  });

  it("an unknown target shows not known with the caution, and clause 1 leaves it to clause 4", () => {
    const r = runGate({ targets: [PUB, UNK] });
    expect(r.error).toBeUndefined();
    expect(row(r, UNKNOWN)?.ok).toBe(true);
    expect(row(r, API)?.ok).toBe(true);
    expect(row(r, WORDS)?.ok).toBe(true);
  });

  it("an unknown target shown as Public repository fails clause 4", () => {
    const r = runGate({ targets: [PUB, UNK_AS_PUBLIC] });
    expect(r.error).toBeUndefined();
    expect(row(r, UNKNOWN)?.ok).toBe(false);
  });

  it("an unknown target with no caution fails clause 4", () => {
    const r = runGate({ targets: [PUB, UNK], unknownWarn: false });
    expect(r.error).toBeUndefined();
    expect(row(r, UNKNOWN)?.ok).toBe(false);
  });

  it("only the public target (today's bed): 4 and 5 not run with their reasons, 6 runs", () => {
    const r = runGate({ targets: [PUB] });
    expect(row(r, FOLLOWS)).toMatchObject({
      ok: null,
      skip: "needs-private-target",
    });
    expect(row(r, WORDS)?.ok).toBe(true);
  });

  it("a pill that doesn't follow the selected repo fails clause 5", () => {
    const r = runGate({ targets: [PUB, PRIV], pill: "stuck" });
    expect(r.error).toBeUndefined();
    expect(row(r, FOLLOWS)?.ok).toBe(false);
  });

  it("English words in es and ja fail clause 6", () => {
    const r = runGate({ targets: [PUB, PRIV], words: "english" });
    expect(row(r, WORDS)?.ok).toBe(false);
    expect(r.language).toBe("en");
  });

  it("catalog keys in es and ja fail clause 6", () => {
    const r = runGate({ targets: [PUB], words: "keys" });
    expect(row(r, WORDS)?.ok).toBe(false);
  });
});
