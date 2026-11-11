/**
 * Den deployment configuration reader.
 *
 * Two-layer config system:
 *   config/den.yml       — committed, shared deployment config
 *   config/local/user.yml   — gitignored, per-engineer overrides
 *
 * The user file can toggle local_dev on/off without touching the shared config.
 */

import { HELPER_DEFAULTS, type HelperSettings } from "./agents/helpers.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import type { Environment, ReleaseSourceConfig } from "./types/index.js";
import { getDistRoot } from "./paths.js";
import type { SecretsConfig } from "./secrets/index.js";
import type { OrgConfig } from "./org.js";
import { validateOrgSources, type WorkOrgsConfig } from "./org-sources.js";
import { ConfigError, isConfigError } from "./config-error.js";
import { validateCatalog, type CatalogEntry } from "./agents/catalog.js";
import type { Guardrails } from "./agents/guardrails.js";
import { DEFAULT_ROTATE, type RotateSettings } from "./agents/rotation.js";
import { checkRotateValue, type OrgRotate } from "./agents/rotate-settings.js";
import {
  checkCategoriesConfig,
  checkRolesConfig,
  DEN_CATEGORIES,
  type Category,
  type RolesConfig,
} from "./agents/roles.js";
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
   * Work orgs, keyed by org id: a display name and an optional colour. An
   * entry with neither `sources` nor `repos` is the GitHub owner of its own
   * name (ORG-1a). ORG-1d: `sources: [{host, owner|group}]` binds the org to
   * git-host owners, and `repos: [...]` lists repos outright. See
   * src/shared/org-sources.ts.
   */
  orgs?: WorkOrgsConfig;
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
   * Agents: `max_concurrent` caps the agents running at once in this
   * distribution (default 4); plain sessions never count. See
   * readAgentsConfig.
   */
  agents?: AgentsConfig;
  /**
   * Plain sessions (`<cli> sessions start`): `max_concurrent` caps those
   * running at once (default 8); agents never count. See readSessionsConfig.
   */
  sessions?: SessionsConfig;
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
   * Where a file path in an agent's pane opens (AG-4b): vscode, cursor or
   * zed by URL scheme, or none (copy the path). editor-open-pref.ts.
   */
  editor_open?: string;
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
  /**
   * The web UI's language (R19): en (the default, never stored), ja or es.
   * See src/ui/server/ui-language.ts.
   */
  language?: string;
  /**
   * The rail's pins and collapse, and (R21 Navigation) the pages it hides
   * and their order (src/ui/server/shell-prefs.ts).
   */
  shell?: {
    pins?: string[];
    collapsed?: boolean;
    hidden?: string[];
    order?: string[];
  };
  /**
   * What the web UI and `<cli> status` show: `scope` is "all" (every active
   * workspace, the default) or one active workspace's name. A view filter
   * only: the focused workspace stays the default target for commands. See
   * src/shared/environment-manager/scope.ts.
   */
  view?: { scope?: string };
  /**
   * Agents on this machine (AG-0.1): `runtimes.<id>.bin`, the absolute path
   * of a runtime's CLI, which wins over the search (login shell PATH, PATH,
   * install directories). Per machine, so user.yml only: the distribution's
   * config never sets a path. See shared/agents/runtime-search.ts.
   */
  agents?: {
    runtimes?: Record<string, { bin?: unknown } | null>;
    /** More runtime catalog entries (AG-0.5, agents/catalog.ts). */
    runtime_catalog?: unknown;
    /**
     * AG-14.1b: forget stopped and exited agents after this long: never
     * (the default), 1d or 7d. Interrupted agents are never forgotten.
     */
    remove_stopped_after?: unknown;
    /** AG-4b: the Agents tab's layout (src/ui/server/agents-layout-pref.ts). */
    layout?: unknown;
  };
  /**
   * The web server's per-machine keys (src/shared/web-session.ts
   * readWebAuthConfig): allow_plain_http_remote, edge_unattested,
   * github_client_id, and (SEC-2a) machine_name, the name the signed-out
   * page gives this machine.
   */
  web?: Record<string, unknown>;
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

/** The per-engineer user config's path (config/local/user.yml), absolute. */
export function userConfigPath(): string {
  return USER_CONFIG_PATH;
}

