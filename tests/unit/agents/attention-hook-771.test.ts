/**
 * Issue 771: Den's Claude hook also prints the open status sequence
 * (OSC 7501) for the state it posts, so other tools that read 7501 see
 * Den's agents too. It goes to the agent's own terminal; a terminal that
 * can't be written is quiet. No real runtime runs.
 */
import { describe, expect, it } from "@jest/globals";
import {
  attentionOf,
  printStatus,
  statusSequence,
} from "../../../src/shared/agents/guardrails/attention-hook.js";
import { BellScanner } from "../../../src/shared/sessions/bell.js";

const ev = (input: Record<string, unknown>) => {
  const e = attentionOf(input);
  if (!e) throw new Error("no event");
  return e;
};
const read = (seq: string) => {
  const s = new BellScanner();
  s.feed(Buffer.from(seq));
  return s.takeStatus()?.state;
};

describe("the 7501 sequence the hook prints (issue 771)", () => {
  it.each([
    [{ hook_event_name: "PermissionRequest", tool_name: "Bash" }, "blocked"],
    [
      {
        hook_event_name: "Notification",
        message: "Claude needs your permission to use Bash",
      },
      "blocked",
    ],
    [
      {
        hook_event_name: "Notification",
        message: "Claude is waiting for your input",
        notification_type: "idle_prompt",
      },
      "idle",
    ],
    [{ hook_event_name: "PostToolUse", tool_name: "Bash" }, "working"],
    [{ hook_event_name: "UserPromptSubmit" }, "working"],
    [{ hook_event_name: "SessionStart", source: "startup" }, "working"],
    [{ hook_event_name: "Stop" }, "done"],
    [
      {
        hook_event_name: "Stop",
        last_assistant_message: "Shall I merge it?",
      },
      "blocked",
    ],
  ])("%j → state=%s, as Den's own scanner reads it", (input, state) => {
    const seq = statusSequence(ev(input));
    expect(seq).toBe(`\u001b]7501;state=${state}\u001b\\`);
    expect(read(seq)).toBe(state);
  });

  it("printStatus writes it once; a write that fails is quiet", () => {
    const out: string[] = [];
    printStatus(ev({ hook_event_name: "Stop" }), (s) => out.push(s));
    expect(out).toEqual(["\u001b]7501;state=done\u001b\\"]);
    expect(() =>
      printStatus(ev({ hook_event_name: "Stop" }), () => {
        throw new Error("ENXIO: no terminal");
      }),
    ).not.toThrow();
  });
});
