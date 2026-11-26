import chalk from "chalk";
import * as yaml from "yaml";
import {
  mergeUserConfig,
  readDenConfig,
  readSessionsConfig,
  readUserConfig,
  SESSIONS_SETTINGS_KEYS,
  AGENTS_SETTINGS_KEYS,
  agentsLimitInForce,
  limitInForce,
  type LimitSource,
  writeUserConfig,
  readInstallMode,
  type DenConfig,
  type ResolvedSessionsConfig,
  type UserConfig,
} from "../../shared/den-config.js";
import { patchCliRows } from "../../shared/settings-cli-rows.js";
import { personSetCaps } from "./setting-change.js";

function readDenConfigOrEmpty(): DenConfig {
  try {
    return readDenConfig();
  } catch {
    return {} as DenConfig;
  }
}
import { hubGroupsMode, patchHubGroups } from "../../shared/hub.js";
import { patchAlerts } from "../../shared/alerts.js";
import { testInstallByHandRefusal } from "../../shared/fixture-person.js";

/** Issue 810: the test-install mark's names, refused by `config`. */
const TEST_INSTALL_KEYS = new Set(["web.test_install", "test_install"]);

import { product } from "../../shared/product.js";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { readWebPort } from "../../shared/edge/config.js";
import { cliAuthHeaders } from "../../shared/web-secret.js";
import { denWebBase } from "../../shared/web-dial.js";
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
  // Issue 1391: personal or strict.
  install_mode: "install_mode",
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
  "github.watch_stale_minutes": ["github", "watch_stale_minutes"],
  "github.watch_max_open_hours": ["github", "watch_max_open_hours"],
  "github.rerun_look_minutes": ["github", "rerun_look_minutes"],
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
  // Issue 1127: how old a repo's visibility may be for the words check.
  "agents.issue_writes_visibility_minutes": [
    "agent_issue_writes",
    "visibility_minutes",
  ],
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
  "alerts.tab_first_seconds": ["alerts", "tab_first_seconds"],
  "alerts.max_streams": ["alerts", "max_streams"],
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
  // Issue 1373: the agents' limits (agents.max_concurrent and the waits),
  // user.yml's winning over den.yml's.
  ...Object.fromEntries(
    AGENTS_SETTINGS_KEYS.map((k) => [`agents.${k}`, ["agents_limits", k]]),
  ),
  // Issue 742: how long a held write waits for the person's Allow.
  "held_writes.wait_minutes": ["held_writes", "wait_minutes"],
  // Issue 1022: how often the page polls health, visible and hidden.
  "health_poll.visible_seconds": ["health_poll", "visible_seconds"],
  "health_poll.hidden_seconds": ["health_poll", "hidden_seconds"],
  "git_reads.at_once": ["git_reads", "at_once"],
};

/** Issue 532: a terminal limit's effective value (user.yml over den.yml). */
function sessionsValue(name: string): number | undefined {
  const [field, limit] = DOTTED[name] ?? [];
  if (field !== "sessions" || !limit) return undefined;
  const camel = limit.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  return readSessionsConfig()[camel as keyof ResolvedSessionsConfig] as number;
}

/** Issue 1417: where a limit's value in force comes from, in words. */
const SOURCE_WORDS: Readonly<Record<LimitSource, string>> = {
  "user.yml": "from user.yml",
  "den.yml": "from den.yml",
  default: "Den's default",
};

