/**
 * Den deployment configuration reader.
 *
 * Two-layer config system:
 *   config/den.yml       — committed, shared deployment config
 *   config/local/user.yml   — gitignored, per-engineer overrides
 *
 * The user file can toggle local_dev on/off without touching the shared config.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import type { Environment, ReleaseSourceConfig } from "./types/index.js";
import { getDistRoot } from "./paths.js";
import type { SecretsConfig } from "./secrets/index.js";
import type { OrgConfig } from "./org.js";
import type { TestAccountsConfig } from "./auth/test-accounts.js";

import { product } from "./product.js";
const ROOT = getDistRoot();
const DEN_CONFIG_PATH = path.join(ROOT, product().configFile);
const USER_CONFIG_PATH = path.join(ROOT, "config", "local", "user.yml");

/**
 * Configuration for the derived dependency graph (`den graph` / derived
 * `den up`). Lets the team tune discovery centrally without touching the
 * target repos. Both fields merge over the built-in defaults in
 * environment-manager/derivation/alias.ts.
 */
export interface GraphConfig {
  /**
   * Canonical repo-system name → alias tokens that appear in env-var URLs, SDK
   * package names, and EventBridge `source` values. The keys also define the
   * universe of known repo-systems for the graph.
   * e.g. shop: [shop-api, shop-backend, backend, shop.backend]
   */
  aliases?: Record<string, string[]>;
  /**
   * A shared local-infra repo (databases, cloud emulators, …) that backends
   * must wait for. Optional: with none set, no infra edges are derived. Any
   * `signals` regex found in a repo's manifest, stack.yml, Makefile or env
   * files means "this repo uses it"; a bare mention of the repo name is a
   * weaker signal.
   */
  infra?: { repo: string; signals?: string[] };
  /** GitHub orgs whose Go modules (`github.com/<org>/<repo>`) count as SDK imports. */
  sdk_orgs?: string[];
  /** npm scopes (`@scope/<repo>-sdk`) whose packages count as SDK imports. */
  npm_scopes?: string[];
  /**
   * Per-edge overrides keyed "from->to":
   *   hard   — functional-hard; gates startup (waited on). Injected if discovery missed it.
   *   soft   — started, not gated.
   *   ignore — keep in the graph + start set, but exclude from start ORDER
   *            (for tolerant edges discovery can't classify, e.g. a redirect URL).
   * e.g. "files-api->links-api": hard ; "billing-api->shop-web": ignore
   */
  edges?: Record<string, "hard" | "soft" | "ignore">;
}

export interface ApplicationConfig {
  title?: string;
  description?: string;
  /** Who builds it (a team, vendor or person). */
  owner?: string;
  repos?: string[];
}

/**
 * A single deployable repo in the release graph: which CD workflow to dispatch,
 * which wave it belongs to (lower waves deploy first and gate later waves), and
 * the ref it deploys by default.
 */
export interface ReleaseRepo {
  /** Repo-system name (matches the graph node / catalog key). */
  name: string;
  /** GitHub Actions workflow file to dispatch (e.g. "cd.yml", "fullstack-cd.yml"). */
  workflow: string;
  /**
   * Wave index — every repo in wave N dispatches together (staggered); wave N+1
   * is gated on wave N concluding success. Ports release-all.sh's backend→app
   * wave model, generalised to any number of waves.
   */
  wave: number;
  /** Default ref to deploy (default "main"). */
  ref?: string;
  /** Participate in "Deploy all" by default (default true). */
  enabled?: boolean;
  /** Full GitHub slug when the repo is not in `org` ("Initech/initech-web"). */
  gh?: string;
  /** Per Den environment, where the deployed commit is read (manifest `release:`). */
  sources?: Partial<Record<string, ReleaseSourceConfig>>;
  /** Named entry in `release.profiles` giving this repo's per-env targets. */
  profile?: string;
  /** Per-environment overrides, merged over the profile's. */
  targets?: Record<string, ReleaseTarget>;
}

/**
 * How one den environment maps onto a repo's real CD. Every field is
 * optional; the defaults are the den env name, the repo's `workflow`,
 * and the repo's `ref` (or main).
 */
