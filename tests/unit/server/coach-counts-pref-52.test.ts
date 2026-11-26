/**
 * Issue 52, the Coach tab (mock v2): "Show counts as" Total or Per day, a
 * person's view preference, kept in the user config as agents.coach_counts
 * and served by /api/settings as coach_counts. Default: total.
 */
import { describe, expect, it } from "@jest/globals";
import type { UserConfig } from "../../../src/shared/den-config.js";
import {
  COACH_COUNTS_DEFAULT,
  coachCounts,
  patchCoachCounts,
} from "../../../src/ui/server/agents-layout-pref.js";

describe("agents.coach_counts (the Coach tab's Total / Per day)", () => {
  it("unset or hand-broken: total", () => {
    expect(COACH_COUNTS_DEFAULT).toBe("total");
    expect(coachCounts({})).toBe("total");
    for (const bad of [1, "daily", null, true])
      expect(coachCounts({ agents: { coach_counts: bad } } as UserConfig)).toBe(
        "total",
      );
  });

  it("set: total or per_day; null clears it, and an empty agents block goes", () => {
    const u: UserConfig = { agents: { layout: "tabs" } };
    expect(patchCoachCounts(u, "per_day")).toEqual({ ok: true });
    expect(coachCounts(u)).toBe("per_day");
    expect(patchCoachCounts(u, null)).toEqual({ ok: true });
    expect(u.agents).toEqual({ layout: "tabs" });
    const v: UserConfig = {};
    patchCoachCounts(v, "per_day");
    patchCoachCounts(v, null);
    expect(v.agents).toBeUndefined();
  });

  it("anything else is refused, naming the choices", () => {
    for (const bad of ["daily", 1, true])
      expect(patchCoachCounts({}, bad)).toEqual({
        ok: false,
        error: 'coach_counts must be one of "total", "per_day", or null',
      });
  });
});
