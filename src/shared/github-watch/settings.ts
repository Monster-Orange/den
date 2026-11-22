/**
 * The shared GitHub watcher's Settings, in user.yml `github:` (a person's
 * only: PERSON_ONLY_SETTINGS "github"):
 *
 *   watch_interval_seconds       how often it looks at first (default 60);
 *                                doubled while nothing changes
 *   watch_max_interval_seconds   the most it waits between looks (300)
 *   api_budget_floor             below this many GitHub calls left this
 *                                hour, Den asks GitHub nothing and refuses
 *                                new watches until the reset (500)
 *   watches_max                  watches at once, across the install (50)
 *
 * A value that is missing or out of range is its default.
 */
export interface GithubWatchSettings {
  intervalSeconds: number;
  maxIntervalSeconds: number;
  budgetFloor: number;
  watchesMax: number;
}

/** Each key's range and default (Settings and `config` check against these). */
export const GITHUB_WATCH_LIMITS = {
  watch_interval_seconds: { min: 10, max: 3600, def: 60 },
  watch_max_interval_seconds: { min: 10, max: 86_400, def: 300 },
  api_budget_floor: { min: 0, max: 100_000, def: 500 },
  watches_max: { min: 1, max: 1000, def: 50 },
} as const;

type Key = keyof typeof GITHUB_WATCH_LIMITS;

function num(block: Record<string, unknown>, k: Key): number {
  const l = GITHUB_WATCH_LIMITS[k];
  const v = block[k];
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= l.min &&
    v <= l.max
    ? v
    : l.def;
}

/** The settings from a user.yml (its parsed object). */
export function githubWatchSettings(user: unknown): GithubWatchSettings {
  const u = user && typeof user === "object" ? user : {};
  const g = (u as { github?: unknown }).github;
  const block =
    g && typeof g === "object" && !Array.isArray(g)
      ? (g as Record<string, unknown>)
      : {};
  const intervalSeconds = num(block, "watch_interval_seconds");
  return {
    intervalSeconds,
    maxIntervalSeconds: Math.max(
      intervalSeconds,
      num(block, "watch_max_interval_seconds"),
    ),
    budgetFloor: num(block, "api_budget_floor"),
    watchesMax: num(block, "watches_max"),
  };
}