/**
 * `agents.runtimes.<id>.bin` from user.yml, as written (checked where it is
 * used: runtime-search.ts checkBinSetting; a block that is no mapping is
 * `{ why }`); undefined when unset or when user.yml can't be read.
 */
export function configuredRuntimeBin(
  id: string,
  read: () => UserConfig = readUserConfig,
): unknown {
  try {
    const rts = read().agents?.runtimes;
    if (!rts || typeof rts !== "object") return undefined;
    const block = (rts as Record<string, unknown>)[id];
    if (block === undefined || block === null) return undefined;
    if (typeof block !== "object" || Array.isArray(block))
      return {
        why: `agents.runtimes.${id} must be a mapping ({ bin: <absolute path> })`,
      };
    return (block as { bin?: unknown }).bin;
  } catch {
    return undefined;
  }
}

/**
 * user.yml's `agents.runtime_catalog`, checked (agents/catalog.ts), after
 * the built-in entries and the distribution's (`taken`). Throws naming
 * the key when malformed.
 */
export function configuredRuntimeCatalog(
  taken: readonly string[],
  read: () => UserConfig = readUserConfig,
): CatalogEntry[] {
  return validateCatalog(
    read().agents?.runtime_catalog,
    `agents.runtime_catalog (${path.basename(USER_CONFIG_PATH)})`,
    taken,
  );
}

/** The values `agents.remove_stopped_after` takes, in days (AG-14.1b). */
export const REMOVE_STOPPED_AFTER: Readonly<Record<string, number>> = {
  never: 0,
  "1d": 1,
  "7d": 7,
};

/**
 * user.yml's `agents.remove_stopped_after`, in days (0: never, the
 * default). Throws naming the key when it is none of never, 1d, 7d.
 */
export function configuredRemoveStoppedAfter(
  read: () => UserConfig = readUserConfig,
): number {
  const v = read().agents?.remove_stopped_after;
  if (v === undefined || v === null) return 0;
  if (typeof v === "string" && Object.hasOwn(REMOVE_STOPPED_AFTER, v))
    return REMOVE_STOPPED_AFTER[v];
  throw new Error(
    `agents.remove_stopped_after (${path.basename(USER_CONFIG_PATH)}): must be never, 1d or 7d (got ${JSON.stringify(v)})`,
  );
}

/**
 * Set (a path) or clear (null) `agents.runtimes.<id>.bin` in user.yml,
 * keeping everything else there. The caller checks the path first.
 */
export function setUserRuntimeBin(id: string, bin: string | null): void {
  const cfg = readUserConfig();
  const agents = { ...(cfg.agents ?? {}) };
  const runtimes = { ...(agents.runtimes ?? {}) };
  if (bin === null) delete runtimes[id];
  else runtimes[id] = { ...(runtimes[id] ?? {}), bin };
  if (Object.keys(runtimes).length) agents.runtimes = runtimes;
  else delete agents.runtimes;
  const next: UserConfig = { ...cfg };
  if (Object.keys(agents).length) next.agents = agents;
  else delete next.agents;
  writeUserConfig(next);
}

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
 * A scaffold or docs placeholder rather than a real org: `your-github-org`,
 * `your-org`, `<your-org>`, `<slug>`, `example-org`. Den treats it as unset.
 */
export function isPlaceholderGithubOrg(org: string): boolean {
  return /^(your[-_]?(github[-_]?)?org|<.*>|example[-_]?org)$/i.test(
    org.trim(),
  );
}

/**
 * The configured `github_org`, or null when it is unset or still a
 * placeholder ("not configured": Den runs no gh for it).
 */
export function configuredGithubOrg(
  config: DenConfig = readDenConfig(),
): string | null {
  const org =
    typeof config.github_org === "string" ? config.github_org.trim() : "";
  return org && !isPlaceholderGithubOrg(org) ? org : null;
}

/**
 * The GitHub org managed repos clone from. Den has no default: an org that
 * needs one sets `github_org` in its config.
 */
export function requireGithubOrg(config: DenConfig = readDenConfig()): string {
  const org = configuredGithubOrg(config);
  if (!org)
    throw new Error(
      `github_org is not set: add \`github_org: <your-org>\` to ${DEN_CONFIG_PATH}`,
    );
  return org;
}

