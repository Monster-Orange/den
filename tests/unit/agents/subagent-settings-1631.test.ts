import { describe, expect, it } from "@jest/globals";
import {
  AGENTS_SETTINGS_KEYS,
  agentLimitInForce,
  agentsLimitValueError,
  readAgentsConfig,
  type DenConfig,
  type UserConfig,
} from "../../../src/shared/den-config.js";

const den = (agents: Record<string, unknown> = {}) =>
  ({ environments: [], agents }) as unknown as DenConfig;
const user = (agents?: Record<string, unknown>) =>
  (agents ? { agents } : {}) as UserConfig;

describe("issue 1631: agents.max_subagents and agents.subagents_respect_load_hold", () => {
  it("max_subagents defaults to twice max_concurrent, wherever that is set", () => {
    expect(readAgentsConfig(den(), user()).maxSubagents).toBe(8);
    expect(
      readAgentsConfig(den({ max_concurrent: 6 }), user()).maxSubagents,
    ).toBe(12);
    expect(
      readAgentsConfig(den(), user({ max_concurrent: 3 })).maxSubagents,
    ).toBe(6);
    expect(
      agentLimitInForce("max_subagents", user({ max_concurrent: 5 }), den()),
    ).toEqual({
      value: 10,
      from: "default",
    });
  });

  it("a set max_subagents wins, user.yml over den.yml", () => {
    expect(
      readAgentsConfig(den({ max_subagents: 3 }), user()).maxSubagents,
    ).toBe(3);
    expect(
      readAgentsConfig(den({ max_subagents: 3 }), user({ max_subagents: 20 }))
        .maxSubagents,
    ).toBe(20);
  });

  it("the load hold is on by default, and user.yml can turn it off", () => {
    expect(readAgentsConfig(den(), user()).subagentsRespectLoadHold).toBe(true);
    expect(
      readAgentsConfig(den(), user({ subagents_respect_load_hold: false }))
        .subagentsRespectLoadHold,
    ).toBe(false);
    expect(
      agentLimitInForce("subagents_respect_load_hold", user(), den()),
    ).toEqual({
      value: true,
      from: "default",
    });
  });

  it("both are limits Settings, config and setting_change set, checked at the boundary", () => {
    expect(AGENTS_SETTINGS_KEYS).toEqual(
      expect.arrayContaining(["max_subagents", "subagents_respect_load_hold"]),
    );
    expect(agentsLimitValueError("max_subagents", 0)).toMatch(
      /agents\.max_subagents: must be a whole number of at least 1/,
    );
    expect(agentsLimitValueError("max_subagents", 2.5)).not.toBeNull();
    expect(agentsLimitValueError("max_subagents", 16)).toBeNull();
    expect(agentsLimitValueError("subagents_respect_load_hold", "yes")).toMatch(
      /agents\.subagents_respect_load_hold: true or false/,
    );
    expect(
      agentsLimitValueError("subagents_respect_load_hold", false),
    ).toBeNull();
  });
});
