/**
 * Issue 974: secret-looking environment variables are held out of agent
 * sessions.
 *
 * Two places an agent could see one:
 *   1. The session's own environment. It already starts from an allowlist
 *      (sessions/env.ts); the hold is applied to what comes from the
 *      caller on top of it (the allowlist, the runtime's passthrough).
 *   2. Each shell command it runs. The shell reads the person's profile
 *      first (zsh reads ~/.zshenv for every shell), which can set a token
 *      again. So Den writes a small script (`env-hold.sh` in the agent's
 *      files folder) that the runtime runs before each command
 *      (den-claude: CLAUDE_ENV_FILE). It unsets every variable whose name
 *      matches, except the names the agent is opted in to and Den's own.
 *
 * The rule a name is matched by (case is ignored):
 *   - a pattern is a name with `*` wildcards: `*_TOKEN` matches GH_TOKEN;
 *   - a name may also end in `_` and a digit and anything after it:
 *     `*_KEY` matches AWS_KEY_2.
 *
 * Settings, in the install's den.yml (never the project's repo, which an
 * agent can edit):
 *   agents.env_hold:  the patterns (unset: DEFAULT_ENV_HOLD; [] holds
 *                     nothing back, said plainly by doctor)
 *   agents.env_allow: { <agent id>: [NAME, ...] } exact names that agent
 *                     keeps
 *   agents.env_guard: false turns off the refusal of commands that print
 *                     the whole environment (guardrails/pretooluse.mjs)
 *
 * Nothing here reads or returns a variable's value: names only.
 */

/** agents.env_hold when unset. */
export const DEFAULT_ENV_HOLD: readonly string[] = [
  "*_TOKEN",
  "*_SECRET",
  "*_KEY",
  "*_PASSWORD",
  // The password manager CLI's session variables (OP_SESSION_<account>).
  "OP_SESSION_*",
];

/**
 * Den's own variables: never held back, whatever the patterns say (the
 * actor token file, Den's markers, the git signing settings Den declares).
 */
export const DEN_OWN_ENV: readonly string[] = ["DEN_*", "GIT_CONFIG_*"];

/** The file the agent's shell runs before each command. */
export const ENV_HOLD_FILE = "env-hold.sh";

const PATTERN_RE = /^[A-Za-z0-9_*]+$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvHoldSettings {
  /** The patterns, as configured (or the default). */
  hold: string[];
  /** Whether agents.env_hold was set (false: the default list). */
  holdSet: boolean;
  /** agents.env_allow: exact names each agent keeps, by agent id. */
  allow: Record<string, string[]>;
  /** agents.env_guard (default true). */
  guard: boolean;
}

/** The settings when nothing is configured. */
export function defaultEnvHold(): EnvHoldSettings {
  return {
    hold: [...DEFAULT_ENV_HOLD],
    holdSet: false,
    allow: {},
    guard: true,
  };
}

/** agents.env_hold, env_allow, env_guard checked; a bad one throws naming it. */
export function checkEnvHoldConfig(raw: {
  env_hold?: unknown;
  env_allow?: unknown;
  env_guard?: unknown;
}): EnvHoldSettings {
  const out = defaultEnvHold();
  const h = raw.env_hold;
  if (h !== undefined && h !== null) {
    if (!Array.isArray(h))
      throw new Error(
        `agents.env_hold: must be a list of name patterns such as "*_TOKEN" ([] holds nothing back) (got ${JSON.stringify(h)})`,
      );
    for (const p of h)
      if (typeof p !== "string" || !PATTERN_RE.test(p) || !/[^*]/.test(p))
        throw new Error(
          `agents.env_hold: "${String(p)}" is not a name pattern (letters, digits, _ and *, and not * alone)`,
        );
    out.hold = [...new Set(h as string[])];
    out.holdSet = true;
  }
  const a = raw.env_allow;
  if (a !== undefined && a !== null) {
    if (typeof a !== "object" || Array.isArray(a))
      throw new Error(
        `agents.env_allow: must be a mapping of agent id to a list of variable names (got ${JSON.stringify(a)})`,
      );
    for (const [id, names] of Object.entries(a)) {
      if (!Array.isArray(names))
        throw new Error(
          `agents.env_allow.${id}: must be a list of variable names (got ${JSON.stringify(names)})`,
        );
      for (const n of names)
        if (typeof n !== "string" || !NAME_RE.test(n))
          throw new Error(
            `agents.env_allow.${id}: "${String(n)}" is not a variable name (one exact name each)`,
          );
      out.allow[id] = [...new Set(names as string[])];
    }
  }
  const g = raw.env_guard;
  if (g !== undefined && g !== null) {
    if (typeof g !== "boolean")
      throw new Error(
        `agents.env_guard: true or false (got ${JSON.stringify(g)})`,
      );
    out.guard = g;
  }
  return out;
}

