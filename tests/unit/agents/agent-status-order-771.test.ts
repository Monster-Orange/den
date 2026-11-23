/**
 * Issue 771 with issue 770: one status model. An agent's status comes from
 * its hook (Claude with Den's hooks on), then an explicit OSC 7501 its own
 * terminal said, then the screen rules' reading, else nothing (the caller
 * keeps the bell and output stopped). A 7501 gives way once the screen
 * shows a different matched state after it; a screen that says nothing
 * (no rule, a transcript viewer, unknown) never drops it.
 */
import { describe, expect, it } from "@jest/globals";
import {
  agentStatus,
  fromTerm,
  type AgentStatus,
  type Detection,
} from "../../../src/shared/agents/detect/index.js";
import type { StatusState } from "../../../src/shared/sessions/bell.js";

const screen = (
  state: Detection["state"],
  over: Partial<Detection> = {},
): Detection => ({
  state,
  rule: "r",
  fallback: false,
  skip: false,
  visibleBlocker: false,
  ...over,
});
const T0 = "2026-11-23T04:00:00.000Z";
const T1 = "2026-11-23T04:00:05.000Z";

describe("fromTerm: 7501's five states onto Den's three", () => {
  const cases: [StatusState, AgentStatus, boolean][] = [
    ["working", "working", false],
    ["blocked", "blocked", false],
    ["error", "blocked", false],
    ["idle", "idle", false],
    ["done", "idle", true],
  ];
  it.each(cases)("%s is %s (finished %s)", (state, status, finished) => {
    expect(fromTerm(state)).toEqual({ status, finished });
  });
});

describe("agentStatus: hook, then 7501, then screen", () => {
  it("the hook wins over a 7501 and the screen", () => {
    expect(
      agentStatus({
        hook: "idle",
        term: { state: "blocked", at: T0 },
        screen: screen("working"),
      }),
    ).toBe("idle");
  });

  it("a 7501 wins over the screen read before it", () => {
    expect(
      agentStatus({
        term: { state: "error", at: T1 },
        screen: screen("working"),
        screenAt: T0,
      }),
    ).toBe("blocked");
  });

  it("a 7501 gives way to a different matched screen state after it", () => {
    expect(
      agentStatus({
        term: { state: "blocked", at: T0 },
        screen: screen("working"),
        screenAt: T1,
      }),
    ).toBe("working");
  });

  it.each([
    ["no rule matched", screen("unknown", { fallback: true, rule: null })],
    ["a transcript viewer", screen("working", { skip: true })],
    ["unknown", screen("unknown")],
  ])("%s on screen after it never drops a 7501", (_w, s) => {
    expect(
      agentStatus({
        term: { state: "blocked", at: T0 },
        screen: s,
        screenAt: T1,
      }),
    ).toBe("blocked");
  });

  it("with no 7501, the screen; with nothing, undefined", () => {
    expect(agentStatus({ screen: screen("blocked") })).toBe("blocked");
    expect(agentStatus({})).toBeUndefined();
    expect(
      agentStatus({ screen: screen("unknown", { fallback: true }) }),
    ).toBeUndefined();
  });
});
