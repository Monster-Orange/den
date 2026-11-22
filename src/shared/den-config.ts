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
import { uploadsBlock, type UploadSettings } from "./agents/uploads.js";
import { filesBlock, type FileSettings } from "./agents/file-deny.js";
import { subagentsBlock, type SubagentSettings } from "./agents/subagents.js";
import { checkIntent, type PermissionIntent } from "./agents/permissions.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import type { Environment, ReleaseSourceConfig } from "./types/index.js";
import { getDistRoot } from "./paths.js";
import { writeFileAtomic } from "./atomic-write.js";
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
import {
  gitSigningBlock,
  type AgentGitSettings,
} from "./agents/git-signing.js";

import { product } from "./product.js";
import { auditConfig, type ConfigAuditRow } from "./config-audit.js";
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
  /** 0.4.45: where the Hub editions are (hub-editions.ts). */
  hub_editions?: unknown;
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
   * SRV-1a: the server agent: its folder, git, update wait and prompt
   * check. `self_update` here does nothing since 0.4.47 (review M4): it is
   * the person's, in user.yml. See readServerAgentConfig.
   */
  server_agent?: ServerAgentConfig;
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
  /**
   * Review M4 (0.4.46): `server_agent.self_update: ask | auto`, the
   * person's: whether the server agent's own restarts and updates run
   * without an Allow. Only here; the team file's is ignored.
   */
  server_agent?: {
    self_update?: unknown;
    /**
     * 0.4.48: where self_update came from when Den copied it from the
     * team file at its first start (the file and the date). Unset when the
     * person set it.
     */
    self_update_from?: string;
    /**
     * SRV-P6 / LEAD-1 (0.4.48): this install is its distribution's lead
     * (the default: it takes new Den versions and bumps the pin) or a
     * follower (it applies the pin, never bumps it). The person's.
     */
    role?: unknown;
  };
  /**
   * Issue 160: the approval policy, the person's: `{ policy, writes }`,
   * each auto | notify | ask, for agents' routine held writes (critical
   * ones always ask). See shared/approval-policy.ts.
   */
  approvals?: unknown;
  /**
   * 0.4.46: after the machine restarts, the services that were up come back
   * up (restore_on_boot, true by default; restore-on-boot.ts).
   */
  services?: { restore_on_boot?: unknown; restore_wait_seconds?: unknown };
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
   * Browser settings. restart_wait_seconds (D64, default 90): how long the
   * Restart Den dialog waits before it shows the command line way.
   * request_memory_seconds: replaced by requests.keep_minutes in 0.4.48;
   * still read until 0.4.49 when that is unset.
   */
  ui?: { restart_wait_seconds?: number; request_memory_seconds?: number };
  /**
   * UK-2: the working pop-up's request ledger. keep_minutes (default 15):
   * how long Den remembers how a write sent from the pop-up ended, so Try
   * again never runs it twice and Check again can say how it ended.
   * max_entries (default 2000): how many it keeps. max_answer_kb (default
   * 256): the largest answer it keeps to replay.
   */
  requests?: {
    keep_minutes?: number;
    max_entries?: number;
    max_answer_kb?: number;
  };
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
   * Issue 103: Settings › Embedding (embed-settings.ts): deep links and
   * the embedded agent pane. Checked where it is read.
   */
  embed?: Record<string, unknown>;
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
   * The person's time zone for date-times (issue 206): an IANA zone; absent
   * is the browser's. See src/ui/server/time-zone-pref.ts.
   */
  time_zone?: string;
  /**
   * The rail's pins and collapse, and (R21 Navigation) the pages it hides
   * and their order (src/ui/server/shell-prefs.ts).
   */
  shell?: {
    /**
     * Issue 402: { item, project } (no project: none); a bare id is a pin
     * saved before the tuple, migrated on read and write.
     */
    pins?: (string | { item: string; project?: string | null })[];
    collapsed?: boolean;
    hidden?: string[];
    order?: string[];
    projectOrder?: string[];
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
  /**
   * 0.4.46: a terminal pane reconnects on its own after a drop: first
   * after reconnect_seconds (1), doubling to reconnect_max_seconds (30);
   * it stops after reconnect_max_failures (10) failed tries within
   * reconnect_window_seconds (300), with a Reconnect button. A try that
   * hasn't connected in connect_timeout_seconds (10) is a failed one.
   */
  /**
   * den#156: the Agents list's waits. `host_timeout_seconds` (10): how long
   * a list waits for the terminal host before it says it couldn't reach
   * it; `refresh_timeout_seconds` (15): how long the page waits for a list
   * before it says so and tries again.
   */
  agents_list?: {
    host_timeout_seconds?: unknown;
    refresh_timeout_seconds?: unknown;
  };
  /**
   * Issue 403: a filed report's screenshot, kept on this install.
   * `screenshot_keep_days` (30): how long, then the janitor deletes it.
   * `screenshot_max_mb` (8) the largest kept, `hub_screenshot_max_mb` (6)
   * the largest sent to Hub, `hub_timeout_seconds` (10) the wait for Hub.
   */
  reports?: {
    screenshot_keep_days?: unknown;
    screenshot_max_mb?: unknown;
    hub_screenshot_max_mb?: unknown;
    hub_timeout_seconds?: unknown;
  };
  /**
   * Issue 609: how long Den's process lookups (lsof, ps) wait:
   * first_seconds (5) the first try, retry_seconds (20) the one after
   * (ui/cli/proc-lookup.ts). DEN_LOOKUP_TIMEOUTS_MS overrides both.
   */
  process_lookup?: {
    first_seconds?: unknown;
    retry_seconds?: unknown;
  };
  /**
   * Issue 609: how an agent's hooks (its attention mark, the Hub inbox
   * check) call Den: timeout_seconds (20) a try, retries (2) after a
   * failed or refused try, backoff_seconds (1) the first pause, doubling
   * (agents/guardrails/hook-call.ts). Read at the agent's launch.
   */
  agent_hooks?: {
    timeout_seconds?: unknown;
    retries?: unknown;
    backoff_seconds?: unknown;
  };
  /**
   * Issue 278: agents stuck compacting and instruction files that eat the
   * context (context-watch.ts): compaction_loop_count (3) automatic
   * compactions within compaction_loop_minutes (10) ring the bell;
   * pause_after_loop (false) holds new deliveries until a person clears
   * it; instruction files over instruction_share_percent (15) of the
   * model's context (context_tokens, 200000, when Den doesn't know the
   * model's) warn.
   */
  agent_context?: {
    compaction_loop_count?: unknown;
    compaction_loop_minutes?: unknown;
    pause_after_loop?: unknown;
    instruction_share_percent?: unknown;
    context_tokens?: unknown;
  };
  panes?: {
    reconnect_seconds?: unknown;
    reconnect_max_seconds?: unknown;
    reconnect_max_failures?: unknown;
    reconnect_window_seconds?: unknown;
    connect_timeout_seconds?: unknown;
  };
  /**
   * FB (den#81): Report an issue. `enabled: false` hides every entry
   * point; `max_per_hour` (5) is how many one person sends in an hour.
   */
  feedback?: {
    enabled?: unknown;
    max_per_hour?: unknown;
    capture_seconds?: unknown;
    /** How many of the person's reports My reports shows (20, 1..100). */
    my_reports_max?: unknown;
    /**
     * Issue 415: how long a destination's visibility on GitHub is kept
     * (24 h, 0..720), and how long Report waits to learn it (3 s, 0.5..60).
     */
    visibility_cache_hours?: unknown;
    visibility_timeout_seconds?: unknown;
    /** How long a failed lookup is held before asking again (60 s, 0..3600). */
    visibility_retry_seconds?: unknown;
  };
  agents?: {
    runtimes?: Record<string, { bin?: unknown } | null>;
    /**
     * agents.git.signing_key: per machine, so user.yml's wins over the
     * distribution's (gate 0.4.44-dev.0: it was ignored here).
     */
    git?: unknown;
    /** More runtime catalog entries (AG-0.5, agents/catalog.ts). */
    runtime_catalog?: unknown;
    /**
     * AG-14.1b: forget stopped and exited agents after this long: never
     * (the default), 1d or 7d. Interrupted agents are never forgotten.
     */
    remove_stopped_after?: unknown;
    /**
     * 0.4.46: after the machine restarts, every agent that was running
     * comes back on its own conversation (true, the default).
     */
    restore_on_boot?: unknown;
    /**
     * Issue 163 (0.4.50): Settings › Keep agents running after logout.
     * true: `service install` runs Den as LaunchDaemons (mode always),
     * false: LaunchAgents (login). Unset: the mode already installed.
     */
    keep_running_after_logout?: unknown;
    /**
     * 0.4.46 MODE-UI: the install's mode for every agent (ask, edits, auto,
     * all): under the agent's own and its project's, over its persona's.
     */
    default_mode?: unknown;
    /** 0.4.46: how often Den looks for an agent whose mode changed (30 s). */
    mode_check_seconds?: unknown;
    /** Issue 659: how often Den looks for a folder-trust question (5 s). */
    trust_check_seconds?: unknown;
    /** 0.4.46: how long that restore waits for Hub first (120 s). */
    restore_hub_wait_seconds?: unknown;
    /**
     * Issue 456: how long Den waits for your shell's PATH, the login
     * shell's (`-lc`) and the interactive one's (`-ilc`), in seconds (10).
     */
    shell_path_timeout_seconds?: unknown;
    /** AG-4b: the Agents tab's layout (src/ui/server/agents-layout-pref.ts). */
    layout?: unknown;
    /** #80: running helpers an open badge shows (agents-layout-pref.ts). */
    helpers_shown?: unknown;
    /** Issue 96: the person's order for each project's agents (agents/order.ts). */
    order?: unknown;
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
 * 0.4.46 agents.restore_on_boot (user.yml, true when unset): after the
 * machine restarts, every agent that was running comes back, not only
 * standing personas and those with resume_on_restart.
 */
export function agentsRestoreOnBoot(
  read: () => UserConfig = readUserConfig,
): boolean {
  const v = read().agents?.restore_on_boot;
  if (v === undefined || v === null) return true;
  if (typeof v === "boolean") return v;
  throw new Error(
    `agents.restore_on_boot must be true or false (user.yml; got ${JSON.stringify(v)})`,
  );
}

/**
 * D64 ui.restart_wait_seconds (user.yml, 90): how long a restart may take.
 * Restart Den waits this long; issue 163's "ran while you were away" note
 * is for an absence longer than it.
 */
export function uiRestartWaitSeconds(
  read: () => UserConfig = readUserConfig,
): number {
  try {
    const v = Number(read().ui?.restart_wait_seconds);
    return Number.isFinite(v) && v > 0 ? v : 90;
  } catch {
    return 90;
  }
}

/**
 * Issue 163 (0.4.50) agents.keep_running_after_logout (user.yml): true or
 * false when the person set it, undefined when unset (install then keeps
 * the mode already installed). Off is the default the page shows.
 */
export function agentsKeepRunningAfterLogout(
  read: () => UserConfig = readUserConfig,
): boolean | undefined {
  const v = read().agents?.keep_running_after_logout;
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  throw new Error(
    `agents.keep_running_after_logout must be true or false (user.yml; got ${JSON.stringify(v)})`,
  );
}

/**
 * 0.4.46 agents.default_mode (user.yml): the install's mode for every
 * agent, or undefined when unset. A bad value is refused, naming the key.
 */
export function agentsDefaultMode(
  read: () => UserConfig = readUserConfig,
): PermissionIntent | undefined {
  const v = read().agents?.default_mode;
  if (v === undefined || v === null) return undefined;
  return checkIntent(v, "agents.default_mode (user.yml)");
}

/** web.url_check_seconds (user.yml): how long Check and save waits (10). */
export function webUrlCheckSeconds(
  read: () => UserConfig = readUserConfig,
): number {
  let v: unknown;
  try {
    const w = read().web as Record<string, unknown> | undefined;
    v = w && typeof w === "object" ? w.url_check_seconds : undefined;
  } catch {
    return 10;
  }
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? v : 10;
}

/** One panes.<key> number (user.yml): `dflt` when unset, at least `min`. */
function panesNumber(
  read: () => UserConfig,
  key: keyof NonNullable<UserConfig["panes"]>,
  dflt: number,
  min: number,
): number {
  const v = read().panes?.[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v === "number" && Number.isFinite(v) && v >= min) return v;
  throw new Error(
    `panes.${String(key)} must be a number, at least ${min} (user.yml; got ${JSON.stringify(v)})`,
  );
}

/**
 * den#156: the Agents list's waits (user.yml agents_list.*), in seconds,
 * as GET /api/settings gives the page (agents_list). A wrong value throws.
 */
export function agentsListWaits(read: () => UserConfig = readUserConfig): {
  host_timeout_seconds: number;
  refresh_timeout_seconds: number;
} {
  const b = read().agents_list ?? {};
  const one = (
    k: "host_timeout_seconds" | "refresh_timeout_seconds",
    d: number,
  ) => {
    const v = b[k];
    if (v === undefined || v === null) return d;
    if (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 600)
      return v;
    throw new Error(
      `agents_list.${k} must be a number from 1 to 600 (user.yml; got ${JSON.stringify(v)})`,
    );
  };
  return {
    host_timeout_seconds: one("host_timeout_seconds", 10),
    refresh_timeout_seconds: one("refresh_timeout_seconds", 15),
  };
}

/**
 * 0.4.46: how a terminal pane reconnects on its own (user.yml panes.*),
 * as GET /api/settings gives the page (panes_reconnect).
 */
export function panesReconnect(read: () => UserConfig = readUserConfig): {
  seconds: number;
  max_seconds: number;
  max_failures: number;
  window_seconds: number;
  connect_timeout_seconds: number;
} {
  return {
    seconds: panesNumber(read, "reconnect_seconds", 1, 0.1),
    max_seconds: panesNumber(read, "reconnect_max_seconds", 30, 0.1),
    max_failures: panesNumber(read, "reconnect_max_failures", 10, 1),
    window_seconds: panesNumber(read, "reconnect_window_seconds", 300, 1),
    connect_timeout_seconds: panesNumber(
      read,
      "connect_timeout_seconds",
      10,
      1,
    ),
  };
}

/** agents.mode_check_seconds (user.yml): 30 when unset, at least 5. */
export function agentsModeCheckSeconds(
  read: () => UserConfig = readUserConfig,
): number {
  const v = read().agents?.mode_check_seconds;
  if (v === undefined || v === null) return 30;
  if (typeof v === "number" && Number.isFinite(v) && v >= 5) return v;
  throw new Error(
    `agents.mode_check_seconds must be a number, at least 5 (user.yml; got ${JSON.stringify(v)})`,
  );
}

/**
 * Issue 659: agents.trust_check_seconds (user.yml): how often Den looks
 * for an agent whose runtime asks to trust its folder. 5 when unset, at
 * least 1.
 */
export function agentsTrustCheckSeconds(
  read: () => UserConfig = readUserConfig,
): number {
  const v = read().agents?.trust_check_seconds;
  if (v === undefined || v === null) return 5;
  if (typeof v === "number" && Number.isFinite(v) && v >= 1) return v;
  throw new Error(
    `agents.trust_check_seconds must be a number, at least 1 (user.yml; got ${JSON.stringify(v)})`,
  );
}

/** Issue 456: agents.shell_path_timeout_seconds when unset, and its range. */
export const SHELL_PATH_TIMEOUT = { default: 10, min: 1, max: 120 } as const;

/**
 * Issue 456: agents.shell_path_timeout_seconds (user.yml), how long Den
 * waits for the login and the interactive shell's PATH: 10 when unset,
 * 1 to 120. A wrong value throws, naming the key.
 */
export function agentsShellPathTimeoutSeconds(
  read: () => UserConfig = readUserConfig,
): number {
  const v = read().agents?.shell_path_timeout_seconds;
  if (v === undefined || v === null) return SHELL_PATH_TIMEOUT.default;
  if (
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= SHELL_PATH_TIMEOUT.min &&
    v <= SHELL_PATH_TIMEOUT.max
  )
    return v;
  throw new Error(
    `agents.shell_path_timeout_seconds must be a number from ${SHELL_PATH_TIMEOUT.min} to ${SHELL_PATH_TIMEOUT.max} (user.yml; got ${JSON.stringify(v)})`,
  );
}

/**
 * The shell PATH wait in ms for a caller that must never fail (the
 * server's start, detection): a wrong value is the default.
 */
export function shellPathTimeoutMs(
  read: () => UserConfig = readUserConfig,
): number {
  try {
    return agentsShellPathTimeoutSeconds(read) * 1000;
  } catch {
    return SHELL_PATH_TIMEOUT.default * 1000;
  }
}

/** agents.restore_hub_wait_seconds (user.yml): 120 when unset, at least 0. */
export function agentsRestoreHubWaitSeconds(
  read: () => UserConfig = readUserConfig,
): number {
  const v = read().agents?.restore_hub_wait_seconds;
  if (v === undefined || v === null) return 120;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  throw new Error(
    `agents.restore_hub_wait_seconds must be a number, at least 0 (user.yml; got ${JSON.stringify(v)})`,
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

/**
 * Write the per-engineer user config to config/local/user.yml, whole (#380):
 * Den's server, a CLI and an agent's start read it while it is written.
 */
export function writeUserConfig(cfg: UserConfig): void {
  fs.mkdirSync(path.dirname(USER_CONFIG_PATH), { recursive: true });
  const lines = [
    "# Per-engineer preferences — gitignored, never committed",
    yaml.stringify(cfg).trimEnd(),
  ];
  writeFileAtomic(USER_CONFIG_PATH, lines.join("\n") + "\n");
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
function asConfigError<T>(
  read: () => T,
  file: string = product().configFile,
): T {
  try {
    return read();
  } catch (e) {
    if (isConfigError(e) || !(e instanceof Error)) throw e;
    const text = e.message.replace(/\s*\(got [\s\S]*\)$/, "");
    const at = text.indexOf(": ");
    const key = at > 0 ? text.slice(0, at) : text.split(/\s/)[0];
    const message = at > 0 ? text.slice(at + 2) : text;
    throw new ConfigError([{ file, key, message, text }]);
  }
}

/**
 * The ConfigError of one section (`agents:` or `sessions:`), or null.
 * Scoped to it: a typo there stops only the agent and session commands
 * and routes (and the Agents page), never services, logs, tests or the
 * edge. A file that can't be read is left to readDenConfig's callers.
 */
export function sectionConfigError(
  section: "agents" | "sessions" | "web",
): ConfigError | null {
  let config: DenConfig;
  try {
    config = readDenConfig();
  } catch {
    return null;
  }
  try {
    if (section === "agents") readAgentsConfig(config, readUserConfigQuiet());
    else if (section === "web") readWebKeepAliveSeconds(config);
    else readSessionsConfig(config);
    return null;
  } catch (e) {
    if (isConfigError(e)) return e;
    // #257: web's own checks throw a plain Error naming the key.
    if (section === "web" && e instanceof Error)
      return new ConfigError(e.message);
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
      server_agent: parsed?.server_agent,
      agents: parsed?.agents,
      sessions: parsed?.sessions,
      web: parsed?.web,
      test_accounts: parsed?.test_accounts,
      defaults: parsed?.defaults,
      secrets: parsed?.secrets,
      // 0.4.45: the Hub editions under Connect (shared/hub-editions.ts):
      // the distribution's den.yml (as the docs say), else this file.
      hub_editions: denYmlKey("hub_editions") ?? parsed?.hub_editions,
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
 * A top-level key of the distribution's own den.yml (beside `product:`),
 * read fresh; undefined when the file or the key is missing or unreadable.
 */
function denYmlKey(key: string): unknown {
  try {
    const doc = yaml.parse(
      fs.readFileSync(path.join(ROOT, "den.yml"), "utf-8"),
    ) as Record<string, unknown> | null;
    return doc && typeof doc === "object" ? doc[key] : undefined;
  } catch {
    return undefined;
  }
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

/** SRV-1a: `server_agent:` in the org config. */
export interface ServerAgentConfig {
  self_update?: "ask" | "auto";
  /**
   * SRV-1b: the server agent's folder, relative to the distribution root
   * (default: the root itself, the distribution's own repo).
   */
  folder?: string;
  /** SRV-1b: how its commits leave: a pull request (default) or a push. */
  git?: "pr" | "push";
  /**
   * SRV-1b: how long den_update waits for the new version to come up
   * before it rolls back (seconds, default 180).
   */
  update_wait_seconds?: number;
  /**
   * Gate 0.4.44: how often its page checks for the runtime's trust
   * prompt while it shows (seconds, default 2; 0.5 to 60).
   */
  prompt_check_seconds?: number;
  /**
   * SRV-P6 (0.4.48): how often Den looks at npm for a newer Den, in
   * minutes (default 30; 0: never).
   */
  update_check_minutes?: number;
  /**
   * #251: passes in a row an update waits on the person (the server agent
   * at a permission prompt or a question, a held Allow) before its bell
   * item counts as needing them (default 2).
   */
  update_wait_checks?: number;
  /**
   * #176: after a verified self-update, the lead install commits the new
   * pin (package.json, package-lock.json) and pushes it to the branch's
   * upstream: push (default), pr (its own branch and a pull request), or
   * off (left to the server agent).
   */
  pin_commit?: "push" | "pr" | "off";
  /**
   * Issue 562: a release npm marks a security release (den.security in
   * its package.json) updates while the server agent waits on its
   * person's question or permission prompt; never past a pending Allow,
   * never mid-turn (default true; false: it waits, as any release).
   */
  security_update_skips_questions?: boolean;
  /**
   * Issue 603: a security release also installs while the server agent
   * is mid-turn; its restart still waits for the turn to end (default
   * true; false: it waits for the turn before it installs).
   */
  security_update_skips_busy?: boolean;
  /**
   * Issue 562 review: once an auto update is installed, how long its
   * restart waits for the server agent's turn to end (or a pending Allow)
   * before it restarts anyway (seconds, default 900; 0: no wait).
   */
  update_restart_wait_seconds?: number;
}

export interface ResolvedServerAgentConfig {
  /**
   * ask: held for the person's Allow; auto: runs at once. The person's
   * (user.yml) only: review M4 (0.4.46), the team file sits where the
   * server agent works, so it can't switch on its own Allow.
   */
  selfUpdate: "ask" | "auto";
  /**
   * SRV-P6 (0.4.48): where selfUpdate came from: the person's user.yml,
   * the org config (not yet copied to user.yml), or the default (ask).
   */
  selfUpdateFrom: "user" | "org" | "default";
  /**
   * The team file sets self_update and the person's user.yml does too:
   * the team file's is ignored (doctor says so).
   */
  teamSelfUpdateIgnored: boolean;
  /** SRV-1b: its folder, absolute (an existing directory). */
  folder: string;
  /** SRV-1b: pr (the default) or push. */
  git: "pr" | "push";
  /** SRV-1b: den_update's wait for the new version, in ms. */
  updateWaitMs: number;
  /** Gate 0.4.44: the page's trust prompt check, in ms. */
  promptCheckMs: number;
  /** SRV-P6: how often Den looks at npm, in ms; 0: never. */
  updateCheckMs: number;
  /** SRV-P6 / LEAD-1: lead (default) or follower, from user.yml. */
  role: "lead" | "follower";
  /** #251: server_agent.update_wait_checks. */
  updateWaitChecks: number;
  /** #176: server_agent.pin_commit: push (default), pr or off. */
  pinCommit: "push" | "pr" | "off";
  /** Issue 562: server_agent.security_update_skips_questions. */
  securityUpdateSkipsQuestions: boolean;
  /** Issue 603: server_agent.security_update_skips_busy. */
  securityUpdateSkipsBusy: boolean;
  /** Issue 562 review: server_agent.update_restart_wait_seconds, in ms. */
  updateRestartWaitMs: number;
}

/** Issue 562 review: server_agent.update_restart_wait_seconds when unset. */
export const UPDATE_RESTART_WAIT_SECONDS_DEFAULT = 900;

/** #251: server_agent.update_wait_checks when unset. */
export const UPDATE_WAIT_CHECKS_DEFAULT = 2;

/** SRV-P6: server_agent.update_check_minutes when unset. */
export const UPDATE_CHECK_MINUTES_DEFAULT = 30;

/** Gate 0.4.44: how often the page checks for the trust prompt (seconds). */
export const PROMPT_CHECK_SECONDS_DEFAULT = 2;

/** SRV-1b: den_update's default wait for the new version (seconds). */
export const UPDATE_WAIT_SECONDS_DEFAULT = 180;

/** SRV-1a/1b: `server_agent`, checked. A bad value throws naming its key. */
export function readServerAgentConfig(
  config: DenConfig = readDenConfig(),
  root: string = getDistRoot(),
  user: UserConfig = readUserConfig(),
): ResolvedServerAgentConfig {
  const sa = config.server_agent ?? {};
  const v = user.server_agent?.self_update;
  if (v !== undefined && v !== "ask" && v !== "auto")
    throw new Error(
      `server_agent.self_update (user.yml): ask or auto, not ${JSON.stringify(v)}`,
    );
  const g = sa.git;
  if (g !== undefined && g !== "pr" && g !== "push")
    throw new Error(`server_agent.git: pr or push, not ${JSON.stringify(g)}`);
  const f = sa.folder;
  if (f !== undefined && (typeof f !== "string" || !f.trim()))
    throw new Error(
      `server_agent.folder: a folder, relative to the distribution root (got ${JSON.stringify(f)})`,
    );
  const folder = path.resolve(root, f?.trim() || ".");
  if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`server_agent.folder: ${folder} is not a folder`);
  const w = sa.update_wait_seconds;
  if (
    w !== undefined &&
    (typeof w !== "number" || !Number.isFinite(w) || w < 10)
  )
    throw new Error(
      `server_agent.update_wait_seconds: seconds, 10 or more (got ${JSON.stringify(w)})`,
    );
  const pc = sa.prompt_check_seconds;
  if (
    pc !== undefined &&
    (typeof pc !== "number" || !Number.isFinite(pc) || pc < 0.5 || pc > 60)
  )
    throw new Error(
      `server_agent.prompt_check_seconds: seconds, 0.5 to 60 (got ${JSON.stringify(pc)})`,
    );
  const uc = sa.update_check_minutes;
  if (
    uc !== undefined &&
    (typeof uc !== "number" || !Number.isFinite(uc) || (uc !== 0 && uc < 5))
  )
    throw new Error(
      `server_agent.update_check_minutes: minutes, 5 or more, or 0 for never (got ${JSON.stringify(uc)})`,
    );
  const wc = sa.update_wait_checks;
  if (
    wc !== undefined &&
    (typeof wc !== "number" || !Number.isInteger(wc) || wc < 1)
  )
    throw new Error(
      `server_agent.update_wait_checks: a whole number, 1 or more (got ${JSON.stringify(wc)})`,
    );
  const pcm = sa.pin_commit;
  if (pcm !== undefined && pcm !== "push" && pcm !== "pr" && pcm !== "off")
    throw new Error(
      `server_agent.pin_commit: push, pr or off, not ${JSON.stringify(pcm)}`,
    );
  const ssq = sa.security_update_skips_questions;
  if (ssq !== undefined && typeof ssq !== "boolean")
    throw new Error(
      `server_agent.security_update_skips_questions: true or false, not ${JSON.stringify(ssq)}`,
    );
  const ssb = sa.security_update_skips_busy;
  if (ssb !== undefined && typeof ssb !== "boolean")
    throw new Error(
      `server_agent.security_update_skips_busy: true or false, not ${JSON.stringify(ssb)}`,
    );
  const rw = sa.update_restart_wait_seconds;
  if (
    rw !== undefined &&
    (typeof rw !== "number" || !Number.isFinite(rw) || rw < 0)
  )
    throw new Error(
      `server_agent.update_restart_wait_seconds: seconds, 0 or more (got ${JSON.stringify(rw)})`,
    );
  const role = user.server_agent?.role;
  if (role !== undefined && role !== "lead" && role !== "follower")
    throw new Error(
      `server_agent.role (user.yml): lead or follower, not ${JSON.stringify(role)}`,
    );
  // 0.4.48: until Den's first start copies the team file's choice to
  // user.yml (migrateSelfUpdate), that choice holds: never a silent ask.
  const t = sa.self_update;
  const pending = v === undefined && (t === "ask" || t === "auto");
  return {
    selfUpdate: v ?? (pending ? t : "ask"),
    selfUpdateFrom: v !== undefined ? "user" : pending ? "org" : "default",
    teamSelfUpdateIgnored: v !== undefined && t !== undefined,
    folder,
    git: g ?? "pr",
    updateWaitMs: Math.round((w ?? UPDATE_WAIT_SECONDS_DEFAULT) * 1000),
    promptCheckMs: Math.round((pc ?? PROMPT_CHECK_SECONDS_DEFAULT) * 1000),
    updateCheckMs: Math.round((uc ?? UPDATE_CHECK_MINUTES_DEFAULT) * 60_000),
    role: role ?? "lead",
    updateWaitChecks: wc ?? UPDATE_WAIT_CHECKS_DEFAULT,
    pinCommit: pcm ?? "push",
    securityUpdateSkipsQuestions: ssq ?? true,
    securityUpdateSkipsBusy: ssb ?? true,
    updateRestartWaitMs: Math.round(
      (rw ?? UPDATE_RESTART_WAIT_SECONDS_DEFAULT) * 1000,
    ),
  };
}

/**
 * Review M4 (0.4.48): server_agent.self_update is the person's, in
 * user.yml. Once, at Den's first start without it there: the team
 * file's ask or auto is copied (with where from), else ask is written, so
 * a value an agent adds to the team file later does nothing. One audit
 * row. Null when user.yml has it already, or the team file's value is
 * neither (doctor names it; nothing is guessed).
 */
export function migrateSelfUpdate(
  config: DenConfig = readDenConfig(),
  d: {
    read?: () => UserConfig;
    merge?: (p: Partial<UserConfig>) => unknown;
    audit?: (r: ConfigAuditRow) => void;
    at?: Date;
  } = {},
): { value: "ask" | "auto"; from: "team" | "default" } | null {
  const read = d.read ?? readUserConfig;
  const merge = d.merge ?? mergeUserConfig;
  const audit = d.audit ?? auditConfig;
  const user = read();
  const had = user.server_agent ?? {};
  if (had.self_update !== undefined) return null;
  const t = config.server_agent?.self_update;
  if (t !== undefined && t !== "ask" && t !== "auto") return null;
  const file = product().configFile;
  const day = (d.at ?? new Date()).toISOString().slice(0, 10);
  const value = t ?? "ask";
  const from = t ? "team" : "default";
  merge({
    server_agent: {
      ...had,
      self_update: value,
      ...(t ? { self_update_from: `${file}, ${day}` } : {}),
    },
  });
  audit({
    verb: "config-write",
    detail: t
      ? `server_agent.self_update: ${value}, copied from ${file} to config/local/user.yml (it is the person's from 0.4.48; the value in ${file} does nothing now)`
      : `server_agent.self_update: ask written to config/local/user.yml (the default; it is the person's from 0.4.48, set in that file)`,
  });
  return { value, from };
}

/** `mcp:` in the org config. */
export interface McpConfig {
  /** Action tools to register; none when absent. */
  actions?: string[];
  /** Environments `run_tests` may target (default [local]; production never). */
  run_tests?: { envs?: string[] };
  /** `remote: true` lets the log tools read non-local sources (e.g. CloudWatch). */
  logs?: { remote?: boolean };
  /**
   * The held writes (workspace_create, repo_add, service_try,
   * den_restart_server): on by
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
   * `{ active_minutes, row_max }`. A helper with no activity for
   * `active_minutes` (default 10) and not known done shows idle; at most
   * `row_max` (default 4) active ones list under the selected agent's row
   * (D34). `collapse_done_minutes` is deprecated (0.4.29) and ignored.
   */
  helpers?: {
    active_minutes?: unknown;
    row_max?: unknown;
    collapse_done_minutes?: unknown;
  };
  /**
   * den#3: `{ model }`, the model agents' subagents run on (default
   * sonnet; `inherit`: the runtime decides). A persona's `subagent_model`
   * wins (agents/subagents.ts).
   */
  subagents?: { model?: unknown };
  /** den#3: load the account's claude.ai connectors (default false). */
  claude_ai_connectors?: unknown;
  /**
   * D39: how far back from its end an agent's transcript is read to tell
   * whether it is mid-turn, in MB (default 8). Past it, Den can't tell.
   */
  turn_read_max_mb?: unknown;
  /**
   * 0.4.45: minutes an exited shell with nothing unread stays listed
   * before it leaves by itself (default 10; 0: never, it stays until
   * removed).
   */
  exited_shell_minutes?: unknown;
  /**
   * AG-DROP: files dropped or pasted onto an agent's terminal,
   * `{ max_bytes, keep_days, dir }` (defaults 25 MB, 7 days,
   * `<state>/uploads`).
   */
  uploads?: { max_bytes?: unknown; keep_days?: unknown; dir?: unknown };
  /**
   * 0.4.46: container engines beyond Den's defaults whose CLI an api_only
   * service's guardrail treats as Docker's, and their folders:
   * `{ clis: [...], dirs: [...] }` (agents/api-only.ts).
   */
  api_only_engines?: { clis?: unknown; dirs?: unknown };
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
/** 0.4.48: agents.restart_wait_minutes when unset (a long gate runs ~1 h). */
export const RESTART_WAIT_MINUTES_DEFAULT = 120;

/**
 * Issue 926: agents.unasked_exit_window_minutes when unset: an agent whose
 * session ends without Den asking is brought back once in this window.
 */
export const UNASKED_EXIT_WINDOW_MINUTES_DEFAULT = 10;

/** Issue 242: agents.token_peer_wait_ms when unset (the lookups' own limits fit). */
export const TOKEN_PEER_WAIT_MS_DEFAULT = 30_000;

export const AGENTS_RESERVED_KEYS = [
  "max_concurrent",
  // #70: an agent's token only from its own processes.
  "token_binding",
  // Issue 242: how long an agent's call waits for Den to find its process.
  "token_peer_wait_ms",
  "persona_packs",
  "runtime_catalog",
  "default_pack",
  "rotate",
  // D32: how helpers show.
  "helpers",
  // D39: how far back the mid-turn check reads.
  "turn_read_max_mb",
  "restart_wait_minutes",
  // Issue 926: bring back an agent whose session ended without Den asking.
  "unasked_exit_window_minutes",
  // Issue 218: how long a change waits for another process's on one agent.
  "lock_wait_minutes",
  // 0.4.45: how long an exited shell stays listed.
  "exited_shell_minutes",
  // AG-DROP: files dropped onto an agent's terminal.
  "uploads",
  // 0.4.46: engines the api_only guardrail treats as Docker's.
  "api_only_engines",
  // AG-DROP-2: files an agent's links and downloads never reach.
  "files",
  // AG-10.5, AG-11.1: the distribution's persona categories and roles.
  "categories",
  "roles",
  // den#3: subagents' model; the account's claude.ai connectors.
  "subagents",
  "claude_ai_connectors",
];

/**
 * `agents.git` is the git settings when it isn't an agent's block: any
 * key other than grants (signing_key, or a typo gitSigningBlock names).
 */
function isGitSettings(block: unknown): boolean {
  return isMapping(block) && Object.keys(block).some((k) => k !== "grants");
}

/** One agent's own block, `agents.<id>`. */
export interface AgentGrantsConfig {
  /** Workspaces beyond its own that its MCP serves. */
  grants: string[];
}

/** `agents:` with its defaults applied. */
export interface ResolvedAgentsConfig {
  maxConcurrent: number;
  /**
   * #70: an agent's token counts only from its own session's processes
   * (agents.token_binding, default true). false: from any process here.
   */
  tokenBinding?: boolean;
  /**
   * Issue 242: agents.token_peer_wait_ms (default
   * TOKEN_PEER_WAIT_MS_DEFAULT): how long an agent's call waits for Den to
   * find the process that made it before refusing it as unknown.
   */
  tokenPeerWaitMs?: number;
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
  /** agents.git: the key agents Den starts sign commits with (unset: none). */
  git?: AgentGitSettings;
  /** agents.helpers (D32) with its defaults. */
  helpers?: HelperSettings;
  /** agents.turn_read_max_mb (D39) in bytes; unset: the default. */
  turnReadMaxBytes?: number;
  /**
   * 0.4.48: agents.restart_wait_minutes (default 120): how long "after its
   * turn" (Restart, a move, a persona change, Den's own restarts) waits for
   * the turn and any job the agent left running. Out of time, Den's own
   * restart is skipped and tried later; nothing is ever cut off.
   */
  restartWaitMs: number;
  /**
   * Issue 926: agents.unasked_exit_window_minutes (default 10). An agent
   * whose session ends without Den asking (not exit 0) is brought back
   * once; a second such exit within this window is told, not brought
   * back. 0: never brought back (still recorded and told).
   */
  unaskedExitWindowMs: number;
  /**
   * Issue 218: agents.lock_wait_minutes (default LOCK_WAIT_MINUTES_DEFAULT):
   * how long a change to an agent waits while another process changes it.
   * Unset: the default.
   */
  lockWaitMs?: number;
  /** agents.exited_shell_minutes; unset: DEFAULT_EXITED_SHELL_MINUTES. */
  exitedShellMinutes?: number;
  /** agents.uploads (AG-DROP) with its defaults. */
  uploads?: UploadSettings;
  /** agents.files (AG-DROP-2) with its defaults. */
  files?: FileSettings;
  /** agents.categories (AG-10.5): the distribution's, after Den's. */
  categories?: Category[];
  /** agents.roles (AG-11.1): new roles and Den roles' preset extensions. */
  roles?: RolesConfig;
  /** den#3: agents.subagents and agents.claude_ai_connectors, defaults applied. */
  subagents?: SubagentSettings;
}

/** `agents.helpers` (D32) checked; a bad key or value throws naming it. */
export function helpersBlock(v: unknown): HelperSettings {
  const out = { ...HELPER_DEFAULTS };
  if (v === undefined || v === null) return out;
  if (!isMapping(v))
    throw new Error(
      `agents.helpers: must be a mapping of active_minutes, row_max, read_max_mb (got ${JSON.stringify(v)})`,
    );
  for (const [k, x] of Object.entries(v)) {
    if (k === "row_max") {
      if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > 1000)
        throw new Error(
          `agents.helpers.row_max: must be a whole number from 1 to 1000 (got ${JSON.stringify(x)})`,
        );
      out.rowMax = x;
      continue;
    }
    if (k === "read_max_mb") {
      if (typeof x !== "number" || !Number.isFinite(x) || x <= 0 || x > 4096)
        throw new Error(
          `agents.helpers.read_max_mb: must be a number of MB, above 0 and at most 4096 (got ${JSON.stringify(x)})`,
        );
      out.readMaxMb = x;
      continue;
    }
    // collapse_done_minutes: deprecated (0.4.29), still checked, ignored.
    const key =
      k === "active_minutes"
        ? "activeMinutes"
        : k === "collapse_done_minutes"
          ? "collapseDoneMinutes"
          : null;
    if (!key)
      throw new Error(
        `agents.helpers.${k}: unknown key (agents.helpers takes active_minutes, row_max, read_max_mb)`,
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
/** How long an exited shell with nothing unread stays listed (0.4.45). */
export const DEFAULT_EXITED_SHELL_MINUTES = 10;

export function readAgentsConfig(
  config?: DenConfig,
  /** user.yml (default: read only when `config` is Den's own, unpassed). */
  user?: UserConfig,
): ResolvedAgentsConfig {
  const c = config ?? readDenConfig();
  const u = user ?? (config ? {} : readUserConfigQuiet());
  const out = asConfigError(() => parseAgentsConfig(c));
  // A signing key is per machine: user.yml's agents.git wins.
  const mine = u.agents?.git;
  if (mine !== undefined && mine !== null) {
    const g = asConfigError(
      () => gitSigningBlock(mine),
      path.relative(ROOT, USER_CONFIG_PATH),
    );
    if (g) out.git = g;
  }
  return out;
}

/** user.yml, or {} when it can't be read (a bad one is its own row). */
function readUserConfigQuiet(): UserConfig {
  try {
    return readUserConfig();
  } catch {
    return {};
  }
}

function parseAgentsConfig(config: DenConfig): ResolvedAgentsConfig {
  const raw = (config.agents ?? {}) as unknown;
  if (!isMapping(raw))
    throw new Error(`agents: must be a mapping (got ${JSON.stringify(raw)})`);
  const tb = (raw as { token_binding?: unknown }).token_binding;
  if (tb !== undefined && typeof tb !== "boolean")
    throw new Error(
      `agents.token_binding: true or false (got ${JSON.stringify(tb)})`,
    );
  const pw = (raw as { token_peer_wait_ms?: unknown }).token_peer_wait_ms;
  if (
    pw !== undefined &&
    (typeof pw !== "number" || !Number.isInteger(pw) || pw < 0 || pw > 600_000)
  )
    throw new Error(
      `agents.token_peer_wait_ms: a whole number of ms from 0 to 600000 (got ${JSON.stringify(pw)})`,
    );
  const out: ResolvedAgentsConfig = {
    maxConcurrent: DEFAULT_AGENTS_MAX_CONCURRENT,
    restartWaitMs: RESTART_WAIT_MINUTES_DEFAULT * 60_000,
    unaskedExitWindowMs: UNASKED_EXIT_WINDOW_MINUTES_DEFAULT * 60_000,
    tokenBinding: tb !== false,
    tokenPeerWaitMs: typeof pw === "number" ? pw : TOKEN_PEER_WAIT_MS_DEFAULT,
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
  // agents.git, unless it is an agent called git (a block with grants).
  const gitBlock = isGitSettings(raw.git) ? raw.git : undefined;
  out.git = gitSigningBlock(gitBlock);
  if (!out.git) delete out.git;
  out.uploads = uploadsBlock(raw.uploads);
  out.files = filesBlock(raw.files);
  out.subagents = subagentsBlock(raw.subagents, raw.claude_ai_connectors);
  const turnMb = raw.turn_read_max_mb;
  if (turnMb !== undefined && turnMb !== null) {
    if (
      typeof turnMb !== "number" ||
      !Number.isFinite(turnMb) ||
      turnMb <= 0 ||
      turnMb > 4096
    )
      throw new Error(
        `agents.turn_read_max_mb: must be a number of MB, above 0 and at most 4096 (got ${JSON.stringify(turnMb)})`,
      );
    out.turnReadMaxBytes = Math.round(turnMb * 1024 * 1024);
  }
  const rw = raw.restart_wait_minutes;
  if (rw !== undefined && rw !== null) {
    if (typeof rw !== "number" || !Number.isFinite(rw) || rw <= 0)
      throw new Error(
        `agents.restart_wait_minutes: minutes, above 0 (got ${JSON.stringify(rw)})`,
      );
    out.restartWaitMs = Math.round(rw * 60_000);
  }
  const uw = raw.unasked_exit_window_minutes;
  if (uw !== undefined && uw !== null) {
    if (typeof uw !== "number" || !Number.isFinite(uw) || uw < 0)
      throw new Error(
        `agents.unasked_exit_window_minutes: minutes, 0 or more (got ${JSON.stringify(uw)})`,
      );
    out.unaskedExitWindowMs = Math.round(uw * 60_000);
  }
  const lw = raw.lock_wait_minutes;
  if (lw !== undefined && lw !== null) {
    if (typeof lw !== "number" || !Number.isFinite(lw) || lw <= 0)
      throw new Error(
        `agents.lock_wait_minutes: minutes, above 0 (got ${JSON.stringify(lw)})`,
      );
    out.lockWaitMs = Math.round(lw * 60_000);
  }
  const exitedMin = raw.exited_shell_minutes;
  if (exitedMin !== undefined && exitedMin !== null) {
    if (
      typeof exitedMin !== "number" ||
      !Number.isFinite(exitedMin) ||
      exitedMin < 0
    )
      throw new Error(
        `agents.exited_shell_minutes: must be a number of minutes, 0 or more (0: never) (got ${JSON.stringify(exitedMin)})`,
      );
    out.exitedShellMinutes = exitedMin;
  }
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
    if (id === "git" && isGitSettings(block)) continue;
    const where = `agents.${id}`;
    if (!AGENT_KEY_RE.test(id) || !isMapping(block))
      throw new Error(
        `${where}: unknown key (agents: takes max_concurrent, token_binding, persona_packs, runtime_catalog, default_pack, rotate, helpers, uploads, subagents, claude_ai_connectors, categories, roles, ` +
          `or an agent id mapping to { grants: [...] })`,
      );
    for (const k of Object.keys(block))
      if (k !== "grants")
        throw new Error(`${where}.${k}: unknown key (an agent takes grants)`);
    const grants = block.grants ?? [];
    if (!Array.isArray(grants))
      throw new Error(
        `${where}.grants: must be a list of project names (got ${JSON.stringify(grants)})`,
      );
    grants.forEach((g, i) => {
      if (typeof g !== "string" || !AGENT_KEY_RE.test(g))
        throw new Error(
          `${where}.grants[${i}]: ${JSON.stringify(g)} is not a project name`,
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
  /**
   * How long a shell has to end after HUP (closing it from the page, or
   * `sessions kill` with no --signal) before it gets KILL (default 5).
   */
  close_grace_seconds?: number;
  /**
   * Issue 503: how long after a process exits its PTY closes, in seconds
   * (default 0: at once). Its scrollback stays readable either way.
   */
  pty_close_seconds?: number;
  /** Issue 503: doctor fails above this many PTYs held by the host (400). */
  pty_warn_above?: number;
  /**
   * Issue 503: doctor fails when the machine's PTYs in use reach this
   * percent of its limit (90).
   */
  pty_machine_warn_percent?: number;
  /**
   * Issue 563: how long the web server waits for agents mid-turn before it
   * restarts a terminal host that isn't current with the installed Den
   * (default 900); then it restarts anyway.
   */
  host_restart_wait_seconds?: number;
  /**
   * Issue 597: an agent the terminal host's restart cut mid-turn gets one
   * line on resume, to check its last step and carry on (default true).
   */
  host_restart_note?: boolean;
  /**
   * Issue 631: how long after a terminal host restart's resumes Den looks
   * for agents that ended since (a resume that didn't hold counts as
   * failed, and the bell says so) (default 30; 0: no look).
   */
  host_restart_check_seconds?: number;
}

export const DEFAULT_SESSIONS_MAX_CONCURRENT = 8;
export const DEFAULT_HOST_RESTART_WAIT_SECONDS = 900;
export const DEFAULT_HOST_RESTART_CHECK_SECONDS = 30;
export const DEFAULT_PTY_WARN_ABOVE = 400;
export const DEFAULT_PTY_MACHINE_WARN_PERCENT = 90;

/** `sessions:` with its defaults applied. */
export interface ResolvedSessionsConfig {
  maxConcurrent: number;
  closeGraceSeconds: number;
  ptyCloseSeconds: number;
  ptyWarnAbove: number;
  ptyMachineWarnPercent: number;
  hostRestartWaitSeconds: number;
  hostRestartNote: boolean;
  hostRestartCheckSeconds: number;
}

const SESSIONS_KEYS = [
  "max_concurrent",
  "close_grace_seconds",
  "pty_close_seconds",
  "pty_warn_above",
  "pty_machine_warn_percent",
  "host_restart_wait_seconds",
  "host_restart_note",
  "host_restart_check_seconds",
];

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
    if (!SESSIONS_KEYS.includes(k))
      throw new Error(
        `sessions.${k}: unknown key (sessions: takes ${SESSIONS_KEYS.join(", ")})`, // words-ok: the config key is sessions:
      );
  const out: ResolvedSessionsConfig = {
    maxConcurrent: DEFAULT_SESSIONS_MAX_CONCURRENT,
    closeGraceSeconds: 5,
    ptyCloseSeconds: 0,
    ptyWarnAbove: DEFAULT_PTY_WARN_ABOVE,
    ptyMachineWarnPercent: DEFAULT_PTY_MACHINE_WARN_PERCENT,
    hostRestartWaitSeconds: DEFAULT_HOST_RESTART_WAIT_SECONDS,
    hostRestartNote: true,
    hostRestartCheckSeconds: DEFAULT_HOST_RESTART_CHECK_SECONDS,
  };
  const check = raw.host_restart_check_seconds;
  if (check !== undefined) {
    if (
      typeof check !== "number" ||
      !Number.isFinite(check) ||
      check < 0 ||
      check > 3600
    )
      throw new Error(
        `sessions.host_restart_check_seconds: must be a number of seconds, 0 to 3600 (got ${JSON.stringify(check)})`,
      );
    out.hostRestartCheckSeconds = check;
  }
  const note = raw.host_restart_note;
  if (note !== undefined) {
    if (typeof note !== "boolean")
      throw new Error(
        `sessions.host_restart_note: must be true or false (got ${JSON.stringify(note)})`,
      );
    out.hostRestartNote = note;
  }
  const hostWait = raw.host_restart_wait_seconds;
  if (hostWait !== undefined) {
    if (
      typeof hostWait !== "number" ||
      !Number.isFinite(hostWait) ||
      hostWait < 0 ||
      hostWait > 86_400
    )
      throw new Error(
        `sessions.host_restart_wait_seconds: must be a number of seconds, 0 to 86400 (got ${JSON.stringify(hostWait)})`,
      );
    out.hostRestartWaitSeconds = hostWait;
  }
  const ptyClose = raw.pty_close_seconds;
  if (ptyClose !== undefined) {
    if (
      typeof ptyClose !== "number" ||
      !Number.isFinite(ptyClose) ||
      ptyClose < 0 ||
      ptyClose > 86_400
    )
      throw new Error(
        `sessions.pty_close_seconds: must be a number of seconds, 0 to 86400 (got ${JSON.stringify(ptyClose)})`,
      );
    out.ptyCloseSeconds = ptyClose;
  }
  const warn = raw.pty_warn_above;
  if (warn !== undefined) {
    if (typeof warn !== "number" || !Number.isInteger(warn) || warn < 1)
      throw new Error(
        `sessions.pty_warn_above: must be a whole number of at least 1 (got ${JSON.stringify(warn)})`,
      );
    out.ptyWarnAbove = warn;
  }
  const pct = raw.pty_machine_warn_percent;
  if (pct !== undefined) {
    if (
      typeof pct !== "number" ||
      !Number.isFinite(pct) ||
      pct <= 0 ||
      pct > 100
    )
      throw new Error(
        `sessions.pty_machine_warn_percent: must be a percent, above 0 and up to 100 (got ${JSON.stringify(pct)})`,
      );
    out.ptyMachineWarnPercent = pct;
  }
  const grace = raw.close_grace_seconds;
  if (grace !== undefined) {
    if (
      typeof grace !== "number" ||
      !Number.isFinite(grace) ||
      grace < 0 ||
      grace > 300
    )
      throw new Error(
        `sessions.close_grace_seconds: must be a number of seconds, 0 to 300 (got ${JSON.stringify(grace)})`,
      );
    out.closeGraceSeconds = grace;
  }
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
  /**
   * #257: how long the web server keeps an idle connection open, in
   * seconds (default 120). Above the page's poll and a proxy's idle time,
   * so a client never reuses a connection the server is closing.
   */
  keep_alive_seconds?: number;
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
        "use defaults.workspaces alone (name the default project `default` in it), " +
        "or defaults.workspace alone for a single default project",
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
            `defaults.workspaces: "${name}" is not a valid project name (letters, digits, dots, dashes, underscores)`,
          );
        return resolveBlueprint(`defaults.workspaces.${name}`, name, raw, [
          "focus",
        ]);
      },
    );
    const focused = resolved.filter((b) => b.focus);
    if (focused.length > 1)
      throw new Error(
        `defaults.workspaces: only one project may set focus: true (got ${focused.map((b) => b.name).join(", ")})`,
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

/** #257: web.keep_alive_seconds when unset. */
export const WEB_KEEP_ALIVE_SECONDS_DEFAULT = 120;

/** #257: web.keep_alive_seconds, checked (1 to 3600). A bad value throws. */
export function readWebKeepAliveSeconds(
  config: DenConfig = readDenConfig(),
): number {
  const v: unknown = (
    config.web as { keep_alive_seconds?: unknown } | undefined
  )?.keep_alive_seconds;
  if (v === undefined || v === null) return WEB_KEEP_ALIVE_SECONDS_DEFAULT;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 3600)
    throw new Error(
      `web.keep_alive_seconds: seconds, 1 to 3600 (got ${JSON.stringify(v)})`,
    );
  return v;
}

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