/** Issue 1373: an agent limit's value in force (user.yml over den.yml). */
function agentsLimitValue(name: string): unknown {
  const [field, limit] = DOTTED[name] ?? [];
  if (field !== "agents_limits" || !limit) return undefined;
  return agentsLimitInForce(limit);
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

/**
 * Issue 1371: one setting set (or, with null, cleared) on `user`, as
 * Settings and `config` check it: a dotted limit, a dotted switch or a Hub
 * groups setting. `unknown` when `config` has no such dotted key (the
 * top-level ones are `canonicalKey`'s). setting_change checks with it too.
 */
export function patchConfigKey(
  user: Record<string, unknown>,
  name: string,
  value: unknown,
): { ok: true } | { ok: false; error: string; unknown?: true } {
  if (TEST_INSTALL_KEYS.has(name))
    return { ok: false, error: testInstallByHandRefusal(product().configFile) };
  if (HUB_GROUPS[name])
    return patchHubGroups(user, { [HUB_GROUPS[name]]: value });
  if (DOTTED_SWITCH[name])
    return patchCliRows(user, { [DOTTED_SWITCH[name]]: value }, { cli: true });
  if (DOTTED[name]) {
    const [field, limit] = DOTTED[name];
    // Issue 367: alerts are checked as the Settings page checks them.
    return field === "alerts"
      ? patchAlerts(user as UserConfig, { [limit]: value })
      : patchCliRows(user, { [field]: { [limit]: value } }, { cli: true });
  }
  return { ok: false, unknown: true, error: `unknown setting ${name}` };
}

/** A dotted setting set (or, with null, cleared) as Settings would. */
function setDotted(name: string, value: unknown): void {
  const user = readUserConfig() as Record<string, unknown>;
  const r = patchConfigKey(user, name, value);
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

/** The server's API, as `config propose` calls it (tests pass their own). */
export type ConfigApi = (
  method: "POST",
  path: string,
  body: unknown,
) => Promise<{ status: number; data: Record<string, unknown> }>;

const httpApi: ConfigApi = async (method, p, body) => {
  let port: number;
  try {
    port = readWebPort();
  } catch {
    port = DEFAULT_PORT;
  }
  const r = await fetch(`${denWebBase(port)}${p}`, {
    method,
    headers: { "content-type": "application/json", ...cliAuthHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, data };
};

/**
 * Issue 1371: `config propose <key>=<value> --reason "<why>"`: asks Den
 * for the held write setting_change, as the MCP tool does, so an agent
 * (whose sandbox can't write user.yml) never hands the person a YAML
 * edit. Den checks it before holding; the person allows it in Den.
 */
export async function proposeSetting(
  args: string[],
  api: ConfigApi = httpApi,
  out: (s: string) => void = (s) => process.stdout.write(s),
): Promise<number> {
  const cli = product().cli;
  const usage = `Usage: ${cli} config propose <key>=<value> --reason "<why>" (null puts Den's default back)`;
  const at = args.indexOf("--reason");
  const reason = at >= 0 ? args[at + 1] : undefined;
  const rest = at >= 0 ? args.filter((_, i) => i !== at && i !== at + 1) : args;
  const assignment = rest[0] ?? "";
  const eq = assignment.indexOf("=");
  if (eq <= 0 || rest.length !== 1 || !reason?.trim()) {
    out(`${usage}\n`);
    return 2;
  }
  const key = assignment.slice(0, eq);
  const raw = assignment.slice(eq + 1);
  let value: unknown;
  try {
    value = yaml.parse(raw);
  } catch {
    value = raw;
  }
  const r = await api("POST", "/api/approvals", {
    action: "setting_change",
    args: { key, value: value ?? null, reason },
  });
  const d = r.data;
  if (r.status !== 200 && r.status !== 202) {
    out(`✗ ${String(d.error ?? `Den answered ${r.status}`)}\n`);
    return 1;
  }
  const result = (d.result ?? {}) as Record<string, unknown>;
  if (d.state === "done" && result.ok === false) {
    out(`✗ ${String(result.error ?? "it failed")}\n`);
    return 1;
  }
  if (d.state === "done") {
    out(`✓ ${String(result.note ?? `${key} is set`)}\n`);
    return 0;
  }
  out(
    `Waiting for the person's Allow in Den (request ${String(d.id ?? "")}). Check it with the MCP tool approval_check.\n`,
  );
  return 0;
}

export async function cmdConfig(args: string[]): Promise<void> {
  if (args[0] === "propose") {
    process.exitCode = await proposeSetting(args.slice(1));
    return;
  }
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
      setDotted(keyArg, null);
      console.log(chalk.green(`  ✓ Removed ${keyArg}`));
      return;
    }
    if (DOTTED[keyArg]) {
      setDotted(keyArg, null);
      console.log(chalk.green(`  ✓ Removed ${keyArg}`));
      return;
    }
    if (HUB_GROUPS[keyArg]) {
      setDotted(keyArg, null);
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
  // Issue 1417: an agent or terminal limit prints its value in force as
  // stdout's last line (scripts read it), and where it came from on
  // stderr; every agent limit, not only the ones `config` sets.
  const inForce =
    eq < 0
      ? limitInForce(assignment, readUserConfig(), readDenConfigOrEmpty())
      : undefined;
  if (inForce) {
    console.error(chalk.dim(`  (${SOURCE_WORDS[inForce.from]})`));
    console.log(String(inForce.value));
    return;
  }
  // Issue 532: `config sessions.<key>` prints the value in force.
  const effective =
    eq < 0
      ? (sessionsValue(assignment) ?? agentsLimitValue(assignment))
      : undefined;
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
    setDotted(name, parseValue(assignment.slice(eq + 1)));
    console.log(chalk.green(`  ✓ Set ${name}`));
    return;
  }
  if (DOTTED[name]) {
    setDotted(name, parseValue(assignment.slice(eq + 1)));
    console.log(chalk.green(`  ✓ Set ${name}`));
    return;
  }
  if (HUB_GROUPS[name]) {
    setDotted(name, parseValue(assignment.slice(eq + 1)));
    console.log(chalk.green(`  ✓ Set ${name}`));
    return;
  }
  const key = canonicalKey(name);
  const value = parseValue(assignment.slice(eq + 1));
  if (key === "install_mode" && value !== "personal" && value !== "strict")
    throw new Error("install_mode is personal or strict");
  // Issue 1391: strict in the distribution's den.yml wins.
  if (key === "install_mode" && value !== "strict") {
    let den: DenConfig["install_mode"] = "strict";
    try {
      den = readDenConfig().install_mode;
    } catch {
      /* unreadable: fails closed */
    }
    if (readInstallMode({}, { install_mode: den }) === "strict")
      throw new Error(
        "The distribution's den.yml sets install_mode: strict, and a person can't loosen it.",
      );
  }
  const was = readUserConfig();
  mergeUserConfig({ [key]: value } as Partial<UserConfig>);
  // Issue 1391: a cap the person moved here takes it as its baseline.
  const now = readUserConfig();
  const had = JSON.stringify(now.setting_baselines);
  personSetCaps(was, now, readDenConfigOrEmpty());
  if (JSON.stringify(now.setting_baselines) !== had) writeUserConfig(now);
  console.log(chalk.green(`  ✓ Set ${key}`));
}
