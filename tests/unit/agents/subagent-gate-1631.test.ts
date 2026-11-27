import { describe, expect, it } from "@jest/globals";
import {
  SubagentGate,
  type SubagentGateDeps,
} from "../../../src/shared/agents/subagent-gate.js";

function gate(over: Partial<SubagentGateDeps> = {}) {
  let now = 1_000_000;
  const running: { agent: string; startedAt: number }[] = [];
  const deps: SubagentGateDeps = {
    maxSubagents: () => 8,
    respectLoadHold: () => true,
    loadCeiling: () => 12,
    load1: () => 1,
    running: () => running,
    now: () => now,
    ...over,
  };
  return {
    g: new SubagentGate(deps),
    running,
    tick: (ms: number) => (now += ms),
    at: () => now,
  };
}

describe("issue 1631: Den's limit on subagents (agents.max_subagents)", () => {
  it("a swarm that starts many in one message stops at the cap, and the rest are refused", () => {
    const { g } = gate();
    const got = Array.from({ length: 12 }, () => g.decide("swarmer"));
    expect(got.filter((d) => d.ok)).toHaveLength(8);
    const no = got.filter((d) => !d.ok);
    expect(no).toHaveLength(4);
    expect(no[0]).toEqual({
      ok: false,
      reason: "max_subagents",
      message:
        "Den's subagent limit is reached (8 of 8 running, agents.max_subagents); start fewer, or wait.",
    });
  });

  it("an ordinary agent's single subagent is never refused below the cap, whatever max_concurrent is", () => {
    const { g, running, at } = gate();
    for (let i = 0; i < 7; i++)
      running.push({ agent: `a${i}`, startedAt: at() - 60_000 });
    expect(g.decide("reviewer")).toEqual({ ok: true });
  });

  it("a subagent that has started isn't counted twice (its reservation and its record)", () => {
    const { g, running, tick, at } = gate({ maxSubagents: () => 2 });
    expect(g.decide("a").ok).toBe(true);
    tick(2_000);
    running.push({ agent: "a", startedAt: at() });
    expect(g.decide("b").ok).toBe(true);
    tick(2_000);
    running.push({ agent: "b", startedAt: at() });
    expect(g.decide("c").ok).toBe(false);
  });

  it("a reservation that never shows up as a subagent stops counting after its wait", () => {
    const { g, tick } = gate({ maxSubagents: () => 1 });
    expect(g.decide("a").ok).toBe(true);
    expect(g.decide("a").ok).toBe(false);
    tick(121_000);
    expect(g.decide("a").ok).toBe(true);
  });

  it("while the load hold applies, a new subagent is refused, naming the setting", () => {
    const { g } = gate({ load1: () => 20 });
    expect(g.decide("a")).toEqual({
      ok: false,
      reason: "load_hold",
      message:
        "The machine is under load (load 20.0 over 12, agents.subagents_respect_load_hold); wait, or start fewer.",
    });
  });

  it("with agents.subagents_respect_load_hold off, or no ceiling set, load doesn't refuse it", () => {
    expect(
      gate({ load1: () => 20, respectLoadHold: () => false }).g.decide("a").ok,
    ).toBe(true);
    expect(
      gate({ load1: () => 20, loadCeiling: () => undefined }).g.decide("a").ok,
    ).toBe(true);
  });

  it("a refused start reserves nothing", () => {
    let load = 20;
    const { g } = gate({ maxSubagents: () => 1, load1: () => load });
    expect(g.decide("a").ok).toBe(false);
    load = 1;
    expect(g.decide("a").ok).toBe(true);
  });
});
