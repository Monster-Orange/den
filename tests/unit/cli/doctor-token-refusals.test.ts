/**
 * Issue 1131, item 3: doctor counts each agent's refused calls (its token
 * from a process Den couldn't place, or from outside its processes) over
 * the last hour, from the audit, and names the last one refused. Never a
 * token.
 */
import { describe, expect, it } from "@jest/globals";
import {
  tokenRefusalLines,
  type RefusalEntry,
} from "../../../src/ui/cli/doctor-token-refusals.js";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const ago = (min: number) =>
  new Date(NOW.getTime() - min * 60_000).toISOString();

function refusal(agent: string, min: number, detail = "d"): RefusalEntry {
  return {
    ts: ago(min),
    verb: "agent-token",
    outcome: "refused",
    principal: `agent:${agent}`,
    reason: "token_unknown",
    detail,
  };
}

describe("issue 1131: doctor's refused agent calls", () => {
  it("none in the last hour: ok, and says so", () => {
    const r = tokenRefusalLines("Den", [refusal("a1", 90)], NOW);
    expect(r.check.id).toBe("agent_token_refusals");
    expect(r.check.status).toBe("ok");
    expect(r.check.detail).toMatch(/none in the last hour/);
  });

  it("counts per agent over the last hour only, most first", () => {
    const r = tokenRefusalLines(
      "Den",
      [
        refusal("a1", 5),
        refusal("a2", 10),
        refusal("a2", 20),
        refusal("a2", 30),
        refusal("a1", 61),
      ],
      NOW,
    );
    expect(r.check.status).toBe("warn");
    expect(r.check.detail).toMatch(/a2: 3.*a1: 1/);
    expect(r.lines.join("\n")).toMatch(/a2: 3/);
  });

  it("a caller that had gone is not counted (it wasn't refused)", () => {
    const gone = { ...refusal("a1", 5), outcome: undefined };
    const r = tokenRefusalLines("Den", [gone], NOW);
    expect(r.check.status).toBe("ok");
  });

  it("names the last refused call, and what to do", () => {
    const r = tokenRefusalLines(
      "Den",
      [
        refusal("a1", 30, "old"),
        refusal(
          "a1",
          2,
          "agent:a1's token from a process Den couldn't place (pid 77): POST /hub/mcp",
        ),
      ],
      NOW,
    );
    const text = r.lines.join("\n");
    expect(text).toContain("pid 77");
    expect(text).not.toContain("old");
    expect(r.check.fix ?? r.check.detail).toMatch(/restart/i);
  });

  it("never carries a token, even one in an entry", () => {
    const leak = refusal("a1", 1, "den_at_TESTONLY_leak from somewhere");
    const r = tokenRefusalLines("Den", [leak], NOW);
    const all = r.lines.join("\n") + r.check.detail + (r.check.fix ?? "");
    expect(all).not.toContain("den_at_TESTONLY_leak");
  });
});
