/**
 * Issue 974: secret-looking environment variables are held out of agent
 * sessions.
 *
 * Two places an agent could see one:
 *   1. The session's own environment. It already starts from an allowlist
 *      (sessions/env.ts); the hold is applied to what comes from the
 *      caller on top of it (the allowlist, the runtime's passthrough).
 *      Every runtime gets this layer.
 *   2. Each shell command it runs. The shell reads the person's profile
 *      first (zsh reads ~/.zshenv for every shell), which can set a token
 *      again. So Den writes a small script (`env-hold.sh` in the agent's
 *      files folder, rewritten at each start) that the runtime runs before
 *      each command. Only den-claude runs it (CLAUDE_ENV_FILE). It unsets
 *      every variable, exported or not, whose name matches, except the
 *      names the agent is allowed and the exact names Den set for this
 *      launch. A person's credential (DEN_PERSON_TOKEN, a person token, a
 *      path to web.secret) is unset first, whatever else is kept.
 *
 * The rule a name is matched by (case is ignored):
 *   - a pattern is a name with `*` wildcards: `*_TOKEN` matches GH_TOKEN;
 *   - a name may also end in `_` and a digit and anything after it:
 *     `*_KEY` matches AWS_KEY_2.
 *
 * Settings, in config/local (never a repo, which an agent can edit):
 *   user.yml agents.env_hold:         the patterns (unset: DEFAULT_ENV_HOLD;
 *                                     [] holds nothing back, said plainly by
 *                                     doctor)
 *   user.yml agents.env_allow:        names every agent here keeps
 *   user.yml agents.env_allow_agents: { <agent id>: [NAME] } names one
 *                                     agent keeps
 *   workspaces.yml <project>.agents.env_allow: names a project's agents keep
 *   user.yml agents.env_guard:        false stops refusing commands that
 *                                     print the whole environment
 *   user.yml agents.env_hold_existing: true holds them back for agents
 *                                     started before the hold too (the
 *                                     held write den_env_hold_on sets it)
 * The three allow levels add up.
 *
 * The rollout: an agent started new has the hold. An agent from before it
 * keeps its environment as it was until a person turns the hold on for
 * those agents (env-hold-rollout.ts).
 *
 * Nothing here returns a variable's value: names only.
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

/** Names unset in the shell before anything is kept: a person's credential. */
export const PERSON_CREDENTIAL_NAMES: readonly string[] = [
  "DEN_PERSON_TOKEN",
  "DEN_TEST_PERSON",
];

/**
 * Names held whenever the list isn't empty, the exact names Den set aside:
 * git reads its config from GIT_CONFIG_COUNT/KEY_n/VALUE_n, and a value can
 * carry a credential (an http.extraheader).
 */
export const ALWAYS_HELD_PREFIXES: readonly string[] = ["GIT_CONFIG_"];

/** Values that make a variable a person's credential, whatever its name. */
const PERSON_VALUE_GLOBS = ["*den_pt_*", "*web.secret*"];

/** The file the agent's shell runs before each command. */
export const ENV_HOLD_FILE = "env-hold.sh";

const PATTERN_RE = /^[A-Za-z0-9_*]+$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvHoldSettings {
  /** The patterns, as configured (or the default). */
  hold: string[];
  /** Whether agents.env_hold was set (false: the default list). */
  holdSet: boolean;
  /** agents.env_allow: names every agent keeps. */
  allowAll: string[];
  /** agents.env_allow_agents: names each agent keeps, by agent id. */
  allow: Record<string, string[]>;
  /** agents.env_guard (default true). */
  guard: boolean;
  /** agents.env_hold_existing: the hold for agents from before it too. */
  holdExisting: boolean;
}

/** The settings when nothing is configured. */
export function defaultEnvHold(): EnvHoldSettings {
  return {
    hold: [...DEFAULT_ENV_HOLD],
    holdSet: false,
    allowAll: [],
    allow: {},
    guard: true,
    holdExisting: false,
  };
}

function names(key: string, v: unknown): string[] {
  if (!Array.isArray(v))
    throw new Error(
      `${key}: must be a list of variable names (got ${JSON.stringify(v)})`,
    );
  for (const n of v)
    if (typeof n !== "string" || !NAME_RE.test(n))
      throw new Error(
        `${key}: "${String(n)}" is not a variable name (one exact name each)`,
      );
  return [...new Set(v as string[])];
}

/** A project's names (workspaces.yml <project>.agents.env_allow), checked. */
export function checkProjectEnvAllow(project: string, v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return names(`workspaces.${project}.agents.env_allow`, v);
}