export interface ReleaseTarget {
  /** GitHub Environment(s) the CD records deployments under. Several (one per tenant) give one row each. */
  environment?: string | string[];
  /** Workflow file(s) whose deployments count. The first is the one dispatched. */
  workflow?: string | string[];
  /** Branch this environment ships from (what "behind" is measured against). */
  branch?: string;
  /** workflow_dispatch inputs. Unset: `environment=<env>`, as before targets existed. */
  inputs?: Record<string, string>;
}

/** A target with its defaults filled in. */
export interface ResolvedReleaseTarget {
  environments: string[];
  workflows: string[];
  branch: string;
  inputs: Record<string, string>;
}

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** Resolve repo × env to the GitHub environments, workflows and branch to check. */
export function resolveReleaseTarget(
  repo: ReleaseRepo,
  env: string,
  cfg: Pick<ReleaseConfig, "profiles">,
): ResolvedReleaseTarget {
  const fromProfile = repo.profile
    ? cfg.profiles?.[repo.profile]?.[env]
    : undefined;
  const t: ReleaseTarget = { ...fromProfile, ...repo.targets?.[env] };
  const environments = asList(t.environment);
  const workflows = asList(t.workflow);
  return {
    environments: environments.length ? environments : [env],
    workflows: workflows.length ? workflows : [repo.workflow],
    branch: t.branch ?? repo.ref ?? "main",
    inputs:
      t.inputs ??
      (fromProfile || repo.targets?.[env] ? {} : { environment: env }),
  };
}

/**
 * Release/deploy configuration for the web Release tab. Ports the wave model of
 * infra-scripts/release-all.sh into den, made editable via the UX. Layered:
 * committed config/den.yml `release:` is the team base, config/local/user.yml
 * `release:` is a personal override (see readReleaseConfig).
 */
export interface ReleaseConfig {
  /**
   * Allow dispatching deploys from den. Off unless the team config
   * (config/den.yml) sets `deploy: true`; user.yml and the web page can't
   * turn it on. Off, the Release page is read-only and deploys are refused.
   */
  deploy: boolean;
  /** GitHub org owning the repos. Falls back to `github_org` when omitted. */
  org?: string;
  /** Deployable GitHub environments, in display order (e.g. dev/sandbox/staging/prod). */
  environments: string[];
  /** Seconds to wait between dispatches within a wave (release-all.sh default: 20). */
  staggerSeconds: number;
  /** Seconds between monitor polls while waiting on runs (release-all.sh default: 15). */
  pollSeconds: number;
  /** Deployable repos and their wave assignment. */
  repos: ReleaseRepo[];
  /** Shared per-env targets, by name; a repo opts in with `profile:`. */
  profiles?: Record<string, Record<string, ReleaseTarget>>;
}

