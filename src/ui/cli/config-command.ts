import chalk from "chalk";
import * as yaml from "yaml";
import {
  mergeUserConfig,
  readDenConfig,
  readSessionsConfig,
  readUserConfig,
  SESSIONS_SETTINGS_KEYS,
  writeUserConfig,
  type ResolvedSessionsConfig,
  type UserConfig,
} from "../../shared/den-config.js";
import { patchCliRows } from "../../shared/settings-cli-rows.js";
import { hubGroupsMode, patchHubGroups } from "../../shared/hub.js";
import { patchAlerts } from "../../shared/alerts.js";
import { testInstallByHandRefusal } from "../../shared/fixture-person.js";

/** Issue 810: the test-install mark's names, refused by `config`. */
const TEST_INSTALL_KEYS = new Set(["web.test_install", "test_install"]);

import { product } from "../../shared/product.js";
type ConfigKey = keyof UserConfig;

const KEY_ALIASES: Record<string, ConfigKey> = {
  tabs: "cli_tabs",
  cli_tabs: "cli_tabs",
  "local-dev": "local_dev",
  local_dev: "local_dev",
  editor: "editor",
  terminal: "terminal",
  editor_overrides: "editor_overrides",
  log_window_lines: "log_window_lines",
  log_window: "log_window_lines",
};

/**
 * MODE-5: limits inside a block, as Settings names them (`config
 * panes.reconnect_max_failures=20`): the Settings field and its limit, so
 * the same checks hold here as on the page.
 */
export const DOTTED: Record<string, [field: string, limit: string]> = {
  "panes.reconnect_seconds": ["panes_reconnect", "seconds"],
  "panes.reconnect_max_seconds": ["panes_reconnect", "max_seconds"],
  "panes.reconnect_max_failures": ["panes_reconnect", "max_failures"],
  "panes.reconnect_window_seconds": ["panes_reconnect", "window_seconds"],
  "panes.connect_timeout_seconds": [
    "panes_reconnect",
    "connect_timeout_seconds",
  ],
  "web.crash_loop_restarts": ["crash_loop", "restarts"],
  "web.crash_loop_minutes": ["crash_loop", "minutes"],
  "web.crash_loop_max_wait_seconds": ["crash_loop", "max_wait_seconds"],
  // 0.4.48: Den on the Docker bridge for the edge (Linux).
  "web.bridge_listen": ["web_bridge", "listen"],
  "web.bridge_probe_seconds": ["web_bridge", "probe_seconds"],
  // Issue 406: the start's wait for the owner's GitHub name.
  "web.owner_name_timeout_seconds": [
    "web_github",
    "owner_name_timeout_seconds",
  ],
  // The shared GitHub watcher's pace and API budget.
  "github.watch_interval_seconds": ["github", "watch_interval_seconds"],
  "github.watch_max_interval_seconds": ["github", "watch_max_interval_seconds"],
  "github.api_budget_floor": ["github", "api_budget_floor"],
  "github.watches_max": ["github", "watches_max"],
  // den#143: how long `web up` waits for the server.
  "web.ready_probe_seconds": ["web_ready", "probe_seconds"],
  "web.start_wait_seconds": ["web_ready", "start_seconds"],
  // Issue 819: new-device requests and wrong codes.
  "web.pair_requests_per_minute": ["web_pairing", "requests_per_minute"],
  "web.approve_attempts": ["web_pairing", "approve_attempts"],
  "web.approve_window_seconds": ["web_pairing", "approve_window_seconds"],
  // Issue 796: agents' read-only page views, and how long one lasts.
  "web.agent_view": ["web_agent_view", "on"],
  "web.agent_view_minutes": ["web_agent_view", "minutes"],
  "web.sessions_lock_wait_ms": ["web_sessions", "lock_wait_ms"],
  // den#156: the Agents list's waits for the terminal host.
  "agents_list.host_timeout_seconds": ["agents_list", "host_timeout_seconds"],
  // Issue 456: how long Den waits for the shell's PATH.
  "agents.shell_path_timeout_seconds": ["agents_shell", "path_timeout_seconds"],
  // Issue 1311: how long messages wait on a draft before the bell says so.
  "agents.draft_hold_max_minutes": ["agents_draft", "hold_max_minutes"],
  // Issue 1129: the restart queue (agents.resume.*).
  "agents.resume.batch": ["agents_resume", "batch"],
  "agents.resume.gap_seconds": ["agents_resume", "gap_seconds"],
  "agents.resume.load_ceiling": ["agents_resume", "load_ceiling"],
  "agents.resume.max_wait_seconds": ["agents_resume", "max_wait_seconds"],
  // issue_write: which roles write GitHub issues ([planner, sde]), and the
  // install's writes an hour.
  "agents.issue_writes": ["agent_issue_writes", "roles"],
  "agents.issue_writes_per_hour": ["agent_issue_writes", "per_hour"],
  "agents_list.refresh_timeout_seconds": [
    "agents_list",
    "refresh_timeout_seconds",
  ],
  // Issue 403: how long a filed report's screenshot is kept here.
  "reports.screenshot_keep_days": ["reports", "screenshot_keep_days"],
  "reports.screenshot_max_mb": ["reports", "screenshot_max_mb"],
  "reports.hub_screenshot_max_mb": ["reports", "hub_screenshot_max_mb"],
  // Issue 707: the server's warning lines on disk, capped.
  "server_log.max_mb": ["server_log", "max_mb"],
  "reports.hub_timeout_seconds": ["reports", "hub_timeout_seconds"],
  // Issue 278: when an agent counts as stuck compacting; instruction size.
  "agent_context.compaction_loop_count": [
    "agent_context",
    "compaction_loop_count",
  ],
  "agent_context.compaction_loop_minutes": [
    "agent_context",
    "compaction_loop_minutes",
  ],
  "agent_context.instruction_share_percent": [
    "agent_context",
    "instruction_share_percent",
  ],
  "agent_context.context_tokens": ["agent_context", "context_tokens"],
  "agent_context.pause_after_loop": ["agent_context", "pause_after_loop"],
  // Issue 367: how long one push may take, and how long a push service keeps it.
  "alerts.push_timeout_seconds": ["alerts", "push_timeout_seconds"],
  "alerts.push_ttl_seconds": ["alerts", "push_ttl_seconds"],
  // Issue 415: how long Report keeps, and waits for, a repo's visibility.
  "feedback.visibility_cache_hours": ["feedback", "visibility_cache_hours"],
  "feedback.visibility_timeout_seconds": [
    "feedback",
    "visibility_timeout_seconds",
  ],
  "feedback.visibility_retry_seconds": ["feedback", "visibility_retry_seconds"],
  // Issue 455: how long, and how often, Den checks its own address.
  "web.address_check_timeout_seconds": ["address_check", "timeout_seconds"],
  "web.address_check_retries": ["address_check", "retries"],
  "web.address_check_cache_seconds": ["address_check", "cache_seconds"],
  "web.address_check_drop_after": ["address_check", "drop_after"],
  "web.address_unknown_keep_seconds": ["address_check", "unknown_keep_seconds"],
  // Issue 609: how long Den's process lookups (lsof, ps) wait.
  "process_lookup.first_seconds": ["process_lookup", "first_seconds"],
  "process_lookup.retry_seconds": ["process_lookup", "retry_seconds"],
  // Issue 609: how agents' hooks wait for Den, and retry.
  "agent_hooks.timeout_seconds": ["agent_hooks", "timeout_seconds"],
  "agent_hooks.retries": ["agent_hooks", "retries"],
  "agent_hooks.backoff_seconds": ["agent_hooks", "backoff_seconds"],
  // Issue 532: the terminal limits (sessions.max_concurrent and the rest).
  ...Object.fromEntries(
    SESSIONS_SETTINGS_KEYS.map((k) => [`sessions.${k}`, ["sessions", k]]),
  ),
  // Issue 742: how long a held write waits for the person's Allow.
  "held_writes.wait_minutes": ["held_writes", "wait_minutes"],
  // Issue 1022: how often the page polls health, visible and hidden.
  "health_poll.visible_seconds": ["health_poll", "visible_seconds"],
  "health_poll.hidden_seconds": ["health_poll", "hidden_seconds"],
};

