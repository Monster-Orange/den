/**
 * `agents.helpers` (D32): how helpers show. Permissive defaults (active 10
 * minutes, done ones fold after 30); a bad key or value fails naming it.
 */
import { describe, expect, it } from "@jest/globals";
import { HELPER_DEFAULTS } from "../../../src/shared/agents/helpers.js";
import {
  AGENTS_RESERVED_KEYS,
  helpersBlock,
  readAgentsConfig,
  type DenConfig,
} from "../../../src/shared/den-config.js";

const cfg = (helpers: unknown) =>
  ({ agents: { helpers } }) as unknown as DenConfig;

describe("agents.helpers", () => {
  it("unset: the defaults", () => {
    expect(HELPER_DEFAULTS).toEqual({
      activeMinutes: 10,
      collapseDoneMinutes: 30,
    });
    expect(readAgentsConfig({} as DenConfig).helpers).toEqual(HELPER_DEFAULTS);
    expect(helpersBlock(null)).toEqual(HELPER_DEFAULTS);
  });

  it("each key on its own, the other kept at its default", () => {
    expect(readAgentsConfig(cfg({ active_minutes: 2.5 })).helpers).toEqual({
      activeMinutes: 2.5,
      collapseDoneMinutes: 30,
    });
    expect(
      readAgentsConfig(cfg({ collapse_done_minutes: 1440 })).helpers,
    ).toEqual({ activeMinutes: 10, collapseDoneMinutes: 1440 });
  });

  it("is a reserved key, never an agent id", () => {
    expect(AGENTS_RESERVED_KEYS).toContain("helpers");
    expect(
      readAgentsConfig(cfg({ active_minutes: 5 })).agents.helpers,
    ).toBeUndefined();
  });

  it("a bad key or value fails, naming it", () => {
    expect(() => helpersBlock([1])).toThrow(
      "agents.helpers: must be a mapping",
    );
    expect(() => helpersBlock({ active: 5 })).toThrow(
      "agents.helpers.active: unknown key",
    );
    for (const bad of [0, -1, "10", Number.NaN, Infinity, 100_001])
      expect(() => helpersBlock({ active_minutes: bad })).toThrow(
        "agents.helpers.active_minutes: must be a number of minutes",
      );
    expect(helpersBlock({ collapse_done_minutes: 100_000 })).toMatchObject({
      collapseDoneMinutes: 100_000,
    });
  });
});
