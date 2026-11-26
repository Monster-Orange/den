/**
 * Issue 936: a write the agent sandbox refused shows the agent a plain
 * reason (Den's state is read-only to it, and what to use instead), never
 * a bare permission error. Only inside the sandbox; nothing otherwise.
 */
import { describe, expect, it } from "@jest/globals";
import { refusalNote } from "../../../src/shared/agents/guardrails/sandbox-refusal.js";

const inBox = { DEN_AGENT_SANDBOX: "1" };

describe("refusalNote (issue 936)", () => {
  it("a failed tool with a refused write: the reason, for the agent", () => {
    const out = refusalNote(
      {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        error: "sh: /home/x/.den/agents/a1.json: Operation not permitted",
      },
      inBox,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext: expect.stringContaining(
          "Den's agent sandbox refused that write",
        ),
      },
    });
    const text = out!.hookSpecificOutput.additionalContext;
    expect(text).toContain("Den's state is read-only to an agent");
    expect(text).toMatch(/held write/);
  });

  it("a tool that finished with EPERM or a read-only file system in its output", () => {
    for (const r of [
      { stderr: "mv: rename a to b: Operation not permitted" },
      "EPERM: operation not permitted, open '/x'",
      { output: "touch: /x: Read-only file system" },
    ])
      expect(
        refusalNote(
          {
            hook_event_name: "PostToolUse",
            tool_name: "Bash",
            tool_response: r,
          },
          inBox,
        )?.hookSpecificOutput.hookEventName,
      ).toBe("PostToolUse");
  });

  it("says nothing outside the sandbox, or for other failures", () => {
    const refused = {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      error: "Operation not permitted",
    };
    expect(refusalNote(refused, {})).toBeNull();
    expect(
      refusalNote({ ...refused, error: "No such file or directory" }, inBox),
    ).toBeNull();
    expect(refusalNote({ hook_event_name: "Stop" }, inBox)).toBeNull();
  });
});