/**
 * Run a section reader (agents:, sessions:) whose checks throw a plain
 * Error "<key>: <what is wrong>", and throw that as a ConfigError instead:
 * the user's to fix, so the web server answers 422 with the config page,
 * not a 500. A trailing "(got …)" is left out: issues name keys, never
 * values.
 */
function asConfigError<T>(read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (isConfigError(e) || !(e instanceof Error)) throw e;
    const text = e.message.replace(/\s*\(got [\s\S]*\)$/, "");
    const at = text.indexOf(": ");
    const key = at > 0 ? text.slice(0, at) : text.split(/\s/)[0];
    const message = at > 0 ? text.slice(at + 2) : text;
    throw new ConfigError([{ file: product().configFile, key, message, text }]);
  }
}

/**
 * The ConfigError of one section (`agents:` or `sessions:`), or null.
 * Scoped to it: a typo there stops only the agent and session commands
 * and routes (and the Agents page), never services, logs, tests or the
 * edge. A file that can't be read is left to readDenConfig's callers.
 */
export function sectionConfigError(
  section: "agents" | "sessions",
): ConfigError | null {
  let config: DenConfig;
  try {
    config = readDenConfig();
  } catch {
    return null;
  }
  try {
    if (section === "agents") readAgentsConfig(config);
    else readSessionsConfig(config);
    return null;
  } catch (e) {
    if (isConfigError(e)) return e;
    throw e;
  }
}

let checked: { key: string; error: ConfigError | null } | null = null;

/**
 * Throw the config's validation error (a ConfigError naming its keys), if it
 * has one, without reading anything else. The CLI runs this before any
 * command that touches orgs, the catalog, clones or releases, and the web
 * server before every config-reading route, so a config that fails
 * validation stops them all, not only those that happen to read `orgs:`.
 * A missing file, or one that does not parse, is left to readDenConfig.
 * Memoised on the file's mtime and size: the server checks per request.
 */
export function assertDenConfigValid(): void {
  let key: string;
  try {
    const st = fs.statSync(DEN_CONFIG_PATH);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return;
  }
  if (checked?.key !== key) {
    let error: ConfigError | null = null;
    try {
      const parsed = yaml.parse(fs.readFileSync(DEN_CONFIG_PATH, "utf-8")) as {
        orgs?: unknown;
      } | null;
      validateOrgSources(parsed?.orgs, product().configFile);
    } catch (e) {
      if (!isConfigError(e)) return;
      error = e;
    }
    checked = { key, error };
  }
  if (checked.error) throw new ConfigError(checked.error.issues);
}

let orgsWaived = false;

/**
 * For `down` only (0.3.0-dev.40): from now on in this process, a config
 * whose `orgs:` fails validation reads as one with no org data instead of
 * throwing, so stopping is never stranded by it. Every other key is read as
 * usual; a file that does not parse still throws.
 */
export function waiveInvalidOrgs(): void {
  orgsWaived = true;
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
    // ORG-1d keys (orgs.<id>.sources / .repos) are checked here, where a bad
    // value throws naming its key; configs without them are not touched.
    let orgs = parsed?.orgs;
    try {
      validateOrgSources(orgs, product().configFile);
    } catch (e) {
      if (!orgsWaived || !isConfigError(e)) throw e;
      orgs = undefined;
    }
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
      orgs,
      graph: parsed?.graph,
      org: parsed?.org,
      applications: parsed?.applications,
      release: parsed?.release,
      service_env: parsed?.service_env,
      env_health_urls: parsed?.env_health_urls,
      security: parsed?.security,
      mcp: parsed?.mcp,
      agents: parsed?.agents,
      sessions: parsed?.sessions,
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
  // AG-14.4: resume another agent of its workspace (or a granted one).
  "agent_resume",
  // AG-17.1: bring in a conversation started outside Den, as an agent.
  "agent_import",
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
  /**
   * The held writes (workspace_create, repo_add, service_try): on by
   * default, each run only after the person's Allow. false hides them.
   */
  approvals?: boolean;
}

/** `mcp:` with its defaults applied. */
export interface ResolvedMcpConfig {
  actions: McpAction[];
  runTestsEnvs: Environment[];
  logsRemote: boolean;
  /** Whether the held writes are registered (default true). */
  approvals: boolean;
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
  if (raw.approvals !== undefined && typeof raw.approvals !== "boolean")
    throw new Error(
      `mcp.approvals: true or false, not ${JSON.stringify(raw.approvals)}`,
    );
  return {
    actions: [...new Set(actions)],
    runTestsEnvs: [...new Set(runTestsEnvs)],
    logsRemote: raw.logs?.remote === true,
    approvals: raw.approvals !== false,
  };
}