/** Issue 532: a terminal limit's effective value (user.yml over den.yml). */
function sessionsValue(name: string): number | undefined {
  const [field, limit] = DOTTED[name] ?? [];
  if (field !== "sessions" || !limit) return undefined;
  const camel = limit.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  return readSessionsConfig()[camel as keyof ResolvedSessionsConfig] as number;
}

/**
 * Dotted switches, as Settings names them: the Settings field each sets
 * (issue 163: `config agents.keep_running_after_logout=true`).
 */
const DOTTED_SWITCH: Record<string, string> = {
  "agents.keep_running_after_logout": "keep_running_after_logout",
  // Issue 1225: whether services that were up come back after a restart.
  "services.restore_on_boot": "restore_services_on_boot",
};

/**
 * Issue 750: hub.groups (auto | on | off) and hub.groups_cache_seconds,
 * as Settings › Hub › Groups from Hub sets them (hub.ts patchHubGroups).
 */
const HUB_GROUPS: Record<string, "mode" | "cache_seconds"> = {
  "hub.groups": "mode",
  "hub.groups_cache_seconds": "cache_seconds",
};

/** Every key `config` accepts, aliases too. */
export function configKeyNames(): string[] {
  return [
    ...Object.keys(KEY_ALIASES),
    ...Object.keys(DOTTED),
    ...Object.keys(DOTTED_SWITCH),
    ...Object.keys(HUB_GROUPS),
  ];
}

/**
 * Issue 750: `config hub.groups` / `config hub.groups_cache_seconds`
 * print the value in force: user.yml's, else the distribution's, else
 * the default (auto, 30).
 */
