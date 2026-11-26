import { describe, expect, it } from "@jest/globals";
import {
  USER_ONLY_WIDENING,
  readAgentsConfig,
  type DenConfig,
} from "../../../src/shared/den-config.js";
import { settingKind } from "../../../src/ui/cli/setting-change.js";

describe("issue 988: agents.os_login is the agents' boundary", () => {
  it("is an agent power, high severity, that widens on every mode and value", () => {
    for (const mode of ["strict", "personal"] as const) {
      expect(settingKind("agents.os_login", mode)).toMatchObject({
        category: "agent_powers",
        severity: "high",
        widens: true,
      });
      for (const [next, now] of [
        ["off", "on"],
        ["on", "off"],
      ])
        expect(settingKind("agents.os_login", mode, next, now).widens).toBe(
          true,
        );
    }
  });

  it("is read from user.yml only", () => {
    expect(USER_ONLY_WIDENING).toContain("agents.os_login");
  });

  it("set in the distribution's config, it is refused and names user.yml", () => {
    for (const v of ["on", "off", true, false])
      expect(() =>
        readAgentsConfig(
          { agents: { os_login: v } } as unknown as DenConfig,
          {},
        ),
      ).toThrow(/agents\.os_login.*user\.yml/);
  });

  it("set in user.yml, it names no agent", () => {
    const r = readAgentsConfig({} as DenConfig, {
      agents: { os_login: "on" },
    } as never);
    expect(Object.keys(r.agents ?? {})).not.toContain("os_login");
  });
});