// ── Agents (`<cli> sessions`, `<cli> agents`) ─────────────────────────────────

/** `agents:` in the org config. */
export interface AgentsConfig {
  /** Agents that may run at once (default 4); plain sessions never count. */
  max_concurrent?: number;
  /**
   * Persona packs (AG-2a): directories of persona files, relative to the
   * distribution root. Den's default pack is always read first; a pack's
   * persona replaces one of the same id. An entry may be a mapping,
   * `{ path, hooks, instructions }`, to turn Den's guardrails on for that
   * pack (agents/guardrails.ts; off for a distribution's pack by default).
   */
  persona_packs?: (string | PersonaPackConfig)[];
  /**
   * Den's default pack's guardrails, `{ hooks, instructions }` (both on
   * by default): false turns that one off for every persona of the pack.
   */
  default_pack?: Partial<Guardrails>;
  /**
   * More runtime catalog entries (AG-0.5, agents/catalog.ts): a vendor CLI
   * Den doesn't ship, with the same fields and checks as a built-in one.
   */
  runtime_catalog?: unknown[];
  /**
   * Session rotation (den#4), `{ after_compactions, standing }`: a session
   * ends after `after_compactions` compactions (default 3) or once its pull
   * request merged, and its role relaunches from its handoff. `standing:
   * false` keeps standing personas from rotating (default true).
   */
  rotate?: { after_compactions?: unknown; standing?: unknown };
  /**
   * D32, the helpers an agent starts in its own session:
   * `{ active_minutes, collapse_done_minutes }`. A helper with no activity
   * for `active_minutes` (default 10) and not known done shows idle; done
   * ones fold away after `collapse_done_minutes` (default 30).
   */
  helpers?: { active_minutes?: unknown; collapse_done_minutes?: unknown };
  /**
   * Any other key is an agent id: `agents.<id>.grants` widens that agent's
   * MCP scope to other workspaces (AG spec §5b). Config only: an agent
   * never grants itself one.
   */
  [agentId: string]: unknown;
}

/** A `persona_packs` entry written as a mapping. */
export interface PersonaPackConfig {
  path: string;
  hooks?: boolean;
  instructions?: boolean;
}

export const DEFAULT_AGENTS_MAX_CONCURRENT = 4;

/** The keys of `agents:` that are not an agent id. */
export const AGENTS_RESERVED_KEYS = [
  "max_concurrent",
  "persona_packs",
  "runtime_catalog",
  "default_pack",
  "rotate",
  // D32: how helpers show.
  "helpers",
  // AG-10.5, AG-11.1: the distribution's persona categories and roles.
  "categories",
  "roles",
];

/** One agent's own block, `agents.<id>`. */
export interface AgentGrantsConfig {
  /** Workspaces beyond its own that its MCP serves. */
  grants: string[];
}

/** `agents:` with its defaults applied. */
export interface ResolvedAgentsConfig {
  maxConcurrent: number;
  /** As configured (relative to the distribution root). */
  personaPacks: string[];
  /** Each pack's guardrails as configured, by index of personaPacks. */
  packGuardrails?: (Partial<Guardrails> | undefined)[];
  /** agents.default_pack as configured. */
  defaultPackGuardrails?: Partial<Guardrails>;
  /** `agents.<id>` blocks, by agent id. */
  agents: Record<string, AgentGrantsConfig>;
  /** The distribution's runtime catalog entries (AG-0.5), checked. */
  runtimeCatalog: CatalogEntry[];
  /** agents.rotate with its defaults (den#4); unset: DEFAULT_ROTATE. */
  rotate?: RotateSettings;
  /** D28: agents.rotate as written, the org scope. */
  rotateOrg?: OrgRotate;
  /** agents.helpers (D32) with its defaults. */
  helpers?: HelperSettings;
  /** agents.categories (AG-10.5): the distribution's, after Den's. */
  categories?: Category[];
  /** agents.roles (AG-11.1): new roles and Den roles' preset extensions. */
  roles?: RolesConfig;
}

