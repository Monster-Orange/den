/**
 * `agents.helpers` (D32/D34): how helpers show. Permissive defaults (idle
 * after 10 minutes, 4 under the selected row); collapse_done_minutes is
 * deprecated and ignored (0.4.29); a bad key or value fails naming it.
 */
import { describe, expect, it } from "@jest/globals";
import { HELPER_DEFAULTS } from "../../../src/shared/agents/helpers.js";
import {
  AGENTS_RESERVED_KEYS,
  DEFAULT_EXITED_SHELL_MINUTES,
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
      rowMax: 4,
      readMaxMb: 64,
    });
    expect(readAgentsConfig({} as DenConfig).helpers).toEqual(HELPER_DEFAULTS);
    expect(helpersBlock(null)).toEqual(HELPER_DEFAULTS);
  });

  it("each key on its own, the other kept at its default", () => {
    expect(readAgentsConfig(cfg({ active_minutes: 2.5 })).helpers).toEqual({
      activeMinutes: 2.5,
      collapseDoneMinutes: 30,
      rowMax: 4,
      readMaxMb: 64,
    });
    expect(readAgentsConfig(cfg({ row_max: 12 })).helpers).toEqual({
      activeMinutes: 10,
      collapseDoneMinutes: 30,
      rowMax: 12,
      readMaxMb: 64,
    });
    // D76: how much of an agent's transcript its helpers are read from.
    expect(readAgentsConfig(cfg({ read_max_mb: 512 })).helpers.readMaxMb).toBe(
      512,
    );
    // Deprecated: still accepted, so a config that sets it keeps working.
    expect(
      readAgentsConfig(cfg({ collapse_done_minutes: 1440 })).helpers,
    ).toMatchObject({ activeMinutes: 10, rowMax: 4 });
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
    for (const bad of [0, 1.5, "4", 1001])
      expect(() => helpersBlock({ row_max: bad })).toThrow(
        "agents.helpers.row_max: must be a whole number from 1 to 1000",
      );
    for (const bad of [0, -1, "64", Number.NaN, 4097])
      expect(() => helpersBlock({ read_max_mb: bad })).toThrow(
        "agents.helpers.read_max_mb: must be a number of MB",
      );
  });
});

describe("agents.turn_read_max_mb (D39)", () => {
  const turn = (v: unknown) =>
    readAgentsConfig({
      agents: { turn_read_max_mb: v },
    } as unknown as DenConfig).turnReadMaxBytes;

  it("unset: the default; set: in bytes; it is no agent id", () => {
    expect(readAgentsConfig({} as DenConfig).turnReadMaxBytes).toBeUndefined();
    expect(turn(2)).toBe(2 * 1024 * 1024);
    expect(turn(0.5)).toBe(512 * 1024);
    expect(AGENTS_RESERVED_KEYS).toContain("turn_read_max_mb");
    expect(
      readAgentsConfig({
        agents: { turn_read_max_mb: 2 },
      } as unknown as DenConfig).agents,
    ).toEqual({});
  });

  it("a bad value fails naming the key", () => {
    for (const bad of [0, -1, 5000, "8", true])
      expect(() => turn(bad)).toThrow(/agents\.turn_read_max_mb: must be/);
  });
});

describe("agents.exited_shell_minutes (0.4.45)", () => {
  const minutes = (v: unknown) =>
    readAgentsConfig({
      agents: { exited_shell_minutes: v },
    } as unknown as DenConfig).exitedShellMinutes;

  it("unset: the default; 0: never; it is no agent id", () => {
    expect(
      readAgentsConfig({} as DenConfig).exitedShellMinutes,
    ).toBeUndefined();
    expect(DEFAULT_EXITED_SHELL_MINUTES).toBe(10);
    expect(minutes(0)).toBe(0);
    expect(minutes(2.5)).toBe(2.5);
    expect(AGENTS_RESERVED_KEYS).toContain("exited_shell_minutes");
  });

  it("a bad value fails naming the key", () => {
    for (const bad of [-1, "10", true, Infinity])
      expect(() => minutes(bad)).toThrow(
        /agents\.exited_shell_minutes: must be/,
      );
  });
});