/** user.yml's agents.env_* checked; a bad one throws naming it. */
export function checkEnvHoldConfig(raw: {
  env_hold?: unknown;
  env_allow?: unknown;
  env_allow_agents?: unknown;
  env_guard?: unknown;
  env_hold_existing?: unknown;
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
  if (raw.env_allow !== undefined && raw.env_allow !== null)
    out.allowAll = names("agents.env_allow", raw.env_allow);
  const a = raw.env_allow_agents;
  if (a !== undefined && a !== null) {
    if (typeof a !== "object" || Array.isArray(a))
      throw new Error(
        `agents.env_allow_agents: must be a mapping of agent id to a list of variable names (got ${JSON.stringify(a)})`,
      );
    for (const [id, list] of Object.entries(a))
      out.allow[id] = names(`agents.env_allow_agents.${id}`, list);
  }
  for (const k of ["env_guard", "env_hold_existing"] as const) {
    const g = raw[k];
    if (g === undefined || g === null) continue;
    if (typeof g !== "boolean")
      throw new Error(`agents.${k}: true or false (got ${JSON.stringify(g)})`);
    if (k === "env_guard") out.guard = g;
    else out.holdExisting = g;
  }
  return out;
}

/** The names agent `id` keeps: install, its project's and its own, added up. */
export function allowedFor(
  s: EnvHoldSettings,
  id: string,
  project: readonly string[] = [],
): string[] {
  return [...new Set([...s.allowAll, ...project, ...(s.allow[id] ?? [])])];
}

function globRegex(p: string): RegExp {
  const body = p
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}(?:_[0-9].*)?$`, "i");
}

/** Whether `name` matches one of `patterns`, by the rule in the header. */
export function matchesHold(
  name: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((p) => globRegex(p).test(name));
}

/**
 * What the hold does to a set of names: held back, and let through by an
 * allow. `own` are the exact names Den set for this launch (never held).
 */
export function holdOutcome(
  list: Iterable<string>,
  hold: readonly string[],
  allow: readonly string[] = [],
  own: readonly string[] = [],
): { held: string[]; allowed: string[] } {
  const held = new Set<string>();
  const allowed = new Set<string>();
  for (const n of list) {
    if (PERSON_CREDENTIAL_NAMES.includes(n)) {
      held.add(n);
      continue;
    }
    if (own.includes(n)) continue;
    const prefixed =
      hold.length > 0 && ALWAYS_HELD_PREFIXES.some((p) => n.startsWith(p));
    if (!prefixed && !matchesHold(n, hold)) continue;
    if (allow.includes(n)) allowed.add(n);
    else held.add(n);
  }
  return { held: [...held].sort(), allowed: [...allowed].sort() };
}

/** `env` less the names the hold takes (allowed names stay). */
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
 * The script the agent's shell runs before each command (sh, bash and zsh
 * alike). It walks the shell's own variable names (zsh: its parameters;
 * bash: compgen -v; sh: set), so a profile's variable is found exported or
 * not. A person's credential is unset first; then every name the patterns
 * match, the allowed names and Den's own exact names (`own`) aside.
 * Patterns and names are checked (checkEnvHoldConfig), so nothing here
 * can run as code.
 */
export function envHoldScript(
  hold: readonly string[],
  allow: readonly string[] = [],
  own: readonly string[] = [],
): string {
  const head = [
    "# Written by Den at each start of this agent. Before each shell command,",
    "# variables whose names look like secrets are unset (agents.env_hold in",
    "# config/local/user.yml). If this agent needs one, a person adds its name",
    "# to agents.env_allow (every agent), agents.env_allow_agents.<id> (this",
    "# agent) or the project's agents.env_allow in config/local/workspaces.yml.",
  ];
  const patterns = hold.filter((p) => PATTERN_RE.test(p) && /[^*]/.test(p));
  const keep = [...own, ...allow].filter(
    (n) => NAME_RE.test(n) && !PERSON_CREDENTIAL_NAMES.includes(n),
  );
  const take = patterns.length
    ? [
        ...ALWAYS_HELD_PREFIXES.map((p) => `${p}*`),
        ...patterns.flatMap((p) => [shellGlob(p), `${shellGlob(p)}_[0-9]*`]),
      ]
    : [];
  const caseArms = [
    `    ${PERSON_CREDENTIAL_NAMES.join("|")}) unset "$__den_n" 2>/dev/null; continue ;;`,
  ];
  const lines = [
    ...head,
    ...(patterns.length
      ? []
      : ["# The list is empty: only a person's credential is unset."]),
    "__den_names() {",
    "  if [ -n \"${ZSH_VERSION:-}\" ]; then eval 'print -rl -- ${(k)parameters}'",
    '  elif [ -n "${BASH_VERSION:-}" ]; then compgen -v',
    // sh (dash): `set` lists unexported variables too, unlike `env`.
    "  else set | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'",
    "  fi",
    "}",
    "for __den_n in $(__den_names); do",
    '  case "$__den_n" in',
    "    *[!A-Za-z0-9_]*|__den_*) continue ;;",
    ...caseArms,
    "  esac",
    '  eval "__den_v=\\${$__den_n-}"',
    '  case "$__den_v" in',
    `    ${PERSON_VALUE_GLOBS.join("|")}) unset "$__den_n" 2>/dev/null; continue ;;`,
    "  esac",
    ...(take.length
      ? [
          '  case "$__den_n" in',
          ...(keep.length ? [`    ${keep.join("|")}) ;;`] : []),
          `    ${take.join("|")}) unset "$__den_n" 2>/dev/null ;;`,
          "  esac",
        ]
      : []),
    "done",
    "unset __den_n __den_v",
    "unset -f __den_names 2>/dev/null",
    "",
  ];
  return lines.join("\n");
}