/** `agents.helpers` (D32) checked; a bad key or value throws naming it. */
export function helpersBlock(v: unknown): HelperSettings {
  const out = { ...HELPER_DEFAULTS };
  if (v === undefined || v === null) return out;
  if (!isMapping(v))
    throw new Error(
      `agents.helpers: must be a mapping of active_minutes, collapse_done_minutes (got ${JSON.stringify(v)})`,
    );
  for (const [k, x] of Object.entries(v)) {
    const key =
      k === "active_minutes"
        ? "activeMinutes"
        : k === "collapse_done_minutes"
          ? "collapseDoneMinutes"
          : null;
    if (!key)
      throw new Error(
        `agents.helpers.${k}: unknown key (agents.helpers takes active_minutes, collapse_done_minutes)`,
      );
    if (typeof x !== "number" || !Number.isFinite(x) || x <= 0 || x > 100_000)
      throw new Error(
        `agents.helpers.${k}: must be a number of minutes, above 0 and at most 100000 (got ${JSON.stringify(x)})`,
      );
    out[key] = x;
  }
  return out;
}

/** `agents.rotate` checked; any other key, or a bad value, throws naming it. */
/**
 * `agents.rotate` checked, both ways: den#4's settings (afterCompactions 0
 * for never) and, for D28's scopes, the org's values as written.
 */
export function rotateOrgBlock(v: unknown): {
  settings: RotateSettings;
  org: OrgRotate;
} {
  const out: RotateSettings = { ...DEFAULT_ROTATE };
  const org: OrgRotate = {};
  if (v === undefined || v === null) return { settings: out, org };
  if (!isMapping(v))
    throw new Error(
      "agents.rotate: must be a mapping ({ after_compactions: <n>|never, on_due: auto|ask|off, on_pr_merged: true|false })",
    );
  for (const [k, x] of Object.entries(v)) {
    if (k === "after_compactions" || k === "on_due" || k === "on_pr_merged") {
      const bad = checkRotateValue(k, x);
      if (bad) throw new Error(`agents.rotate.${bad}`);
      (org as Record<string, unknown>)[k] = x;
      if (k === "after_compactions")
        out.afterCompactions = x === "never" ? 0 : (x as number);
    } else if (k === "standing") {
      if (typeof x !== "boolean")
        throw new Error(
          `agents.rotate.standing: must be true or false (got ${JSON.stringify(x)})`,
        );
      out.standing = x;
      org.standing = x;
    } else
      throw new Error(
        `agents.rotate.${k}: unknown key (takes after_compactions, on_due, on_pr_merged)`,
      );
  }
  return { settings: out, org };
}

/** An agent id or workspace name: what WORKSPACE_NAME_RE accepts. */
const AGENT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const isMapping = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * `{ hooks, instructions }` (agents.default_pack, or a persona_packs
 * mapping with its `path`): each true or false; any other key throws.
 */
function guardrailsBlock(
  v: unknown,
  where: string,
  withPath: boolean,
): Partial<Guardrails> {
  if (v === undefined || v === null) return {};
  if (!isMapping(v))
    throw new Error(
      `${where}: must be a mapping ({ hooks: true|false, instructions: true|false })`,
    );
  const out: Partial<Guardrails> = {};
  for (const [k, x] of Object.entries(v)) {
    if (withPath && k === "path") continue;
    if (k !== "hooks" && k !== "instructions")
      throw new Error(
        `${where}.${k}: unknown key (takes ${withPath ? "path, " : ""}hooks, instructions)`,
      );
    if (typeof x !== "boolean")
      throw new Error(
        `${where}.${k}: must be true or false (got ${JSON.stringify(x)})`,
      );
    out[k] = x;
  }
  return out;
}

/**
 * The effective agents config. Anything malformed throws, naming the key:
 * a typo must not lift the cap, drop a pack or widen a grant.
 */
export function readAgentsConfig(
  config: DenConfig = readDenConfig(),
): ResolvedAgentsConfig {
  return asConfigError(() => parseAgentsConfig(config));
}