export interface DenConfig {
  /** Secrets backend strategy — see src/shared/secrets. */
  secrets?: SecretsConfig;
  /** Environments enabled for this deployment. */
  environments: Environment[];
  /**
   * The environments that count as production (default: prod, production).
   * Production is an attribute of an env, never a name check: Den refuses to
   * start, stop, scan or exec a remote service whose target env is listed.
   */
  production_envs?: string[];
  /**
   * Root directory for local repo discovery, relative to the den directory.
   * Defaults to ".." (the parent of den), which covers the common layout where
   * den and all managed repos are siblings under a shared project root.
   */
  repos_root?: string;
  /** GitHub org slug used to list org repos in the web UI (e.g. "Globex-Corp"). */
  github_org?: string;
  /**
   * Display names (and an optional colour) for the GitHub orgs repos belong
   * to, keyed by GitHub owner. Orgs are worked out from the catalog; this
   * only names them.
   */
  orgs?: Record<string, { label?: string; color?: string }>;
  /** Derived-dependency-graph tuning (aliases + edge overrides). */
  graph?: GraphConfig;
  /**
   * The org this instance serves (Org > Application > Repo > Services).
   * `id` defaults to `edge.org`, `title` to the id. See src/shared/org.ts.
   */
  org?: OrgConfig;
  /**
   * Applications: named sets of repos that ship together. A repo can also
   * name its application in its own `.den.yml` (`application:`). A repo
   * in no application is its own, named after the repo.
   */
  applications?: Record<string, ApplicationConfig>;
  /** Release/deploy configuration for the web Release tab (team base). */
  release?: ReleaseConfig;
  /**
   * Extra environment variables injected into every service command (up/down/
   * restart/setup), so consumer repos receive den-resolved locations
   * regardless of where their checkout lives. Values are templates; the only
   * placeholder today is `{repo:<name>}` → the absolute path den resolves
   * `<name>` to. A value already set in the caller's environment is never
   * overridden; an empty string disables a built-in default. See `service-env.ts`.
   */
  service_env?: Record<string, string>;
  /**
   * Non-local health-URL templates `den init` scaffolds per environment,
   * with `{repo}` substituted (e.g. dev: "https://{repo}.internal.dev.example.dev/
   * healthz", production: "https://{repo}.internal.example.dev/healthz"). These
   * feed the TEST scope — smoke/perf base-URL resolution reads the manifest's
   * `health.<env>.url`. Defaults only: hand-edited URLs in an existing manifest
   * are preserved on re-init.
   */
  env_health_urls?: Record<string, string>;
  /** Security pillar (OWASP ZAP) policy — see readSecurityOwnedHosts. */
  security?: SecurityConfig;
  /**
   * The MCP server (`<cli> mcp`). Without this block agents get read tools
   * only; `actions` opts in to named actions. See readMcpConfig.
   */
  mcp?: McpConfig;
  /**
   * The web UI: `port` (read by edge/config.ts readWebPort) and `service`,
   * the launchd service `<cli> service` installs. See readWebServiceConfig.
   */
  web?: WebConfig;
  /**
   * Shared test accounts (email + secrets-backend item per role) the test
   * pillars log in as — see src/shared/auth/test-accounts.ts.
   */
  test_accounts?: TestAccountsConfig;
  /**
   * Out-of-the-box default workspace blueprint. On a fresh clone, den offers
   * to seed the `default` workspace with these repos, all managed. See
   * `default-workspace.ts`.
   */
  defaults?: {
    workspace?: WorkspaceBlueprint & {
      /** The entry repo the seed's dependency walk starts from (listed first). */
      entry?: string;
    };
    /**
     * Multi-workspace blueprint: `{ <name>: { repos, focus?, branch?,
     * autostart_off? } }`. On a genuine fresh setup each workspace is created
     * with its repos (managed), all are activated, and the one marked
     * `focus: true` (else the first) is focused. Exclusive with `workspace`.
     */
    workspaces?: Record<string, WorkspaceBlueprint & { focus?: boolean }>;
  };
}

/** One workspace's blueprint: the repo entries a fresh setup seeds it with. */
export interface WorkspaceBlueprint {
  /** Branch managed clones track (default "main"). */
  branch?: string;
  /** Repo-system names to seed, all as managed clones. */
  repos?: string[];
  /**
   * Seeded repos that get `autostart: false` stamped on their workspace
   * entry — the team default for systems a fresh clone should not start
   * with workspace up (e.g. billing-api's `make up` opens an interactive
   * Stripe tab). Personal thereafter: toggle per system in the web ⋮ menu.
   */
  autostart_off?: string[];
}

/**
 * Per-engineer preferences stored in config/local/user.yml (gitignored).
 * Only affects settings that should differ between engineers on the same team.
 */
