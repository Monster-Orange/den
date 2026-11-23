/**
 * Issue 52: the Coach's Settings rows (Settings › Agents): Coach on or off,
 * its window in days, and judging. GET /api/settings serves them as
 * `coach`; POST /api/settings takes `coach` and writes it to
 * config/local/user.yml's agents.coach, nowhere else. The route is a
 * person's write (request-guard.ts AGENT_PERSON_WRITES), so an agent's
 * token can't switch judging on. readAgentsConfig reads these from
 * user.yml over the distribution's (den-config.ts).
 *
 * Only these three: keep_runs, the findings' thresholds and judging's
 * budgets and model stay in the distribution's config.
 */
import type { UserConfig } from "../../shared/den-config.js";
import type { CoachSettings } from "../../shared/coach/settings.js";

export interface CoachPrefs {
  enabled: boolean;
  window_days: number;
  judge: { enabled: boolean };
}

/** What the rows show: the Coach's effective settings. */
export function coachPrefs(c: CoachSettings): CoachPrefs {
  return {
    enabled: c.enabled,
    window_days: c.window_days,
    judge: { enabled: c.judge.enabled },
  };
}

type Result = { ok: true } | { ok: false; error: string };

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One POSTed value: null clears it; else it must pass `ok`. */
function checkOne(
  key: string,
  v: unknown,
  ok: (v: unknown) => boolean,
  what: string,
): string | null {
  if (v === undefined || v === null || ok(v)) return null;
  return `coach.${key} must be ${what}, or null (got ${JSON.stringify(v)})`;
}

const isBool = (v: unknown) => typeof v === "boolean";
const isDays = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 90;

/** Apply a POSTed `coach` to `user` (in place). Nothing changes on a refusal. */
export function patchCoach(user: UserConfig, body: unknown): Result {
  if (!isMap(body))
    return {
      ok: false,
      error: "coach must be a map of enabled, window_days and judge",
    };
  for (const k of Object.keys(body))
    if (!["enabled", "window_days", "judge"].includes(k))
      return {
        ok: false,
        error: `coach.${k} isn't set from Settings (only enabled, window_days and judge.enabled)`,
      };
  const judge = body.judge;
  if (judge !== undefined && !isMap(judge))
    return { ok: false, error: "coach.judge must be a map of enabled" };
  if (judge)
    for (const k of Object.keys(judge))
      if (k !== "enabled")
        return {
          ok: false,
          error: `coach.judge.${k} isn't set from Settings (only judge.enabled)`,
        };
  const bad =
    checkOne("enabled", body.enabled, isBool, "true or false") ??
    checkOne("window_days", body.window_days, isDays, "a whole number, 1–90") ??
    checkOne("judge.enabled", judge?.enabled, isBool, "true or false");
  if (bad) return { ok: false, error: bad };

  const agents = { ...(user.agents ?? {}) } as Record<string, unknown>;
  const coach = isMap(agents.coach) ? { ...agents.coach } : {};
  const set = (o: Record<string, unknown>, k: string, v: unknown) => {
    if (v === null) delete o[k];
    else if (v !== undefined) o[k] = v;
  };
  set(coach, "enabled", body.enabled);
  set(coach, "window_days", body.window_days);
  if (judge) {
    const j = isMap(coach.judge) ? { ...coach.judge } : {};
    set(j, "enabled", judge.enabled);
    if (Object.keys(j).length) coach.judge = j;
    else delete coach.judge;
  }
  if (Object.keys(coach).length) agents.coach = coach;
  else delete agents.coach;
  if (Object.keys(agents).length) user.agents = agents as UserConfig["agents"];
  else delete user.agents;
  return { ok: true };
}
