/**
 * Drill (b), 0.4.48: the mode an agent's process runs in, from its own
 * command line. Invented command lines only; nothing runs ps here except
 * the last case, which asks about this test's own process.
 */
import { describe, expect, it } from "@jest/globals";
import {
  intentOfCommandLine,
  psCommandLine,
  runningIntent,
} from "../../../src/shared/agents/running-mode.js";

const T = "0f1e2d3c-aaaa-bbbb-cccc-000000000001";

describe("intentOfCommandLine", () => {
  it.each([
    ["claude --resume x --permission-mode default --model m", "ask"],
    ["claude --permission-mode acceptEdits", "edits"],
    ["claude --permission-mode auto --append-system-prompt hi", "auto"],
    ["claude --permission-mode=bypassPermissions", "all"],
    ["claude --dangerously-skip-permissions", "all"],
  ])("%s → %s", (line, want) => {
    expect(intentOfCommandLine(line)).toBe(want);
  });

  it("says nothing without the flag, for a mode it doesn't know, or no line", () => {
    expect(intentOfCommandLine("codex --model m")).toBeUndefined();
    expect(
      intentOfCommandLine("claude --permission-mode plan"),
    ).toBeUndefined();
    expect(intentOfCommandLine(null)).toBeUndefined();
    expect(
      intentOfCommandLine("claude --permission-modex auto"),
    ).toBeUndefined();
  });
});

describe("runningIntent", () => {
  it("only a line that names the agent's own conversation counts", () => {
    const line = `claude --resume ${T} --permission-mode auto`;
    expect(runningIntent(7, T, () => line)).toBe("auto");
    expect(runningIntent(7, "another", () => line)).toBeUndefined();
    expect(runningIntent(7, undefined, () => line)).toBeUndefined();
    // A token that is only part of a longer word doesn't count.
    expect(runningIntent(7, T.slice(0, 8), () => line)).toBeUndefined();
  });

  it("ps: this process's own line has no mode; a pid that isn't one is null", () => {
    expect(psCommandLine(process.pid)).toEqual(expect.any(String));
    expect(intentOfCommandLine(psCommandLine(process.pid))).toBeUndefined();
    expect(psCommandLine(0)).toBeNull();
    expect(psCommandLine(-5)).toBeNull();
  });
});
