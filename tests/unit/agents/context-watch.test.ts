/**
 * Issue 278: agents stuck compacting, and instruction files that eat the
 * context.
 *
 *   1. Compactions are read from the transcript's own compact_boundary
 *      records (followed, never the whole file at once); more than N
 *      automatic ones in M minutes is one episode: one ring, not one per
 *      compaction. Manual ones never count.
 *   2. The instruction files Claude Code loads for a folder are found by
 *      stat (never read) up to home, and measured against a share of the
 *      context (bytes / 4 tokens), naming the largest.
 *   3. With pause on, the episode holds deliveries until a person clears it.
 *
 * Temp dirs and invented names only; synthetic transcript lines.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CONTEXT_WATCH_DEFAULTS,
  clearCompacting,
  contextTokensFor,
  contextWatchSettings,
  instructionCheck,
  instructionFiles,
  instructionWarning,
  stepCompacting,
} from "../../../src/shared/agents/context-watch.js";
import {
  resetFollowers,
  transcriptCompactions,
} from "../../../src/shared/agents/transcript-follow.js";

const dirs: string[] = [];
afterEach(() => {
  resetFollowers();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-ctxw-")),
  );
  dirs.push(d);
  return d;
}

const T0 = Date.parse("2026-03-01T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function boundary(min: number, trigger: "auto" | "manual"): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    timestamp: at(min),
    compactMetadata: { trigger, preTokens: 380000 },
  });
}
const userLine = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });

describe("issue 278 clause 1: compactions from the transcript", () => {
  it("reads compact_boundary records, auto and manual, and follows on", () => {
    const file = path.join(tmp(), "t.jsonl");
    fs.writeFileSync(
      file,
      [
        userLine("hello"),
        boundary(0, "auto"),
        userLine("a compact_boundary in a message is not one"),
        boundary(1, "manual"),
      ].join("\n") + "\n",
    );
    expect(transcriptCompactions(file, 1 << 20)).toEqual([
      { at: T0, auto: true },
      { at: T0 + 60_000, auto: false },
    ]);
    fs.appendFileSync(file, boundary(2, "auto") + "\n");
    expect(transcriptCompactions(file, 1 << 20)?.map((c) => c.auto)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("a long transcript is read from near its end only", () => {
    const file = path.join(tmp(), "t.jsonl");
    const pad = userLine("x".repeat(4000));
    fs.writeFileSync(
      file,
      [boundary(0, "auto"), ...Array(50).fill(pad), boundary(9, "auto")].join(
        "\n",
      ) + "\n",
    );
    const got = transcriptCompactions(file, 16 * 1024);
    expect(got).toEqual([{ at: T0 + 9 * 60_000, auto: true }]);
  });

  it("no file: null, never a throw", () => {
    expect(transcriptCompactions(path.join(tmp(), "none.jsonl"), 1024)).toBe(
      null,
    );
  });

  const s = { loopCount: 3, loopMinutes: 10, pause: false };
  const autos = (mins: number[]) =>
    mins.map((m) => ({ at: T0 + m * 60_000, auto: true }));

  it("more than N automatic ones in M minutes rings once per episode", () => {
    // 3 in 10 minutes: not yet.
    let r = stepCompacting(null, autos([0, 1, 2]), "c1", T0 + 3 * 60_000, s);
    expect(r.ring).toBe(false);
    expect(r.state.active).toBe(false);
    // The 4th: rings.
    r = stepCompacting(
      r.state,
      autos([0, 1, 2, 3]),
      "c1",
      T0 + 3.5 * 60_000,
      s,
    );
    expect(r.ring).toBe(true);
    expect(r.state).toMatchObject({ active: true, count: 4 });
    // The 5th, 6th: the same episode, no new ring.
    r = stepCompacting(
      r.state,
      autos([0, 1, 2, 3, 4]),
      "c1",
      T0 + 4.5 * 60_000,
      s,
    );
    expect(r.ring).toBe(false);
    r = stepCompacting(
      r.state,
      autos([0, 1, 2, 3, 4, 5]),
      "c1",
      T0 + 5.5 * 60_000,
      s,
    );
    expect(r.ring).toBe(false);
    expect(r.state.count).toBe(6);
    // Quiet for M minutes: over.
    r = stepCompacting(
      r.state,
      autos([0, 1, 2, 3, 4, 5]),
      "c1",
      T0 + 30 * 60_000,
      s,
    );
    expect(r.state.active).toBe(false);
    // A new loop later: a new episode, a new ring.
    const later = autos([0, 1, 2, 3, 4, 5, 40, 41, 42, 43]);
    r = stepCompacting(r.state, later, "c1", T0 + 43.5 * 60_000, s);
    expect(r.ring).toBe(true);
  });

  it("manual compactions never count", () => {
    const list = [0, 1, 2, 3, 4].map((m) => ({
      at: T0 + m * 60_000,
      auto: false,
    }));
    const r = stepCompacting(null, list, "c1", T0 + 5 * 60_000, s);
    expect(r.ring).toBe(false);
  });

  it("the limits are settings: 1 in 5 rings on the 2nd", () => {
    const one = { loopCount: 1, loopMinutes: 5, pause: false };
    expect(stepCompacting(null, autos([0]), "c1", T0, one).ring).toBe(false);
    expect(
      stepCompacting(null, autos([0, 1]), "c1", T0 + 60_000, one).ring,
    ).toBe(true);
  });
});

describe("issue 278 clause 3: optional pause", () => {
  const list = [0, 1, 2, 3].map((m) => ({ at: T0 + m * 60_000, auto: true }));
  it("off by default: an episode holds nothing", () => {
    const r = stepCompacting(null, list, "c1", T0 + 4 * 60_000, {
      ...CONTEXT_WATCH_DEFAULTS,
    });
    expect(r.ring).toBe(true);
    expect(r.state.paused).toBeUndefined();
  });
  it("on: held from the bell, still held after the loop ends, until cleared", () => {
    const s = { loopCount: 3, loopMinutes: 10, pause: true };
    let r = stepCompacting(null, list, "c1", T0 + 4 * 60_000, s);
    expect(r.state.paused).toBe(true);
    r = stepCompacting(r.state, list, "c1", T0 + 60 * 60_000, s);
    expect(r.state.active).toBe(false);
    expect(r.state.paused).toBe(true);
    const c = clearCompacting("c1", new Date(T0 + 61 * 60_000));
    expect(c.paused).toBeUndefined();
    // What came before the clear never counts again.
    r = stepCompacting(c, list, "c1", T0 + 62 * 60_000, s);
    expect(r.ring).toBe(false);
    expect(r.state.paused).toBeUndefined();
  });
});

describe("issue 278 clause 2: instruction files", () => {
  function tree() {
    const home = tmp();
    const repo = path.join(home, "work", "acme-app");
    const cwd = path.join(repo, "packages", "web");
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "u".repeat(100));
    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "a".repeat(10));
    fs.writeFileSync(path.join(cwd, "CLAUDE.local.md"), "b".repeat(20));
    fs.writeFileSync(path.join(cwd, ".claude", "CLAUDE.md"), "c".repeat(30));
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "d".repeat(840 * 1024));
    fs.writeFileSync(path.join(home, "CLAUDE.md"), "e".repeat(5));
    // Not loaded at start: a folder below, and a file of another name.
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src", "CLAUDE.md"), "f".repeat(999));
    fs.writeFileSync(path.join(cwd, "README.md"), "g".repeat(999));
    return { home, repo, cwd };
  }

  it("finds the user's, the folder's and each parent's up to home, by size", () => {
    const { home, repo, cwd } = tree();
    const files = instructionFiles(cwd, { HOME: home });
    expect(
      files.map((f) => [path.relative(home, f.path), f.bytes]).sort(),
    ).toEqual(
      [
        [path.join(".claude", "CLAUDE.md"), 100],
        [path.relative(home, path.join(cwd, "CLAUDE.md")), 10],
        [path.relative(home, path.join(cwd, "CLAUDE.local.md")), 20],
        [path.relative(home, path.join(cwd, ".claude", "CLAUDE.md")), 30],
        [path.relative(home, path.join(repo, "AGENTS.md")), 840 * 1024],
        ["CLAUDE.md", 5],
      ].sort(),
    );
  });

  it("never reads a file's contents (stat only): unreadable files still measure", () => {
    const { home, cwd } = tree();
    const big = path.join(cwd, "CLAUDE.md");
    fs.chmodSync(big, 0o000);
    try {
      const f = instructionFiles(cwd, { HOME: home }).find(
        (x) => x.path === big,
      );
      expect(f?.bytes).toBe(10);
    } finally {
      fs.chmodSync(big, 0o600);
    }
  });

  it("over the share warns, naming the largest file relative to the folder", () => {
    const { home, cwd } = tree();
    const c = instructionCheck(instructionFiles(cwd, { HOME: home }), cwd, {
      sharePercent: 15,
      contextTokens: 200_000,
      home,
    });
    expect(c.over).toBe(true);
    expect(c.tokens).toBe(Math.ceil(c.totalBytes / 4));
    expect(c.largest).toEqual({
      path: path.join("..", "..", "AGENTS.md"),
      bytes: 840 * 1024,
    });
    expect(instructionWarning(c)).toContain(
      `${path.join("..", "..", "AGENTS.md")} (840 KB)`,
    );
  });

  it("under the share: no warning; the share and size are settings", () => {
    const { home, cwd } = tree();
    const files = instructionFiles(cwd, { HOME: home });
    expect(
      instructionCheck(files, cwd, {
        sharePercent: 15,
        contextTokens: 2_000_000,
        home,
      }).over,
    ).toBe(false);
    expect(
      instructionCheck(files, cwd, {
        sharePercent: 50,
        contextTokens: 1_000_000,
        home,
      }).over,
    ).toBe(false);
  });

  it("the user's own file is named from home", () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "u".repeat(4000));
    const cwd = path.join(home, "w");
    fs.mkdirSync(cwd);
    const c = instructionCheck(instructionFiles(cwd, { HOME: home }), cwd, {
      sharePercent: 0.1,
      contextTokens: 200_000,
      home,
    });
    expect(c.largest?.path).toBe(path.join("~", ".claude", "CLAUDE.md"));
  });

  it("a folder outside home stops at its repo's root", () => {
    const home = tmp();
    const top = tmp();
    const repo = path.join(top, "r");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(top, "CLAUDE.md"), "x");
    fs.writeFileSync(path.join(repo, "CLAUDE.md"), "y");
    const files = instructionFiles(repo, { HOME: home });
    expect(files.map((f) => f.path)).toEqual([path.join(repo, "CLAUDE.md")]);
  });

  it("the context comes from the model when Den knows it", () => {
    expect(contextTokensFor("opus[1m]", undefined, 200_000)).toBe(1_000_000);
    expect(contextTokensFor("sonnet", "claude-sonnet-5-5", 123_000)).toBe(
      123_000,
    );
  });
});

describe("issue 278: the settings", () => {
  it("defaults 3 in 10, pause off, 15%, 200k; bad values fall back", () => {
    expect(contextWatchSettings(undefined)).toEqual({
      loopCount: 3,
      loopMinutes: 10,
      pause: false,
      sharePercent: 15,
      contextTokens: 200_000,
    });
    expect(
      contextWatchSettings({
        compaction_loop_count: 5,
        compaction_loop_minutes: "x",
        pause_after_loop: true,
        instruction_share_percent: 0,
        context_tokens: 500_000,
      }),
    ).toEqual({
      loopCount: 5,
      loopMinutes: 10,
      pause: true,
      sharePercent: 15,
      contextTokens: 500_000,
    });
  });
});