export interface UserConfig {
  /** Per-engineer secrets override (e.g. provider: env). */
  secrets?: SecretsConfig;
  /**
   * Whether the local dev experience is enabled for this engineer.
   * When false, the Local Dev tab is hidden and all workspace/service APIs
   * are disabled. Defaults to true (local dev on by default).
   */
  local_dev?: boolean;
  /** Whether `den up` / `den restart` should default to terminal tab mode. */
  cli_tabs?: boolean;
  /**
   * Max lines a /logs pane keeps loaded (live tail + paged history).
   * Default 20000. Raise via `den config log_window_lines=50000` when
   * deeper in-pane digs are needed; full-history search is unaffected.
   */
  log_window_lines?: number;
  /**
   * Key of the preferred editor for "open in editor" actions (e.g. "vscode", "cursor").
   * Stored as a key; the server resolves the actual executable path at open time.
   */
  editor?: string;
  /**
   * Key of the preferred terminal app for "open in terminal" actions (e.g. "ghostty", "iterm2").
   * Stored as a key; the server resolves the app name at open time.
   */
  terminal?: string;
  /**
   * Per-language IDE overrides. Key = language slug (e.g. "go"), value = editor key (e.g. "idea").
   * When opening a repo whose stack.yml declares a matching language, den uses this
   * editor instead of the default.
   */
  editor_overrides?: Record<string, string>;
  /**
   * Personal override of the team release config (config/den.yml `release:`).
   * Wave-assignment edits made in the Release tab are saved here so they stay
   * local and never get committed. Merged field-wise over the team base.
   */
  release?: Partial<ReleaseConfig>;
  /**
   * Graph layout preferences (direction, grouping, card density, panel
   * width), set from the Local Dev graph. See src/ui/server/graph-prefs.ts.
   */
  graph?: {
    direction?: string;
    group?: string;
    density?: string;
    panelWidth?: number;
  };
  /**
   * Web UI appearance: theme id and mode (system | dark | light), set from
   * the header. See src/ui/server/appearance-prefs.ts.
   */
  appearance?: { theme?: string; mode?: string };
  /** The rail's pins and collapse (src/ui/server/shell-prefs.ts). */
  shell?: { pins?: string[]; collapsed?: boolean };
  /**
   * What the web UI and `<cli> status` show: `scope` is "all" (every active
   * workspace, the default) or one active workspace's name. A view filter
   * only: the focused workspace stays the default target for commands. See
   * src/shared/environment-manager/scope.ts.
   */
  view?: { scope?: string };
}

const ALL_ENVIRONMENTS: Environment[] = [
  "local",
  "dev",
  "sandbox",
  "staging",
  "beta",
  "prod",
  "production",
];

/** Den's built-in environment names (used when the org config lists none). */
export function builtinEnvironments(): Environment[] {
  return [...ALL_ENVIRONMENTS];
}

const DEFAULT_CONFIG: DenConfig = {
  environments: ALL_ENVIRONMENTS,
};