function parseAgentsConfig(config: DenConfig): ResolvedAgentsConfig {
  const raw = (config.agents ?? {}) as unknown;
  if (!isMapping(raw))
    throw new Error(`agents: must be a mapping (got ${JSON.stringify(raw)})`);
  const out: ResolvedAgentsConfig = {
    maxConcurrent: DEFAULT_AGENTS_MAX_CONCURRENT,
    personaPacks: [],
    packGuardrails: [],
    defaultPackGuardrails: guardrailsBlock(
      raw.default_pack,
      "agents.default_pack",
      false,
    ),
    agents: {},
    runtimeCatalog: validateCatalog(
      raw.runtime_catalog,
      "agents.runtime_catalog",
    ),
    ...(() => {
      const r = rotateOrgBlock(raw.rotate);
      return { rotate: r.settings, rotateOrg: r.org };
    })(),
  };
  out.helpers = helpersBlock(raw.helpers);
  out.categories = checkCategoriesConfig(raw.categories);
  out.roles = checkRolesConfig(raw.roles, [
    ...DEN_CATEGORIES.map((c) => c.id),
    ...out.categories.map((c) => c.id),
  ]);
  const max = raw.max_concurrent;
  if (max !== undefined) {
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1)
      throw new Error(
        `agents.max_concurrent: must be a whole number of at least 1 (got ${JSON.stringify(max)})`,
      );
    out.maxConcurrent = max;
  }
  const packs = raw.persona_packs;
  if (packs !== undefined && packs !== null) {
    if (!Array.isArray(packs))
      throw new Error(
        `agents.persona_packs: must be a list of paths (got ${JSON.stringify(packs)})`,
      );
    packs.forEach((p, i) => {
      const where = `agents.persona_packs[${i}]`;
      const dir = isMapping(p) ? p.path : p;
      if (typeof dir !== "string" || !dir.trim())
        throw new Error(
          `${where}: must be a non-empty path or { path, hooks, instructions } (got ${JSON.stringify(p)})`,
        );
      out.personaPacks.push(dir);
      out.packGuardrails!.push(
        isMapping(p) ? guardrailsBlock(p, where, true) : undefined,
      );
    });
  }
  for (const [id, block] of Object.entries(raw)) {
    if (AGENTS_RESERVED_KEYS.includes(id)) continue;
    const where = `agents.${id}`;
    if (!AGENT_KEY_RE.test(id) || !isMapping(block))
      throw new Error(
        `${where}: unknown key (agents: takes max_concurrent, persona_packs, runtime_catalog, default_pack, rotate, helpers, categories, roles, ` +
          `or an agent id mapping to { grants: [...] })`,
      );
    for (const k of Object.keys(block))
      if (k !== "grants")
        throw new Error(`${where}.${k}: unknown key (an agent takes grants)`);
    const grants = block.grants ?? [];
    if (!Array.isArray(grants))
      throw new Error(
        `${where}.grants: must be a list of workspace names (got ${JSON.stringify(grants)})`,
      );
    grants.forEach((g, i) => {
      if (typeof g !== "string" || !AGENT_KEY_RE.test(g))
        throw new Error(
          `${where}.grants[${i}]: ${JSON.stringify(g)} is not a workspace name`,
        );
    });
    out.agents[id] = { grants: [...new Set(grants as string[])] };
  }
  return out;
}

/** `sessions:` in the org config: plain sessions (`<cli> sessions start`). */
export interface SessionsConfig {
  /** Plain sessions that may run at once (default 8); agents never count. */
  max_concurrent?: number;
}

export const DEFAULT_SESSIONS_MAX_CONCURRENT = 8;

/** `sessions:` with its defaults applied. */
export interface ResolvedSessionsConfig {
  maxConcurrent: number;
}

/**
 * The effective sessions config. Anything malformed throws, naming the key,
 * as readAgentsConfig does: a typo must not lift the cap.
 */
export function readSessionsConfig(
  config: DenConfig = readDenConfig(),
): ResolvedSessionsConfig {
  return asConfigError(() => parseSessionsConfig(config));
}

function parseSessionsConfig(config: DenConfig): ResolvedSessionsConfig {
  const raw = (config.sessions ?? {}) as unknown;
  if (!isMapping(raw))
    throw new Error(`sessions: must be a mapping (got ${JSON.stringify(raw)})`);
  for (const k of Object.keys(raw))
    if (k !== "max_concurrent")
      throw new Error(
        `sessions.${k}: unknown key (sessions: takes max_concurrent)`,
      );
  const out: ResolvedSessionsConfig = {
    maxConcurrent: DEFAULT_SESSIONS_MAX_CONCURRENT,
  };
  const max = raw.max_concurrent;
  if (max !== undefined) {
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1)
      throw new Error(
        `sessions.max_concurrent: must be a whole number of at least 1 (got ${JSON.stringify(max)})`,
      );
    out.maxConcurrent = max;
  }
  return out;
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
  /** `org:` (ORG-1a): the org this workspace belongs to, when the blueprint names one. */
  org?: string;
  /**
   * `stack_namespace:`: the Compose project suffix this workspace's stacks
   * run under, in place of its own name (see stacks/namespace.ts).
   */
  stackNamespace?: string;
}