function hubGroupsValue(name: string): string | undefined {
  const field = HUB_GROUPS[name];
  if (!field) return undefined;
  const hubOf = (c: unknown) =>
    ((c as { hub?: Record<string, unknown> } | null)?.hub ?? {}) as Record<
      string,
      unknown
    >;
  const user = hubOf(readUserConfig());
  let org: Record<string, unknown> = {};
  try {
    org = hubOf(readDenConfig());
  } catch {
    /* no distribution config: the defaults */
  }
  if (field === "mode") {
    const v = user.groups !== undefined ? user.groups : org.groups;
    return hubGroupsMode(v) ?? String(v);
  }
  const v = user.groups_cache_seconds ?? org.groups_cache_seconds ?? 30;
  return String(v);
}

/** Issue 750: a groups setting set (or, with null, cleared) as Settings would. */
function setHubGroups(name: string, value: unknown): void {
  const user = readUserConfig() as Record<string, unknown>;
  const r = patchHubGroups(user, { [HUB_GROUPS[name]!]: value });
  if (!r.ok) throw new Error(r.error);
  writeUserConfig(user as UserConfig);
}

/** A dotted switch set (or, with null, cleared) as Settings would. */
function setSwitch(name: string, value: unknown): void {
  const user = readUserConfig() as Record<string, unknown>;
  const r = patchCliRows(
    user,
    { [DOTTED_SWITCH[name]!]: value },
    { cli: true },
  );
  if (!r.ok) throw new Error(r.error);
  writeUserConfig(user as UserConfig);
}

/** A dotted limit set (or, with null, cleared) as Settings would. */
function setDotted(name: string, value: unknown): void {
  const [field, limit] = DOTTED[name]!;
  const user = readUserConfig() as Record<string, unknown>;
  // Issue 367: alerts are checked as the Settings page checks them.
  const r =
    field === "alerts"
      ? patchAlerts(user as UserConfig, { [limit]: value })
      : patchCliRows(user, { [field]: { [limit]: value } }, { cli: true });
  if (!r.ok) throw new Error(r.error);
  writeUserConfig(user as UserConfig);
}

function canonicalKey(input: string): ConfigKey {
  const key = KEY_ALIASES[input];
  if (!key) {
    throw new Error(
      `Unknown config key "${input}". Known keys: ${configKeyNames().join(", ")}`,
    );
  }
  return key;
}

function parseValue(raw: string): unknown {
  const parsed = yaml.parse(raw);
  return parsed === null ? "" : parsed;
}

export async function cmdConfig(args: string[]): Promise<void> {
  if (args.length === 0) {
    const current = readUserConfig();
    const output = yaml.stringify(current).trim();
    console.log(output || "{}");
    return;
  }

  if (args[0] === "rm") {
    const keyArg = args[1];
    if (!keyArg) throw new Error(`Usage: ${product().cli} config rm <key>`);
    if (TEST_INSTALL_KEYS.has(keyArg))
      throw new Error(testInstallByHandRefusal(product().configFile));
    if (DOTTED_SWITCH[keyArg]) {
      setSwitch(keyArg, null);
      console.log(chalk.green(`  ✓ Removed ${keyArg}`));
      return;
    }
    if (DOTTED[keyArg]) {
      setDotted(keyArg, null);
      console.log(chalk.green(`  ✓ Removed ${keyArg}`));
      return;
    }
    if (HUB_GROUPS[keyArg]) {
      setHubGroups(keyArg, null);
      console.log(chalk.green(`  ✓ Removed ${keyArg}`));
      return;
    }
    const key = canonicalKey(keyArg);
    mergeUserConfig({ [key]: undefined });
    console.log(chalk.green(`  ✓ Removed ${key}`));
    return;
  }

  const assignment = args[0];
  const eq = assignment.indexOf("=");
  // Issue 532: `config sessions.<key>` prints the value in force.
  const effective = eq < 0 ? sessionsValue(assignment) : undefined;
  if (effective !== undefined) {
    console.log(String(effective));
    return;
  }
  const groupsNow = eq < 0 ? hubGroupsValue(assignment) : undefined;
  if (groupsNow !== undefined) {
    console.log(groupsNow);
    return;
  }
  if (eq <= 0) {
    throw new Error(
      `Usage: ${product().cli} config <key>=<value> or ${product().cli} config rm <key>`,
    );
  }

  const name = assignment.slice(0, eq);
  // Issue 810: the test-install mark is set by hand in the distribution
  // config, never here (an agent can run this command).
  if (TEST_INSTALL_KEYS.has(name))
    throw new Error(testInstallByHandRefusal(product().configFile));
  if (DOTTED_SWITCH[name]) {
    setSwitch(name, parseValue(assignment.slice(eq + 1)));
    console.log(chalk.green(`  ✓ Set ${name}`));
    return;
  }
  if (DOTTED[name]) {
    setDotted(name, parseValue(assignment.slice(eq + 1)));
    console.log(chalk.green(`  ✓ Set ${name}`));
    return;
  }
  if (HUB_GROUPS[name]) {
    setHubGroups(name, parseValue(assignment.slice(eq + 1)));
    console.log(chalk.green(`  ✓ Set ${name}`));
    return;
  }
  const key = canonicalKey(name);
  const value = parseValue(assignment.slice(eq + 1));
  mergeUserConfig({ [key]: value } as Partial<UserConfig>);
  console.log(chalk.green(`  ✓ Set ${key}`));
}