/** Read the per-engineer user config (config/local/user.yml). Returns {} if absent. */
export function readUserConfig(): UserConfig {
  try {
    const raw = fs.readFileSync(USER_CONFIG_PATH, "utf-8");
    const parsed = yaml.parse(raw) as UserConfig | null;
    return parsed ?? {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Write the per-engineer user config to config/local/user.yml. */
export function writeUserConfig(cfg: UserConfig): void {
  fs.mkdirSync(path.dirname(USER_CONFIG_PATH), { recursive: true });
  const lines = [
    "# Per-engineer preferences — gitignored, never committed",
    yaml.stringify(cfg).trimEnd(),
  ];
  fs.writeFileSync(USER_CONFIG_PATH, lines.join("\n") + "\n", "utf-8");
}

/** Merge a partial patch into config/local/user.yml without clobbering fields. */
export function mergeUserConfig(patch: Partial<UserConfig>): UserConfig {
  const current = readUserConfig();
  const next: UserConfig = { ...current };

  for (const [key, value] of Object.entries(patch) as Array<
    [keyof UserConfig, UserConfig[keyof UserConfig] | undefined]
  >) {
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value as never;
    }
  }

  writeUserConfig(next);
  return next;
}

/**
 * The GitHub org managed repos clone from. Den has no default: an org that
 * needs one sets `github_org` in its config.
 */
export function requireGithubOrg(config: DenConfig = readDenConfig()): string {
  const org = config.github_org?.trim();
  if (!org)
    throw new Error(
      `github_org is not set: add \`github_org: <your-org>\` to ${DEN_CONFIG_PATH}`,
    );
  return org;
}

/**
 * Read the effective den config, merging the shared deployment config with
 * per-engineer overrides from config/local/user.yml.
 */
export function readDenConfig(): DenConfig {
  // Read shared base config
  let base: DenConfig;
  try {
    const raw = fs.readFileSync(DEN_CONFIG_PATH, "utf-8");
    const parsed = yaml.parse(raw) as Partial<DenConfig> | null;
    // `environments` may be malformed (scalar/object) in a hand-edited file —
    // fall back to the default set rather than throwing on .filter below.
    const envs = Array.isArray(parsed?.environments)
      ? parsed.environments
      : ALL_ENVIRONMENTS;
    base = {
      environments: envs.filter((e): e is Environment =>
        ALL_ENVIRONMENTS.includes(e as Environment),
      ),
      production_envs: parsed?.production_envs,
      repos_root: parsed?.repos_root,
      github_org: parsed?.github_org,
      orgs: parsed?.orgs,
      graph: parsed?.graph,
      org: parsed?.org,
      applications: parsed?.applications,
      release: parsed?.release,
      service_env: parsed?.service_env,
      env_health_urls: parsed?.env_health_urls,
      security: parsed?.security,
      mcp: parsed?.mcp,
      web: parsed?.web,
      test_accounts: parsed?.test_accounts,
      defaults: parsed?.defaults,
      secrets: parsed?.secrets,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      base = { ...DEFAULT_CONFIG };
    } else {
      throw err;
    }
  }

  // Apply per-engineer override: local_dev: false → strip "local" from environments
  const user = readUserConfig();
  if (user.local_dev === false) {
    base.environments = base.environments.filter((e) => e !== "local");
  }

  return base;
}

/**
 * Absolute path to the root directory where local repos are discovered.
 * Defaults to the parent of the den root directory.
 */
export function getReposRoot(): string {
  const config = readDenConfig();
  return path.resolve(ROOT, config.repos_root ?? "..");
}

const DEFAULT_PRODUCTION_ENVS = ["prod", "production"];

/** The envs the org counts as production (`production_envs`). */
export function productionEnvs(config: DenConfig = readDenConfig()): string[] {
  const listed = config.production_envs;
  return Array.isArray(listed) &&
    listed.every((e): e is string => typeof e === "string")
    ? listed
    : DEFAULT_PRODUCTION_ENVS;
}

/**
 * Whether the org counts `env` as production. An unreadable org config falls
 * back to the default list rather than letting a guard throw.
 */
export function isProductionEnv(env: string, config?: DenConfig): boolean {
  let listed: string[];
  try {
    listed = productionEnvs(config ?? readDenConfig());
  } catch {
    listed = DEFAULT_PRODUCTION_ENVS;
  }
  return listed.includes(env);
}

/**
 * The org's environment names, for validating manifests: the config's
 * `environments` (Den's built-in list when unset), always with `local`.
 */
export function orgEnvironments(config: DenConfig = readDenConfig()): string[] {
  return [...new Set<string>(["local", ...config.environments])];
}

/** True when the `local` environment is enabled for this engineer. */
export function isLocalEnabled(): boolean {
  return readDenConfig().environments.includes("local");
}

// ── Security config (security pillar) ─────────────────────────────────────────

/** `security:` in config/den.yml. */
export interface SecurityConfig {
  /**
   * Hostnames the security pillar may point ZAP at. An entry matches that exact
   * host or any subdomain of it (a leading "." is ignored). Extend per shell with
   * DEN_SECURITY_EXTRA_HOSTS (comma-separated).
   */
  owned_hosts?: string[];
  /**
   * Also scan, unlisted, every locally run service with an HTTP health URL
   * (unless its manifest says `security.skip`). Default false: only the
   * targets manifests declare under `security:` are scanned.
   */
  auto_targets?: boolean;
}

/**
 * Owned hosts when config/den.yml has no `security.owned_hosts`: none.
 * Scanning is a deliberate per-org choice, so nothing is owned by default.
 */
export const DEFAULT_SECURITY_OWNED_HOSTS: readonly string[] = [];

/**
 * The configured owned-host allowlist (config/den.yml
 * `security.owned_hosts`), lowercased. A missing or malformed value falls back
 * to DEFAULT_SECURITY_OWNED_HOSTS; an explicit empty list means "nothing owned".
 */
export function readSecurityOwnedHosts(
  config: DenConfig = readDenConfig(),
): string[] {
  const hosts = config.security?.owned_hosts;
  const list = Array.isArray(hosts) ? hosts : DEFAULT_SECURITY_OWNED_HOSTS;
  return list
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/** Whether `security.auto_targets` is on (only an explicit `true` counts). */
export function readSecurityAutoTargets(
  config: DenConfig = readDenConfig(),
): boolean {
  return config.security?.auto_targets === true;
}

// ── MCP config (`<cli> mcp`) ───────────────────────────────────────────────────

/** The action tools an org can opt in to. Read tools are always on. */
export const MCP_ACTIONS = [
  "service_up",
  "service_down",
  "service_restart",
  "workspace_sync",
  "run_tests",
] as const;
export type McpAction = (typeof MCP_ACTIONS)[number];

/** `mcp:` in the org config. */
export interface McpConfig {
  /** Action tools to register; none when absent. */
  actions?: string[];
  /** Environments `run_tests` may target (default [local]; production never). */
  run_tests?: { envs?: string[] };
  /** `remote: true` lets the log tools read non-local sources (e.g. CloudWatch). */
  logs?: { remote?: boolean };
}

/** `mcp:` with its defaults applied. */
export interface ResolvedMcpConfig {
  actions: McpAction[];
  runTestsEnvs: Environment[];
  logsRemote: boolean;
}

/**
 * The effective MCP config. An unknown action or environment name throws:
 * a typo must not silently turn a guard off (or an action on).
 */
export function readMcpConfig(
  config: DenConfig = readDenConfig(),
): ResolvedMcpConfig {
  const raw = config.mcp ?? {};
  const actions = (Array.isArray(raw.actions) ? raw.actions : []).map((a) => {
    if (!(MCP_ACTIONS as readonly string[]).includes(String(a)))
      throw new Error(
        `mcp.actions: unknown action "${String(a)}" (known: ${MCP_ACTIONS.join(", ")})`,
      );
    return a as McpAction;
  });
  const envList = raw.run_tests?.envs;
  const runTestsEnvs = (Array.isArray(envList) ? envList : ["local"]).map(
    (e) => {
      if (!ALL_ENVIRONMENTS.includes(e as Environment))
        throw new Error(
          `mcp.run_tests.envs: unknown environment "${String(e)}" (known: ${ALL_ENVIRONMENTS.join(", ")})`,
        );
      return e as Environment;
    },
  );
  return {
    actions: [...new Set(actions)],
    runTestsEnvs: [...new Set(runTestsEnvs)],
    logsRemote: raw.logs?.remote === true,
  };
}

// ── Web UI service (`<cli> service`) ──────────────────────────────────────────

/** `web:` in the org config. */
export interface WebConfig {
  port?: number;
  /** The launchd service that runs the web UI (`<cli> service install`). */
  service?: { label?: string; logs?: string };
}

/** A validated workspace blueprint with its defaults applied. */
export interface ResolvedWorkspaceBlueprint {
  name: string;
  repos: string[];
  branch: string;
  autostartOff: string[];
  focus: boolean;
}

/** Which blueprint shape the distribution uses, and its workspaces. */
export interface WorkspaceBlueprints {
  shape: "none" | "single" | "multi";
  workspaces: ResolvedWorkspaceBlueprint[];
}

const BLUEPRINT_KEYS = ["branch", "repos", "autostart_off"];

function blueprintStrings(where: string, key: string, v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((r) => typeof r !== "string" || !r.trim()))
    throw new Error(`${where}.${key} must be a list of repo names`);
  return v as string[];
}

function resolveBlueprint(
  where: string,
  name: string,
  raw: unknown,
  /** Extra keys allowed; null skips the unknown-key check (legacy shape). */
  extraKeys: string[] | null,
): ResolvedWorkspaceBlueprint {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${where} must be a map: { repos: [...] }`);
  const bp = raw as Record<string, unknown>;
  const known = [...BLUEPRINT_KEYS, ...(extraKeys ?? [])];
  for (const key of Object.keys(bp))
    if (extraKeys && !known.includes(key))
      throw new Error(
        `${where}: unknown key "${key}" (known: ${known.join(", ")})`,
      );
  const branch = bp.branch ?? "main";
  if (typeof branch !== "string" || !branch.trim())
    throw new Error(`${where}.branch must be a branch name`);
  if (bp.focus !== undefined && typeof bp.focus !== "boolean")
    throw new Error(`${where}.focus must be true or false`);
  return {
    name,
    repos: blueprintStrings(where, "repos", bp.repos),
    branch,
    autostartOff: blueprintStrings(where, "autostart_off", bp.autostart_off),
    focus: bp.focus === true,
  };
}

/**
 * The distribution's workspace blueprint, validated: `defaults.workspace`
 * (one workspace, `default`) or `defaults.workspaces` (named workspaces).
 * Empty when neither is set. Both at once, or a malformed value, throws.
 */
export function readWorkspaceBlueprints(
  config: DenConfig = readDenConfig(),
): WorkspaceBlueprints {
  const none: WorkspaceBlueprints = { shape: "none", workspaces: [] };
  const defaults: unknown = config.defaults;
  if (defaults === undefined || defaults === null) return none;
  if (typeof defaults !== "object" || Array.isArray(defaults))
    throw new Error(`defaults in ${DEN_CONFIG_PATH} must be a map`);
  const { workspace, workspaces } = defaults as Record<string, unknown>;
  if (workspace != null && workspaces != null)
    throw new Error(
      `${DEN_CONFIG_PATH} sets both defaults.workspace and defaults.workspaces: ` +
        "use defaults.workspaces alone (name the default workspace `default` in it), " +
        "or defaults.workspace alone for a single default workspace",
    );
  if (workspaces != null) {
    if (typeof workspaces !== "object" || Array.isArray(workspaces))
      throw new Error(
        "defaults.workspaces must be a map: { <name>: { repos: [...], focus?: true } }",
      );
    const resolved = Object.entries(workspaces as Record<string, unknown>).map(
      ([name, raw]) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
          throw new Error(
            `defaults.workspaces: "${name}" is not a valid workspace name (letters, digits, dots, dashes, underscores)`,
          );
        return resolveBlueprint(`defaults.workspaces.${name}`, name, raw, [
          "focus",
        ]);
      },
    );
    const focused = resolved.filter((b) => b.focus);
    if (focused.length > 1)
      throw new Error(
        `defaults.workspaces: only one workspace may set focus: true (got ${focused.map((b) => b.name).join(", ")})`,
      );
    return { shape: "multi", workspaces: resolved };
  }
  if (workspace != null)
    return {
      shape: "single",
      workspaces: [
        resolveBlueprint("defaults.workspace", "default", workspace, null),
      ],
    };
  return none;
}

/** `web.service` with its defaults applied. */
export interface ResolvedWebService {
  /** launchd label; also the plist's name in ~/Library/LaunchAgents. */
  label: string;
  /** Directory the service's web.log goes to. */
  logs: string;
}

const WEB_SERVICE_KEYS = ["label", "logs"];

/**
 * The web UI's launchd service. The defaults are service/install.sh's own
 * (`local.<distribution dir name>.web`, `~/Library/Logs/<dir name>`), so an
 * install made with the script keeps its label. `logs` may start with `~/`;
 * a relative path is under the distribution root. A bad value throws.
 */
export function readWebServiceConfig(
  config: DenConfig = readDenConfig(),
  distRoot: string = ROOT,
  home: string = os.homedir(),
): ResolvedWebService {
  const name = path.basename(distRoot);
  const raw: unknown = config.web?.service;
  if (
    raw !== undefined &&
    (raw === null || typeof raw !== "object" || Array.isArray(raw))
  )
    throw new Error("web.service must be a map: { label, logs }");
  const svc = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(svc))
    if (!WEB_SERVICE_KEYS.includes(key))
      throw new Error(
        `web.service: unknown key "${key}" (known: ${WEB_SERVICE_KEYS.join(", ")})`,
      );
  const label = svc.label ?? `local.${name}.web`;
  if (typeof label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label))
    throw new Error(
      `web.service.label must be letters, digits, dots, dashes and underscores, got "${String(label)}"`,
    );
  const logs = svc.logs ?? path.join(home, "Library", "Logs", name);
  if (typeof logs !== "string" || !logs.trim())
    throw new Error(
      `web.service.logs must be a directory path, got "${String(logs)}"`,
    );
  const expanded = logs.startsWith("~/")
    ? path.join(home, logs.slice(2))
    : logs;
  return {
    label,
    logs: path.isAbsolute(expanded) ? expanded : path.join(distRoot, expanded),
  };
}

// ── Release config (Release tab) ──────────────────────────────────────────────

/**
 * Built-in release defaults: no environments or repos, deploys off. The org
 * config's `release:` layers over this, personal edits via
 * config/local/user.yml.
 */
export const DEFAULT_RELEASE_CONFIG: ReleaseConfig = {
  deploy: false,
  // No built-in environments or repos: each instance lists its own.
  environments: [],
  staggerSeconds: 20,
  pollSeconds: 15,
  repos: [],
};

/** Merge one override layer (den.yml or user.yml) over a base release config. */
function mergeReleaseLayer(
  base: ReleaseConfig,
  layer?: Partial<ReleaseConfig> | null,
): ReleaseConfig {
  const merged: ReleaseConfig = {
    deploy: base.deploy,
    org: layer?.org ?? base.org,
    environments:
      Array.isArray(layer?.environments) && layer.environments.length
        ? layer.environments
        : base.environments,
    staggerSeconds:
      typeof layer?.staggerSeconds === "number"
        ? layer.staggerSeconds
        : base.staggerSeconds,
    pollSeconds:
      typeof layer?.pollSeconds === "number"
        ? layer.pollSeconds
        : base.pollSeconds,
    repos: base.repos.map((r) => ({ ...r })),
    ...(base.profiles || layer?.profiles
      ? { profiles: { ...base.profiles, ...layer?.profiles } }
      : {}),
  };

  if (Array.isArray(layer?.repos)) {
    // A layer may add repos with only a subset of fields (e.g. a hand-edited
    // user.yml with just name+wave), so treat entries as partial at runtime.
    const patches = layer.repos as Array<
      Partial<ReleaseRepo> & { name: string }
    >;
    const byName = new Map(merged.repos.map((r) => [r.name, r]));
    for (const patch of patches) {
      if (!patch?.name) continue;
      const existing = byName.get(patch.name);
      if (existing) Object.assign(existing, patch);
      else byName.set(patch.name, { workflow: "cd.yml", wave: 0, ...patch });
    }
    merged.repos = [...byName.values()];
  }
  return merged;
}

/**
 * Read the effective release config: built-in defaults ← config/den.yml
 * `release:` (team base) ← config/local/user.yml `release:` (personal override).
 * `org` falls back to the den `github_org` when unset at every layer.
 */
export function readReleaseConfig(): ReleaseConfig {
  const den = readDenConfig();
  let cfg = mergeReleaseLayer(DEFAULT_RELEASE_CONFIG, den.release);
  // Only the team layer may enable deploys; user.yml can't.
  cfg.deploy = den.release?.deploy === true;
  cfg = mergeReleaseLayer(cfg, readUserConfig().release);
  if (!cfg.org) cfg.org = den.github_org;
  return cfg;
}

/**
 * Persist a personal release override to config/local/user.yml (gitignored).
 * Used by the Release tab's wave editor — team defaults stay in den.yml.
 */
export function writeUserReleaseConfig(release: Partial<ReleaseConfig>): void {
  const { deploy: _ignored, ...rest } = release;
  void _ignored;
  mergeUserConfig({ release: rest });
}