function globRegex(p: string, digits: boolean): RegExp {
  const body = p
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${digits ? "(?:_[0-9].*)?" : ""}$`, "i");
}

/** Whether `name` matches one of `patterns`, by the rule in the header. */
export function matchesHold(
  name: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((p) => globRegex(p, true).test(name));
}

/** Whether `name` is one of Den's own variables (never held). */
export function isDenOwnEnv(name: string): boolean {
  return DEN_OWN_ENV.some((p) => globRegex(p, false).test(name));
}

/** What the hold does to a set of names: held back, and let through by an opt-in. */
export function holdOutcome(
  names: Iterable<string>,
  hold: readonly string[],
  allow: readonly string[] = [],
): { held: string[]; allowed: string[] } {
  const held = new Set<string>();
  const allowed = new Set<string>();
  for (const n of names) {
    if (isDenOwnEnv(n) || !matchesHold(n, hold)) continue;
    if (allow.includes(n)) allowed.add(n);
    else held.add(n);
  }
  return { held: [...held].sort(), allowed: [...allowed].sort() };
}

/** `env` less the names the hold takes (Den's own and opted-in names stay). */
export function applyEnvHold(
  env: Record<string, string>,
  hold: readonly string[],
  allow: readonly string[] = [],
): Record<string, string> {
  const { held } = holdOutcome(Object.keys(env), hold, allow);
  const out = { ...env };
  for (const n of held) delete out[n];
  return out;
}

/** A pattern as a case-insensitive shell glob: `*_key` → `*_[Kk][Ee][Yy]`. */
function shellGlob(p: string): string {
  return [...p]
    .map((ch) =>
      /[A-Za-z]/.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : ch,
    )
    .join("");
}

/**
 * The script the agent's shell runs before each command (sh, bash and
 * zsh alike): it unsets every exported variable whose name matches, Den's
 * own and the opted-in names aside. The names come from `env`, so a
 * variable the profile set again is found as well. Patterns and names are
 * checked (checkEnvHoldConfig), so nothing here can run as code.
 */
export function envHoldScript(
  hold: readonly string[],
  allow: readonly string[] = [],
): string {
  const head = [
    "# Written by Den at the agent's start. Before each shell command, the",
    "# variables whose names look like secrets are unset (agents.env_hold in",
    "# den.yml; agents.env_allow lets an agent keep one by name).",
  ];
  const patterns = hold.filter((p) => PATTERN_RE.test(p) && /[^*]/.test(p));
  if (!patterns.length)
    return [...head, "# The list is empty: nothing is held back.", ""].join(
      "\n",
    );
  const keep = [...DEN_OWN_ENV, ...allow.filter((n) => NAME_RE.test(n))].join(
    "|",
  );
  const take = patterns
    .flatMap((p) => [shellGlob(p), `${shellGlob(p)}_[0-9]*`])
    .join("|");
  return [
    ...head,
    "for __den_n in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'); do",
    '  case "$__den_n" in',
    `    ${keep}) ;;`,
    `    ${take}) unset "$__den_n" 2>/dev/null ;;`,
    "  esac",
    "done",
    "unset __den_n",
    "",
  ].join("\n");
}
