export const DEFAULT_ENV_HOLD: readonly string[] = [
  "*_TOKEN",
  "*_SECRET",
  "*_KEY",
  "*_PASSWORD",
  "OP_SESSION_*",
];

export const PERSON_CREDENTIAL_NAMES: readonly string[] = [
  "DEN_PERSON_TOKEN",
  "DEN_TEST_PERSON",
];

export const ALWAYS_HELD_PREFIXES: readonly string[] = ["GIT_CONFIG_"];

export const PERSON_VALUE_GLOBS: readonly string[] = [
  "*den_pt_*",
  "*web.secret*",
];

export function envMaskArgs(s: EnvHoldSettings): string[] {
  const names = [
    ...(s.holdSet ? s.hold : DEFAULT_ENV_HOLD),
    ...PERSON_CREDENTIAL_NAMES,
  ].filter((p) => PATTERN_RE.test(p) && /[^*]/.test(p));
  return [
    "--env-mask",
    [...new Set(names)].join(","),
    "--env-mask-values",
    PERSON_VALUE_GLOBS.join(","),
  ];
}

export const ENV_HOLD_FILE = "env-hold.sh";

const PATTERN_RE = /^[A-Za-z0-9_*]+$/;
const GIT_ENV_RE = /^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)$/;

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvHoldSettings {
  hold: string[];
  holdSet: boolean;
  allowAll: string[];
  allow: Record<string, string[]>;
  guard: boolean;
  holdExisting: boolean;
}

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

export function checkProjectEnvAllow(project: string, v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return names(`workspaces.${project}.agents.env_allow`, v);
}

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

export function matchesHold(
  name: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((p) => globRegex(p).test(name));
}

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

function shellGlob(p: string): string {
  return [...p]
    .map((ch) =>
      /[A-Za-z]/.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : ch,
    )
    .join("");
}

export function envHoldScript(
  hold: readonly string[],
  allow: readonly string[] = [],
  own: readonly string[] = [],
  git: Readonly<Record<string, string>> = {},
): string {
  const head = [
    "# Written by Den at each start of this agent. Before each shell command,",
    "# variables whose names look like secrets are unset (agents.env_hold in",
    "# config/local/user.yml). If this agent needs one, a person adds its name",
    "# to agents.env_allow (every agent), agents.env_allow_agents.<id> (this",
    "# agent) or the project's agents.env_allow in config/local/workspaces.yml.",
  ];
  const patterns = hold.filter((p) => PATTERN_RE.test(p) && /[^*]/.test(p));
  const gitPairs = Object.entries(git).filter(
    ([k, v]) => GIT_ENV_RE.test(k) && typeof v === "string",
  );
  const resetGit = patterns.length > 0 || gitPairs.length > 0;
  const keep = [...own, ...allow].filter(
    (n) =>
      NAME_RE.test(n) &&
      !PERSON_CREDENTIAL_NAMES.includes(n) &&
      !(resetGit && n.startsWith("GIT_CONFIG_")),
  );
  const take = patterns.length
    ? [
        ...ALWAYS_HELD_PREFIXES.map((p) => `${p}*`),
        ...patterns.flatMap((p) => [shellGlob(p), `${shellGlob(p)}_[0-9]*`]),
      ]
    : [];
  const caseArms = [
    `    ${PERSON_CREDENTIAL_NAMES.join("|")}) unset "$__den_n" 2>/dev/null; continue ;;`,
    ...(resetGit
      ? ['    GIT_CONFIG_*) unset "$__den_n" 2>/dev/null; continue ;;']
      : []),
  ];
  const lines = [
    ...head,
    ...(patterns.length
      ? []
      : ["# The list is empty: only a person's credential is unset."]),
    "__den_names() {",
    "  if [ -n \"${ZSH_VERSION:-}\" ]; then eval 'print -rl -- ${(k)parameters}'",
    '  elif [ -n "${BASH_VERSION:-}" ]; then compgen -v',
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
    ...gitPairs.map(([k, v]) => `export ${k}=${shellQuote(v)}`),
    "unset __den_n __den_v",
    "unset -f __den_names 2>/dev/null",
    "",
  ];
  return lines.join("\n");
}
