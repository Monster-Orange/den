/**
 * #80 (0.4.45): agents.helpers_shown, how many running helpers an agent's
 * open badge shows: 1, 3, 5 or 10 (default 3), in the user config, served
 * by /api/settings as agents_helpers_shown.
 */
import { describe, expect, it } from "@jest/globals";
import type { UserConfig } from "../../../src/shared/den-config.js";
import {
  HELPERS_SHOWN_DEFAULT,
  helpersShown,
  patchHelpersShown,
} from "../../../src/ui/server/agents-layout-pref.js";

describe("agents.helpers_shown (#80)", () => {
  it("unset or hand-broken: 3", () => {
    expect(HELPERS_SHOWN_DEFAULT).toBe(3);
    expect(helpersShown({})).toBe(3);
    for (const bad of [0, 2, "5", 11, null])
      expect(
        helpersShown({ agents: { helpers_shown: bad } } as UserConfig),
      ).toBe(3);
  });

  it("set: 1, 3, 5 or 10; null clears it, and an empty agents block goes", () => {
    const u: UserConfig = { agents: { layout: "tabs" } };
    expect(patchHelpersShown(u, 5)).toEqual({ ok: true });
    expect(helpersShown(u)).toBe(5);
    expect(patchHelpersShown(u, null)).toEqual({ ok: true });
    expect(u.agents).toEqual({ layout: "tabs" });
    const v: UserConfig = {};
    patchHelpersShown(v, 10);
    patchHelpersShown(v, null);
    expect(v.agents).toBeUndefined();
  });

  it("anything else is refused, naming the choices", () => {
    for (const bad of [0, 4, "3", true, 1.5])
      expect(patchHelpersShown({}, bad)).toEqual({
        ok: false,
        error: "agents_helpers_shown must be one of 1, 3, 5, 10, or null",
      });
  });
});
