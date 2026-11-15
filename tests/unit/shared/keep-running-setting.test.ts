/**
 * Issue 163: Settings › Keep agents running after logout, stored as
 * agents.keep_running_after_logout in user.yml. Off by default (unset);
 * true or false once a person sets it; null clears it. A person's only.
 * `config agents.keep_running_after_logout=true` sets it the same way.
 */
import { describe, expect, it } from "@jest/globals";
import {
  PERSON_ONLY_SETTINGS,
  patchCliRows,
} from "../../../src/shared/settings-cli-rows.js";
import { agentsKeepRunningAfterLogout } from "../../../src/shared/den-config.js";
import { configKeyNames } from "../../../src/ui/cli/config-command.js";

describe("keep running after logout: the setting", () => {
  it("unset reads as undefined (the page shows off); a bad value names the key", () => {
    expect(agentsKeepRunningAfterLogout(() => ({}))).toBeUndefined();
    expect(
      agentsKeepRunningAfterLogout(() => ({
        agents: { keep_running_after_logout: true },
      })),
    ).toBe(true);
    expect(() =>
      agentsKeepRunningAfterLogout(() => ({
        agents: { keep_running_after_logout: "yes" },
      })),
    ).toThrow(/agents.keep_running_after_logout must be true or false/);
  });

  it("sets agents.keep_running_after_logout, keeps the other agents keys, and null clears it", () => {
    const user: Record<string, unknown> = {
      agents: { restore_on_boot: false },
    };
    expect(patchCliRows(user, { keep_running_after_logout: true })).toEqual({
      ok: true,
    });
    expect(user.agents).toEqual({
      restore_on_boot: false,
      keep_running_after_logout: true,
    });
    patchCliRows(user, { keep_running_after_logout: null });
    expect(user.agents).toEqual({ restore_on_boot: false });
    const bare: Record<string, unknown> = {};
    patchCliRows(bare, { keep_running_after_logout: false });
    patchCliRows(bare, { keep_running_after_logout: null });
    expect(bare).toEqual({});
  });

  it("refuses anything but true, false or null, and writes nothing", () => {
    const user: Record<string, unknown> = {};
    expect(patchCliRows(user, { keep_running_after_logout: "on" })).toEqual({
      ok: false,
      error: "keep_running_after_logout is true, false or null",
    });
    expect(user).toEqual({});
  });

  it("is a person's only, and `config` accepts it", () => {
    expect(PERSON_ONLY_SETTINGS).toContain("keep_running_after_logout");
    expect(configKeyNames()).toContain("agents.keep_running_after_logout");
  });
});
