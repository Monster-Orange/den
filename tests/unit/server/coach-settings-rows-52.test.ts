/**
 * Issue 52, the Coach's Settings rows (Settings › Agents): Coach on or
 * off, its window in days, and judging. A person sets them; POST
 * /api/settings writes them to config/local/user.yml's agents.coach and
 * nowhere else, and an agent's token can't write them at all (the route is
 * person-only). user.yml's enabled and window_days count over the
 * distribution's; judge.enabled counts only from user.yml (slice T-d).
 */
import { describe, expect, it } from "@jest/globals";
import {
  readAgentsConfig,
  type DenConfig,
  type UserConfig,
} from "../../../src/shared/den-config.js";
import { AGENT_PERSON_WRITES } from "../../../src/ui/server/request-guard.js";
import {
  coachPrefs,
  patchCoach,
} from "../../../src/ui/server/coach-settings-pref.js";
import { checkCoachConfig } from "../../../src/shared/coach/settings.js";

const dist = (coach: unknown) =>
  ({ environments: [], agents: { coach } }) as unknown as DenConfig;

describe("what Settings shows (GET /api/settings coach)", () => {
  it("the Coach's effective on, window and judging", () => {
    const eff = checkCoachConfig({
      enabled: true,
      window_days: 14,
      judge: { budget_tokens: 5000 },
    });
    expect(coachPrefs(eff)).toEqual({
      enabled: true,
      window_days: 14,
      judge: { enabled: false },
    });
  });
});

describe("what Settings writes (POST /api/settings coach → user.yml)", () => {
  it("sets each one under agents.coach, keeping the rest of agents", () => {
    const u: UserConfig = { agents: { layout: "tabs" } } as UserConfig;
    expect(
      patchCoach(u, {
        enabled: true,
        window_days: 14,
        judge: { enabled: true },
      }),
    ).toEqual({ ok: true });
    expect(u.agents).toEqual({
      layout: "tabs",
      coach: { enabled: true, window_days: 14, judge: { enabled: true } },
    });
  });

  it("null clears one; an empty coach block, and then agents, go", () => {
    const u: UserConfig = {};
    patchCoach(u, { enabled: true, judge: { enabled: true } });
    patchCoach(u, { judge: { enabled: null } });
    expect(u.agents).toEqual({ coach: { enabled: true } });
    patchCoach(u, { enabled: null });
    expect(u.agents).toBeUndefined();
  });

  it("refuses a bad value or a key Settings doesn't set, and changes nothing", () => {
    for (const bad of [
      "on",
      [],
      { enabled: "yes" },
      { window_days: 0 },
      { window_days: 91 },
      { window_days: 1.5 },
      { judge: { enabled: "on" } },
      { judge: "on" },
      { judge: { budget_tokens: 1 } },
      { keep_runs: 5 },
      { findings: { polls_per_day: 1 } },
    ]) {
      const u: UserConfig = {};
      const r = patchCoach(u, bad);
      expect(r.ok).toBe(false);
      expect(u).toEqual({});
    }
  });
});

describe("user.yml's values count", () => {
  it("enabled and window_days over the distribution's", () => {
    const c = readAgentsConfig(dist({ enabled: false, window_days: 7 }), {
      agents: { coach: { enabled: true, window_days: 30 } },
    } as UserConfig).coach!;
    expect(c.enabled).toBe(true);
    expect(c.window_days).toBe(30);
  });

  it("unset in user.yml: the distribution's stand", () => {
    const c = readAgentsConfig(
      dist({ enabled: true, window_days: 3 }),
      {},
    ).coach!;
    expect(c.enabled).toBe(true);
    expect(c.window_days).toBe(3);
  });

  it("a bad user.yml value is refused, naming the key", () => {
    expect(() =>
      readAgentsConfig(dist({}), {
        agents: { coach: { window_days: 0 } },
      } as UserConfig),
    ).toThrow(/agents\.coach\.window_days/);
    expect(() =>
      readAgentsConfig(dist({}), {
        agents: { coach: { enabled: "yes" } },
      } as UserConfig),
    ).toThrow(/agents\.coach\.enabled/);
  });
});

describe("an agent can't write them", () => {
  it("POST /api/settings is a person's write", () => {
    expect(AGENT_PERSON_WRITES).toContain("/api/settings");
  });
});