/** Which blueprint shape the distribution uses, and its workspaces. */
export interface WorkspaceBlueprints {
  shape: "none" | "single" | "multi";
  workspaces: ResolvedWorkspaceBlueprint[];
}

const BLUEPRINT_KEYS = [
  "branch",
  "repos",
  "autostart_off",
  "org",
  "stack_namespace",
];

/**
 * A stack namespace (and a Compose project suffix): lowercase letters,
 * digits and dashes, not starting or ending with a dash.
 */
export const STACK_NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** `v` as a stack namespace, or undefined when unset; throws naming `key`. */
export function checkStackNamespace(
  key: string,
  v: unknown,
): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !STACK_NAMESPACE_RE.test(v))
    throw new Error(
      `${key} must be lowercase letters, digits and dashes (got ${JSON.stringify(v)})`,
    );
  return v;
}

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
  if (bp.org !== undefined && (typeof bp.org !== "string" || !bp.org.trim()))
    throw new Error(`${where}.org must be an org id (a key of orgs:)`);
  const stackNamespace = checkStackNamespace(
    `${where}.stack_namespace`,
    bp.stack_namespace,
  );
  return {
    name,
    repos: blueprintStrings(where, "repos", bp.repos),
    branch,
    autostartOff: blueprintStrings(where, "autostart_off", bp.autostart_off),
    focus: bp.focus === true,
    ...(typeof bp.org === "string" ? { org: bp.org.trim() } : {}),
    ...(stackNamespace ? { stackNamespace } : {}),
  };
}

/**
 * Each blueprint workspace's `stack_namespace`, by workspace name (the
 * single `defaults.workspace` is `default`). Reads only that key, so a
 * blueprint malformed elsewhere still gives its namespaces: the stacks'
 * Compose projects never fall back to another name because of an unrelated
 * error. A bad `stack_namespace` itself throws, naming the key.
 */
export function readBlueprintStackNamespaces(
  config: DenConfig = readDenConfig(),
): Record<string, string> {
  const out: Record<string, string> = {};
  const defaults: unknown = config.defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults))
    return out;
  const { workspace, workspaces } = defaults as Record<string, unknown>;
  const take = (where: string, name: string, raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const ns = checkStackNamespace(
      `${where}.stack_namespace`,
      (raw as Record<string, unknown>).stack_namespace,
    );
    if (ns) out[name] = ns;
  };
  if (
    workspaces &&
    typeof workspaces === "object" &&
    !Array.isArray(workspaces)
  )
    for (const [name, raw] of Object.entries(workspaces))
      take(`defaults.workspaces.${name}`, name, raw);
  else if (workspace != null) take("defaults.workspace", "default", workspace);
  return out;
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
 * `release.org` as configured (den.yml, then user.yml), without the
 * `github_org` fallback readReleaseConfig fills in. An explicit value is the
 * release owner of every repo (REL-1); unset, each repo's own catalog owner is.
 */
export function readExplicitReleaseOrg(): string | undefined {
  const den = mergeReleaseLayer(
    DEFAULT_RELEASE_CONFIG,
    readDenConfig().release,
  );
  const org = mergeReleaseLayer(den, readUserConfig().release).org;
  return typeof org === "string" && org.trim() ? org.trim() : undefined;
}

/**
 * The GitHub owner a repo is released from (REL-1): an explicit
 * `release.org` wins, then the repo's non-empty catalog owner, then
 * `github_org`. "" when none is known.
 */
export function releaseOwnerFor(opts: {
  explicitOrg?: string;
  catalogOwner?: string;
  githubOrg?: string;
}): string {
  return (
    opts.explicitOrg?.trim() ||
    opts.catalogOwner?.trim() ||
    opts.githubOrg?.trim() ||
    ""
  );
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
