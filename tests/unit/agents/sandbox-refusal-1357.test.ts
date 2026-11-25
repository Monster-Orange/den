/**
 * Issue 1357: a Bash call that succeeded gets the refusal note only for
 * what it wrote to stderr, never for its ordinary output: a `git diff` or
 * `cat` of a file that names the error refused nothing.
 */
import { describe, expect, it } from "@jest/globals";
import {
  REFUSAL_NOTE,
  refusalNote,
} from "../../../src/shared/agents/guardrails/sandbox-refusal.js";

const IN = { DEN_AGENT_SANDBOX: "1" } as NodeJS.ProcessEnv;

/** The note a Bash call that succeeded with `out` gets in the sandbox. */
const noteFor = (out: { stdout: string; stderr: string }) =>
  refusalNote(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { ...out, interrupted: false, isImage: false },
    },
    IN,
  )?.hookSpecificOutput.additionalContext ?? null;

describe("issue 1357: a Bash call that succeeded", () => {
  it.each([
    [
      "git diff",
      '+    expect(e).toMatch(/Operation not permitted/);\n-    "EPERM: operation not permitted, open"',
    ],
    [
      "grep",
      "src/x.ts:12:const REFUSED = /operation not permitted|\\bEPERM\\b|read-only file system/i;",
    ],
    ["cat", "(eval):1: operation not permitted: ps\n"],
  ])("%s whose stdout names the error: no note", (_what, stdout) => {
    expect(noteFor({ stdout, stderr: "" })).toBeNull();
  });

  it("a refused write on its stderr (the command went on): the state note", () => {
    expect(
      noteFor({
        stdout: "done\n",
        stderr: "cp: /state/agents/x.json: Operation not permitted\n",
      }),
    ).toBe(REFUSAL_NOTE);
  });

  it("a setuid program refused on its stderr: its own note", () => {
    expect(
      noteFor({ stdout: "", stderr: "(eval):1: operation not permitted: ps" }),
    ).toMatch(/setuid/);
  });

  it("a Bash call that failed: its error, as before", () => {
    expect(
      refusalNote(
        {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          error: "cp: /state/agents/x.json: Operation not permitted",
        },
        IN,
      )?.hookSpecificOutput.additionalContext,
    ).toBe(REFUSAL_NOTE);
  });

  it("a response of another shape (a string): read whole, as before", () => {
    expect(
      refusalNote(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_response: "sh: /state/web.json: Operation not permitted",
        },
        IN,
      )?.hookSpecificOutput.additionalContext,
    ).toBe(REFUSAL_NOTE);
  });
});
