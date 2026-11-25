/**
 * Issue 1371: setting_change, a held write that changes one of Den's
 * settings in the person's config/local/user.yml, so an agent never hands
 * the person a YAML edit (an agent's sandbox can't write the file).
 *
 * An agent proposes `key = value` with a reason. The check, before
 * anything is held:
 *   - the key is one Den reads from user.yml: one `config` and Settings
 *     know (patchConfigKey, with their own checks), or one below
 *     (SETTING_KEYS: agent powers and the like, checked by den-config's
 *     own readers);
 *   - the value passes those checks, and changes what Den reads at that
 *     key (a key the readers ignore is refused as unknown);
 *   - the change touches that key only.
 * The person sees the key, its value now, the new one and the reason. A
 * key that widens what agents may do (settingKind) is marked so, and only
 * the person's own Allow runs it. On Allow, Den checks again, writes only
 * that key (comments and order kept), keeps a backup of the file and adds
 * an audit line. A key read only at the server's start says so: the agent
 * then asks for den_restart_server.
 *
 * settingKind is the one place a key gets its category and severity
 * (issue 1371 part 2 lets the person choose, per category, what asks).
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import {
  configuredRuntimeCatalog,
  agentsResume,
  readAgentsConfig,
  readDenConfig,
  readSessionsConfig,
  readInstallMode,
  limitInForce,
  readMcpConfig,
  USER_ONLY_WIDENING,
  type DenConfig,
  type InstallMode,
  type UserConfig,
} from "../../shared/den-config.js";
import {
  readPolicySetting,
  settingChoice,
  type SettingCategory,
} from "../../shared/approval-policy.js";
import { patchHubAllowTools, patchHubUrl } from "../../shared/hub.js";
import { patchHubDeliveryLoop } from "../../shared/hub-loop.js";
import { patchAlerts } from "../../shared/alerts.js";
import { checkIntent } from "../../shared/agents/permissions.js";
import { parseMachineName } from "../../shared/cli-command.js";
import { patchEditorOpen } from "../../shared/editor-open-pref.js";
import { patchEmbed } from "../../shared/embed-settings.js";
import {
  isKnownEditorKey,
  isKnownTerminalKey,
  SUPPORTED_LANGUAGES,
} from "../../shared/editor-catalog.js";
import { plainText } from "../../shared/agents/sandbox-set.js";
import {
  line,
  reviewLines,
  type DetailKey,
  type ReviewLine,
} from "../../shared/review-lines.js";
import { configKeyNames, patchConfigKey } from "./config-command.js";
import { patchCliRows } from "../../shared/settings-cli-rows.js";

export const SETTING_CHANGE_ACTION = "setting_change";
/** The longest reason an ask may give (one line). */
export const SETTING_REASON_MAX = 300;
/** The longest value shown on the card and in the audit line. */
const SHOWN_MAX = 200;
/** Backups kept of user.yml, newest first. */
export const SETTING_BACKUPS_KEPT = 20;

export type SettingSeverity = "low" | "medium" | "high";
export type { SettingCategory };

export interface SettingKind {
  category: SettingCategory;
  severity: SettingSeverity;
  /** Widens what an agent may do: only the person's own Allow runs it. */
  widens: boolean;
  /** Read only at the server's start: a restart applies it. */
  restart?: "server";
}

/**
 * Review D (issue 1371): setting_change fails closed. A key is routine
 * only when it is here: a timeout, an interval, a cap or a retention that
 * changes how fast or how much Den does, never who may sign in, what
 * agents reach, what runs, or what leaves this machine. Each is named
 * exactly (review D): a new key under one of these blocks widens until it
 * is placed here. Every other key
 * widens what agents can do (a test places every key setting_change takes
 * on this list or WIDENING_SETTINGS).
 */
export const NARROW_SETTINGS: readonly string[] = [
  // Issue 1391: judged by its value (WIDENS_AT): to strict is routine.
  "install_mode",
  "cli_tabs",
  "log_window_lines",
  "panes.reconnect_seconds",
  "panes.reconnect_max_seconds",
  "panes.reconnect_max_failures",
  "panes.reconnect_window_seconds",
  "panes.connect_timeout_seconds",
  "web.crash_loop_restarts",
  "web.crash_loop_minutes",
  "web.crash_loop_max_wait_seconds",
  "web.bridge_probe_seconds",
  "web.owner_name_timeout_seconds",
  "web.ready_probe_seconds",
  "web.start_wait_seconds",
  "web.sessions_lock_wait_ms",
  "web.address_check_timeout_seconds",
  "web.address_check_retries",
  "web.address_check_cache_seconds",
  "web.address_check_drop_after",
  "web.address_unknown_keep_seconds",
  "github.watch_interval_seconds",
  "github.watch_max_interval_seconds",
  "github.api_budget_floor",
  "github.watches_max",
  // Issue 1166: how long a watch waits on no progress (a timing knob).
  "github.watch_stale_minutes",
  // Issue 1194: the most hours one watch stays open (a timing knob).
  "github.watch_max_open_hours",
  // Issue 1214: how often a finished run is looked at for a re-run.
  "github.rerun_look_minutes",
  "agents_list.host_timeout_seconds",
  "agents_list.refresh_timeout_seconds",
  "agents.max_concurrent",
  // Issue 1417: every agent limit has an agent ask path.
  "agents.token_peer_wait_ms",
  "agents.turn_read_max_mb",
  "agents.restart_wait_minutes",
  "agents.rotation_wait_minutes",
  "agents.unasked_exit_window_minutes",
  "agents.lock_wait_minutes",
  "agents.exited_shell_minutes",
  "agents.shell_path_timeout_seconds",
  "agents.draft_hold_max_minutes",
  "agents.resume.batch",
  "agents.resume.gap_seconds",
  "agents.resume.load_ceiling",
  "agents.resume.max_wait_seconds",
  "reports.screenshot_keep_days",
  "reports.screenshot_max_mb",
  "reports.hub_timeout_seconds",
  "server_log.max_mb",
  "agent_context.compaction_loop_count",
  "agent_context.compaction_loop_minutes",
  "agent_context.pause_after_loop",
  "alerts.push_timeout_seconds",
  "alerts.push_ttl_seconds",
  "feedback.visibility_cache_hours",
  "feedback.visibility_timeout_seconds",
  "feedback.visibility_retry_seconds",
  "process_lookup.first_seconds",
  "process_lookup.retry_seconds",
  "agent_hooks.timeout_seconds",
  "agent_hooks.retries",
  "agent_hooks.backoff_seconds",
  "sessions.max_concurrent",
  "sessions.close_grace_seconds",
  "sessions.pty_close_seconds",
  "sessions.pty_warn_above",
  "sessions.pty_machine_warn_percent",
  "health_poll.visible_seconds",
  "health_poll.hidden_seconds",
  "hub.groups_cache_seconds",
  // Vision's ruling (issue 1391): Settings' own fields, each named.
  "hub.delivery_loop",
  "alerts.desktop",
  "alerts.phone",
  "alerts.quiet.from",
  "alerts.quiet.to",
  "editor_open",
  "web.machine_name",
  "shell.dock",
  "shell.collapsed",
  "embed.url_max_chars",
  "embed.feed_event_max_kb",
  "embed.feed_events_per_minute",
  "embed.feed_keep_events",
  "embed.feed_list_max_mb",
  "embed.feed_list_timeout_seconds",
  "embed.feed_max_streams",
  "embed.feed_read_max_kb",
  "embed.context_max_kb",
  "embed.paste_max_kb",
];

/**
 * The keys that widen, named (any key not on NARROW_SETTINGS widens too):
 * the user.yml-only ones (USER_ONLY_WIDENING), the approval policy itself,
 * the programs and runtimes Den runs, and those that guard sign-in, what
 * agents see and do, what keeps running, and what goes to Hub.
 */
export const WIDENING_SETTINGS: readonly string[] = [
  ...USER_ONLY_WIDENING,
  // Vision's ruling (issue 1391): Settings' own fields an agent may ask for.
  "agents.default_mode",
  "server_agent.self_update",
  "hub.allow_tools",
  "hub.url",
  "embed",
  "embed.origins",
  "embed.key_minutes",
  "embed.app_key_audit_window_seconds",
  "shell.pins",
  "approvals",
  "approvals.**",
  "editor",
  "terminal",
  "editor_overrides",
  "editor_overrides.*",
  "local_dev",
  "agents.runtime_catalog",
  "agents.runtime_catalog.**",
  "agents.runtimes.**",
  "secrets.**",
  "web.approve_attempts",
  "web.approve_window_seconds",
  "web.pair_requests_per_minute",
  "web.agent_view",
  "web.agent_view_minutes",
  "web.bridge_listen",
  "agents.issue_writes",
  "agents.issue_writes_per_hour",
  // Issue 1127: a longer wait keeps a repo made public treated as private.
  "agents.issue_writes_visibility_minutes",
  "agents.keep_running_after_logout",
  "services.restore_on_boot",
  "held_writes.wait_minutes",
  "hub.groups",
  "reports.hub_screenshot_max_mb",
  "agent_context.instruction_share_percent",
  "agent_context.context_tokens",
];

/**
 * Issue 1391 (Vision): on a personal install the programs agents and the
 * person use are routine: editors, terminals, the runtimes' paths. Each
 * is still checked as Settings checks it (a known editor or terminal, an
 * absolute path to a program).
 */
export const ROUTINE_ON_PERSONAL: readonly string[] = [
  "editor",
  "terminal",
  "editor_overrides",
  "editor_overrides.*",
  "agents.runtimes.**",
];

/**
 * Issue 1371 Part 2: each key's category, the first pattern that matches;
 * every other key is a limit (a timeout, an interval, a cap).
 */
const CATEGORY_OF: readonly [SettingCategory, readonly string[]][] = [
  // Issue 1395: the gates folder's settings (slots, waits), its own writer.
  ["limits", ["gate.**"]],
  [
    "agent_powers",
    [
      "install_mode",
      "agents.sandbox",
      "agents.sandbox_sockets",
      "agents.*.sandbox",
      "agents.*.grants",
      "approvals",
      "approvals.**",
      "mcp.**",
      "secrets.**",
      "held_writes.**",
      "agents.issue_writes",
      "agents.issue_writes_per_hour",
      "agents.keep_running_after_logout",
      "services.restore_on_boot",
      "local_dev",
      "agents.default_mode",
      "server_agent.self_update",
    ],
  ],
  ["look", ["web.machine_name"]],
  ["network", ["web.**", "embed", "embed.**", "hub.url"]],
  [
    "integrations",
    [
      "hub.**",
      "github.**",
      "editor",
      "terminal",
      "editor_overrides",
      "editor_overrides.*",
      "agents.runtimes.**",
      "agents.runtime_catalog",
      "agents.runtime_catalog.**",
      "reports.**",
      "feedback.**",
      "agent_hooks.**",
    ],
  ],
  [
    "look",
    ["cli_tabs", "log_window_lines", "shell.**", "editor_open", "alerts.**"],
  ],
];

const SEVERITY: Readonly<Record<SettingCategory, SettingSeverity>> = {
  limits: "low",
  look: "low",
  integrations: "medium",
  network: "high",
  agent_powers: "high",
};

/** The Settings › Approvals row's name for each category (en). */
export const CATEGORY_LABEL: Readonly<Record<SettingCategory, string>> = {
  limits: "Limits and performance",
  look: "Look and layout",
  integrations: "Integrations",
  network: "Network and access",
  agent_powers: "Agent powers",
};

/** Keys read only when the server starts (`web up`, the launcher). */
const AT_START: readonly string[] = [
  "web.bridge_listen",
  "web.bridge_probe_seconds",
  "web.crash_loop_*",
  "web.ready_probe_seconds",
  "web.start_wait_seconds",
];

/** `*` one segment, `**` one or more, a trailing `_*` any suffix. */
export function matchesSetting(pattern: string, key: string): boolean {
  const p = pattern.split(".");
  const k = key.split(".");
  const go = (i: number, j: number): boolean => {
    if (i === p.length) return j === k.length;
    if (p[i] === "**") {
      for (let n = j + 1; n <= k.length; n++) if (go(i + 1, n)) return true;
      return false;
    }
    if (j === k.length) return false;
    const seg = p[i]!;
    const ok =
      seg === "*" ||
      seg === k[j] ||
      (seg.endsWith("_*") && k[j]!.startsWith(seg.slice(0, -1)));
    return ok && go(i + 1, j + 1);
  };
  return go(0, 0);
}

/** The key's category and severity: the one place either is decided. */
/**
 * Issue 1395: a key whose new value, not the key itself, widens on a
 * strict install. gate.browser_requires_container 0 runs browsers on the
 * host, not in a container. On personal installs the gate stays routine.
 */
/** A level as a number (true/false as 1/0); null when it isn't one. */
const level = (v: unknown): number | null =>
  typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : null;

const WIDENS_AT: readonly [
  key: string,
  /** `before`: the value in effect now, when the caller knows it. */
  widens: (v: unknown, before?: unknown) => boolean,
  modes: readonly InstallMode[],
][] = [
  // Issue 1395 (Vision; Reviewer C): judged by old and new together, any
  // lowering of the container requirement widens on strict; with no old
  // value known, off (0) does.
  [
    "gate.browser_requires_container",
    (v, before) => {
      const to = level(v);
      const from = level(before);
      if (to === null) return true;
      return from === null ? to === 0 : to < from;
    },
    ["strict"],
  ],
  // Issue 1391: to strict is routine; anything else (personal, or back to
  // the default) opens the install up: the person's Allow.
  ["install_mode", (v) => v !== "strict", ["personal", "strict"]],
];

export function settingKind(
  key: string,
  /** Issue 1391: the install's mode; strict when not given. */
  mode: InstallMode = "strict",
  /**
   * Issue 1395: the value in effect after the change, defaults resolved,
   * and (when known) the value in effect now. Given, WIDENS_AT may make
   * it widen on strict.
   */
  ...value: [] | [unknown] | [unknown, unknown]
): SettingKind {
  const is = (list: readonly string[]) =>
    list.some((p) => matchesSetting(p, key));
  const category = CATEGORY_OF.find(([, ps]) => is(ps))?.[0] ?? "limits";
  // Fails closed: routine only when NARROW_SETTINGS names it (or, on a
  // personal install, ROUTINE_ON_PERSONAL). Agent powers always widen.
  // Issue 1395: the gate's settings are scheduling on this machine, never
  // security: routine on both modes (its writer checks each value).
  const routine =
    (mode === "personal" && is(ROUTINE_ON_PERSONAL)) || is(["gate.**"])
      ? true
      : !is(WIDENING_SETTINGS) && is(NARROW_SETTINGS);
  // A value rule, given the value, decides for its key (and modes).
  const rule = value.length
    ? WIDENS_AT.find(([k, , modes]) => k === key && modes.includes(mode))
    : undefined;
  const widens = rule
    ? rule[1](value[0], value[1])
    : category === "agent_powers" || !routine;
  const restart = is(AT_START) ? ("server" as const) : undefined;
  return {
    category,
    severity: SEVERITY[category],
    widens,
    ...(restart ? { restart } : {}),
  };
}

type Patch = { ok: true } | { ok: false; error: string; unknown?: true };

const KEY_RE = /^[a-z][a-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Sets (or, with null, deletes) a dotted key on a plain object. */
function setPath(o: Record<string, unknown>, key: string, v: unknown): void {
  const parts = key.split(".");
  const chain: Record<string, unknown>[] = [o];
  let cur = o;
  for (const p of parts.slice(0, -1)) {
    if (!isObj(cur[p])) {
      if (v === null) return;
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
    chain.push(cur);
  }
  const last = parts[parts.length - 1]!;
  if (v === null) delete cur[last];
  else cur[last] = v;
  // A block left empty goes too.
  for (let i = chain.length - 1; i > 0; i--)
    if (Object.keys(chain[i]!).length === 0)
      delete chain[i - 1]![parts[i - 1]!];
}

/**
 * Keys `config` and Settings don't take, each with the den-config reader
 * that checks it. A key not here, and not `config`'s, is unknown.
 */
const SETTING_KEYS: readonly {
  key: string;
  check: (u: UserConfig, den: DenConfig) => void;
  /** Refused, with this: another way changes it. */
  refuse?: string;
}[] = [
  { key: "agents.sandbox", check: (u, d) => void readAgentsConfig(d, u) },
  {
    key: "agents.sandbox_sockets",
    check: (u, d) => void readAgentsConfig(d, u),
  },
  { key: "agents.*.grants", check: (u, d) => void readAgentsConfig(d, u) },
  {
    key: "agents.*.sandbox",
    check: () => undefined,
    refuse:
      "one agent's sandbox is agent_sandbox_set's: it restarts the agent and keeps the note agents doctor shows",
  },
  { key: "mcp.actions", check: (u, d) => void readMcpConfig(d, u) },
  {
    key: "approvals",
    check: (u) => void readPolicySetting(u.approvals),
  },
  {
    key: "approvals.**",
    check: (u) => void readPolicySetting(u.approvals),
  },
  {
    key: "web.edge_unattested",
    check: (u) => {
      const v = (u.web as Record<string, unknown> | undefined)?.edge_unattested;
      if (v !== undefined && v !== "local" && v !== "signin")
        throw new Error(
          `web.edge_unattested must be local or signin, got ${JSON.stringify(v)}`,
        );
    },
  },
  {
    key: "web.allow_plain_http_remote",
    check: (u) => {
      const v = (u.web as Record<string, unknown> | undefined)
        ?.allow_plain_http_remote;
      if (v !== undefined && typeof v !== "boolean")
        throw new Error(
          `web.allow_plain_http_remote must be true or false, got ${JSON.stringify(v)}`,
        );
    },
  },
  // Issue 1391: where secrets come from, as references only: never a value.
  { key: "secrets.**", check: (u) => checkSecretRefs(u.secrets) },
  {
    key: "agents.runtime_catalog",
    check: (u, d) => {
      readAgentsConfig(d, u);
      configuredRuntimeCatalog([], () => u);
    },
  },
  {
    key: "agents.runtime_catalog.**",
    check: (u, d) => {
      readAgentsConfig(d, u);
      configuredRuntimeCatalog([], () => u);
    },
  },
  // Issue 1391: a runtime's path, an absolute path to a program.
  {
    key: "agents.runtimes.**",
    check: (u) => checkRuntimes(u.agents?.runtimes),
  },
];

/** A short name: a word, a path-like name or a FLAT_KEY; one line. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/@:-]{0,199}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
/** Where a secret comes from: a reference, never the secret itself. */
const SECRET_SOURCE_RE =
  /^(env:[A-Z_][A-Z0-9_]{0,127}|file:\/\S{1,500}|keychain:[^\s]{1,200}|op:\/\/\S{1,500})$/;
const NOT_A_VALUE =
  "a reference (env:NAME, file:/path, keychain:service or op://vault/item/field), never the secret itself: did you mean a reference?";

/**
 * Issue 1391: secrets.* as references only (the card shows what is set, so
 * a value would be shown). Each error names the key, never the value.
 */
function checkSecretRefs(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (!isObj(raw)) throw new Error("secrets: a mapping");
  const s = raw as Record<string, unknown>;
  const name = (v: unknown, key: string) => {
    if (v === undefined || v === null) return;
    if (typeof v !== "string" || !NAME_RE.test(v))
      throw new Error(`${key}: a name (one line), or ${NOT_A_VALUE}`);
  };
  for (const k of Object.keys(s))
    if (
      ![
        "provider",
        "required",
        "doppler",
        "onepassword",
        "keys",
        "refs",
      ].includes(k)
    )
      throw new Error(`secrets.${k} is not a setting Den reads`);
  if (
    s.provider !== undefined &&
    s.provider !== null &&
    !["none", "doppler", "1password", "env"].includes(s.provider as string)
  )
    throw new Error("secrets.provider: none, doppler, 1password or env");
  if (
    s.required !== undefined &&
    s.required !== null &&
    typeof s.required !== "boolean"
  )
    throw new Error("secrets.required: true or false");
  for (const [blk, keys] of [
    ["doppler", ["project", "config"]],
    ["onepassword", ["account", "token"]],
  ] as const) {
    const b = s[blk];
    if (b === undefined || b === null) continue;
    if (!isObj(b)) throw new Error(`secrets.${blk}: a mapping`);
    for (const k of Object.keys(b)) {
      if (!(keys as readonly string[]).includes(k))
        throw new Error(`secrets.${blk}.${k} is not a setting Den reads`);
      const v = (b as Record<string, unknown>)[k];
      if (blk === "onepassword" && k === "token") {
        if (
          v !== undefined &&
          v !== null &&
          (typeof v !== "string" || !SECRET_SOURCE_RE.test(v))
        )
          throw new Error(`secrets.onepassword.token: ${NOT_A_VALUE}`);
      } else name(v, `secrets.${blk}.${k}`);
    }
  }
  if (s.keys !== undefined && s.keys !== null) {
    if (!isObj(s.keys))
      throw new Error("secrets.keys: a mapping of vault/item/field to a NAME");
    for (const [k, v] of Object.entries(s.keys)) {
      name(k, "secrets.keys");
      if (typeof v !== "string" || !ENV_NAME_RE.test(v))
        throw new Error(`secrets.keys.${k}: an env var's NAME, ${NOT_A_VALUE}`);
    }
  }
  if (s.refs !== undefined && s.refs !== null) {
    if (!isObj(s.refs))
      throw new Error(
        "secrets.refs: a mapping of name to { vault, item, field }",
      );
    for (const [k, v] of Object.entries(s.refs)) {
      if (typeof v === "string") {
        if (!SECRET_SOURCE_RE.test(v))
          throw new Error(`secrets.refs.${k}: ${NOT_A_VALUE}`);
        continue;
      }
      if (!isObj(v))
        throw new Error(`secrets.refs.${k}: { vault, item, field }`);
      for (const [f, x] of Object.entries(v)) {
        if (!["vault", "item", "field"].includes(f))
          throw new Error(`secrets.refs.${k}.${f}: vault, item or field only`);
        name(x, `secrets.refs.${k}.${f}`);
      }
    }
  }
}

/** Issue 1391: agents.runtimes.<id>.bin, an absolute path to a program. */
function checkRuntimes(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (!isObj(raw))
    throw new Error("agents.runtimes: a mapping of runtime to { bin }");
  for (const [id, r] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id))
      throw new Error(`agents.runtimes.${cut(id)}: not a runtime's id`);
    if (r === null) continue;
    if (!isObj(r) || Object.keys(r).some((k) => k !== "bin"))
      throw new Error(`agents.runtimes.${id}: { bin: /path/to/program }`);
    const bin = (r as Record<string, unknown>).bin;
    if (bin === undefined || bin === null) continue;
    if (typeof bin !== "string" || !path.isAbsolute(bin))
      throw new Error(
        `agents.runtimes.${id}.bin: an absolute path to a program`,
      );
    let ok = false;
    try {
      const st = fs.statSync(bin);
      ok = st.isFile() && (st.mode & 0o111) !== 0;
    } catch {
      ok = false;
    }
    if (!ok)
      throw new Error(
        `agents.runtimes.${id}.bin: no program there (${cut(bin)})`,
      );
  }
}

type FieldPatch = (
  user: Record<string, unknown>,
  v: unknown,
) => { ok: true } | { ok: false; error: string };

/**
 * Vision's ruling (issue 1391): no setting is the person's with no way for
 * an agent to ask. Settings' own fields, each through the check Settings
 * applies to it, and the other keys it may change with it (`also`).
 */
const FIELD_KEYS: readonly {
  key: string;
  patch: FieldPatch;
  also?: readonly string[];
}[] = [
  {
    key: "agents.default_mode",
    patch: (u, v) => {
      const agents = { ...((u.agents as Record<string, unknown>) ?? {}) };
      if (v === null || v === "") delete agents.default_mode;
      else
        try {
          agents.default_mode = checkIntent(v, "agents.default_mode");
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      if (Object.keys(agents).length) u.agents = agents;
      else delete u.agents;
      return { ok: true };
    },
  },
  {
    key: "server_agent.self_update",
    also: ["server_agent.self_update_from"],
    patch: (u, v) => {
      const x = v ?? "ask";
      if (x !== "ask" && x !== "auto")
        return {
          ok: false,
          error: "server_agent.self_update: ask, auto or null",
        };
      const sa = { ...((u.server_agent as Record<string, unknown>) ?? {}) };
      delete sa.self_update_from;
      sa.self_update = x;
      u.server_agent = sa;
      return { ok: true };
    },
  },
  { key: "hub.allow_tools", patch: patchHubAllowTools },
  { key: "hub.delivery_loop", patch: patchHubDeliveryLoop },
  {
    key: "hub.url",
    // A new address drops the token, never sent to another Hub.
    also: ["hub.token", "hub.mcp_url"],
    patch: (u, v) => {
      const h = patchHubUrl(u, v);
      return h.ok ? { ok: true } : h;
    },
  },
  ...(["desktop", "phone"] as const).map((k) => ({
    key: `alerts.${k}`,
    patch: ((u, v) => patchAlerts(u as UserConfig, { [k]: v })) as FieldPatch,
  })),
  ...(["from", "to"] as const).map((k) => ({
    key: `alerts.quiet.${k}`,
    patch: ((u, v) =>
      patchAlerts(u as UserConfig, { [`quiet_${k}`]: v })) as FieldPatch,
  })),
  { key: "editor_open", patch: (u, v) => patchEditorOpen(u as UserConfig, v) },
  { key: "embed", patch: (u, v) => patchEmbed(u as UserConfig, v) },
  {
    key: "web.machine_name",
    patch: (u, v) => {
      let name: string | null;
      try {
        name = parseMachineName(v);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const web = { ...((u.web as Record<string, unknown>) ?? {}) };
      if (name) web.machine_name = name;
      else delete web.machine_name;
      if (Object.keys(web).length) u.web = web;
      else delete u.web;
      return { ok: true };
    },
  },
  ...(["dock", "collapsed"] as const).map((k) => ({
    key: `shell.${k}`,
    patch: ((u, v) => {
      if (v !== null && typeof v !== "boolean")
        return { ok: false, error: `shell.${k}: true, false or null` };
      setPath(u, `shell.${k}`, v);
      return { ok: true };
    }) as FieldPatch,
  })),
  {
    key: "shell.pins",
    patch: (u, v) => {
      if (
        v !== null &&
        (!Array.isArray(v) ||
          v.length > 200 ||
          !v.every(
            (x) =>
              typeof x === "string" &&
              /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(x),
          ))
      )
        return {
          ok: false,
          error: "shell.pins: a list of repos or repo/service names, or null",
        };
      setPath(u, "shell.pins", v);
      return { ok: true };
    },
  },
];

/** Issue 1391: Settings › Embedding's keys, each asked for on its own. */
const EMBED_KEYS: readonly string[] = [
  "origins",
  "url_max_chars",
  "key_minutes",
  "context_max_kb",
  "app_key_audit_window_seconds",
  "feed_event_max_kb",
  "feed_events_per_minute",
  "feed_keep_events",
  "feed_list_max_mb",
  "feed_list_timeout_seconds",
  "feed_max_streams",
  "feed_read_max_kb",
  "paste_max_kb",
];

/** Issue 1391: one embed setting, as Settings › Embedding checks it. */
function embedPatch(u: Record<string, unknown>, key: string, v: unknown) {
  const sub = key.slice("embed.".length);
  if (!EMBED_KEYS.includes(sub))
    return { ok: false as const, error: "", unknown: true as const };
  return patchEmbed(u as UserConfig, { [sub]: v });
}

/** `config`'s top-level keys setting_change takes. */
const TOP_LEVEL = [
  "install_mode",
  "local_dev",
  "cli_tabs",
  "log_window_lines",
  "editor",
  "terminal",
  "editor_overrides",
] as const;

/** `config`'s top-level keys: the switches Settings checks, and programs. */
function patchTopLevel(
  user: Record<string, unknown>,
  key: string,
  v: unknown,
): Patch | null {
  if (["local_dev", "cli_tabs", "log_window_lines"].includes(key))
    return patchCliRows(user, { [key]: v }, { cli: true });
  if (key === "install_mode") {
    if (v !== null && v !== "personal" && v !== "strict")
      return { ok: false, error: "install_mode: personal or strict, or null" };
    setPath(user, key, v);
    return { ok: true };
  }
  // Issue 1391: checked as Settings checks them, a known editor or
  // terminal, by its key (never an arbitrary command).
  if (key === "editor" || key === "terminal") {
    const known = key === "editor" ? isKnownEditorKey : isKnownTerminalKey;
    if (v !== null && (typeof v !== "string" || !known(v)))
      return {
        ok: false,
        error: `${key}: one Den knows (as Settings lists them), or null`,
      };
    setPath(user, key, v);
    return { ok: true };
  }
  if (key === "editor_overrides" || key.startsWith("editor_overrides.")) {
    const langs = new Set<string>(SUPPORTED_LANGUAGES.map((l) => l.key));
    const one = (lang: string, x: unknown) =>
      langs.has(lang) &&
      (x === null || (typeof x === "string" && isKnownEditorKey(x)));
    const lang = key.slice("editor_overrides.".length);
    const ok =
      key === "editor_overrides"
        ? v === null ||
          (isObj(v) && Object.entries(v).every(([l, x]) => one(l, x)))
        : one(lang, v);
    if (!ok)
      return {
        ok: false,
        error: `${key}: a language Den knows and an editor it knows (as Settings lists them), or null`,
      };
    setPath(user, key, v);
    return { ok: true };
  }
  return null;
}

/** Applies `key = value` to `user` with the checks Den reads it by. */
function patchKey(
  user: Record<string, unknown>,
  key: string,
  value: unknown,
  den: DenConfig,
): Patch {
  const top = patchTopLevel(user, key, value);
  if (top) return top;
  if (key.startsWith("embed.")) return embedPatch(user, key, value);
  const field = FIELD_KEYS.find((f) => matchesSetting(f.key, key));
  if (field) return field.patch(user, value);
  if (configKeyNames().includes(key)) return patchConfigKey(user, key, value);
  const entry = SETTING_KEYS.find((e) => matchesSetting(e.key, key));
  if (!entry)
    return { ok: false, unknown: true, error: `unknown setting ${key}` };
  if (entry.refuse)
    return { ok: false, error: `${key} isn't changed here: ${entry.refuse}` };
  setPath(user, key, value);
  try {
    entry.check(user as UserConfig, den);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true };
}

/** Every leaf path where `a` and `b` differ. */
function changedPaths(a: unknown, b: unknown, at: string[] = []): string[][] {
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => changedPaths(a[k], b[k], [...at, k]));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
}

function getPath(o: unknown, parts: readonly string[]): unknown {
  let cur = o;
  for (const p of parts) {
    if (!isObj(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * A value as the card and the audit show it: whole (review C, issue 1371:
 * a cut could hide the end of a command the person allows). A new value
 * has no control characters and is at most SETTING_VALUE_MAX long
 * (valueProblem), so this is exactly what is written; the file's own
 * value is shown on one line.
 */
function shown(v: unknown): string {
  if (v === undefined) return "not set";
  return plainText(typeof v === "string" ? v : JSON.stringify(v));
}

/**
 * Issue 1391: a value as the activity trail shows it. Agents may read the
 * trail, so a text, list or mapping (a command may carry a password typed
 * into it) is said by its length only; a number, a switch, "not set" and
 * Den's default are said as they are.
 */
function trailValue(
  v: unknown,
  byDefault: string,
): { text: string; plain: boolean } {
  if (v === undefined) return { text: "not set", plain: true };
  if (v === null) return { text: byDefault, plain: true };
  if (typeof v === "number" || typeof v === "boolean")
    return { text: String(v), plain: true };
  return { text: `${shown(v).length} characters`, plain: false };
}

/** Issue 1391: `key: was → now`, or "changed" when either is free text. */
function trailChange(
  key: string,
  was: unknown,
  now: unknown,
  byDefault: string,
): string {
  const a = trailValue(was, byDefault);
  const b = trailValue(now, byDefault);
  return a.plain && b.plain
    ? `${key}: ${a.text} → ${b.text}`
    : `${key}: changed (was ${a.text}, now ${b.text})`;
}

/**
 * Issue 1391: an error goes into the trail as a refused ask's reason, so
 * a free-text value it quotes is said by its length.
 */
function scrubbed(error: string, v: unknown): string {
  if (trailValue(v, "").plain) return error;
  const forms = new Set<string>([shown(v), JSON.stringify(v)]);
  if (isObj(v))
    for (const x of Object.values(v))
      if (typeof x === "string") forms.add(plainText(x));
  let out = error;
  for (const f of [...forms].sort((a, b) => b.length - a.length))
    if (f) out = out.split(f).join(`<${f.length} characters>`);
  return out;
}

/** Only for a name refused before it is read: cut, as it is no setting. */
function cut(v: string): string {
  const s = plainText(v);
  return s.length > SHOWN_MAX ? `${s.slice(0, SHOWN_MAX - 1)}…` : s;
}

/** The longest new value, as JSON: one the person can read on the card. */
export const SETTING_VALUE_MAX = 2000;

/** Why a new value can't be shown as written; null when it can. */
function valueProblem(v: unknown): string | null {
  if (JSON.stringify(v).length > SETTING_VALUE_MAX)
    return `the value is too long to show the person whole (at most ${SETTING_VALUE_MAX} characters): a person sets it in Settings`;
  const texts: string[] = [];
  const walk = (x: unknown): void => {
    if (typeof x === "string") texts.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (isObj(x))
      for (const [k, y] of Object.entries(x)) {
        texts.push(k);
        walk(y);
      }
  };
  walk(v);
  if (texts.some((t) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(t)))
    return "the value has control characters (new lines, terminal escapes, direction marks): the card couldn't show it as written";
  return null;
}

/**
 * Every key setting_change takes: `config`'s top-level and dotted ones,
 * and SETTING_KEYS' patterns. A test places each on NARROW_SETTINGS or
 * WIDENING_SETTINGS.
 */
export function settingChangeKeys(): string[] {
  return [
    ...TOP_LEVEL,
    ...configKeyNames().filter((k) => k.includes(".")),
    ...SETTING_KEYS.map((e) => e.key),
    ...FIELD_KEYS.map((e) => e.key),
    ...EMBED_KEYS.map((k) => `embed.${k}`),
  ];
}

/** What a near miss was meant to be: the known key it is closest to. */
function nearest(key: string): string | undefined {
  const known = [
    ...configKeyNames().filter((k) => k.includes(".")),
    ...SETTING_KEYS.filter((e) => !e.key.includes("*")).map((e) => e.key),
    ...FIELD_KEYS.map((e) => e.key),
  ];
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0]!;
      d[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const t = d[j]!;
        d[j] = Math.min(
          d[j]! + 1,
          d[j - 1]! + 1,
          prev + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        prev = t;
      }
    }
    return d[b.length]!;
  };
  let best: string | undefined;
  let bestD = 4;
  for (const k of known) {
    const n = dist(key, k);
    if (n < bestD) [best, bestD] = [k, n];
  }
  return best;
}

export interface SettingChangeDeps {
  /** config/local/user.yml's path. */
  userFile: string;
  /** Where backups of user.yml go (the state folder's settings-backups). */
  backupDir: string;
  /** The distribution's config (for the readers that check a key). */
  denConfig: () => DenConfig;
  /** One audit row: the change, who asked, and why. */
  audit: (detail: string, reason?: string) => void;
  now: () => string;
}

export interface SettingChangeArgs {
  key: string;
  /** null: back to Den's default (the key is taken out). */
  value: unknown;
  reason: string;
}

export type SettingChangeCheck =
  | {
      ok: true;
      personOnly?: boolean;
      /** Issue 1371 Part 2: its category, for the approval policy. */
      category: SettingCategory;
      summary: string;
      params: Record<string, string>;
      details: string[];
      detailKeys: DetailKey[];
      args: SettingChangeArgs;
      kind: SettingKind;
      /** The file as it will be written. */
      text: string;
      before: unknown;
    }
  | { ok: false; error: string };

function reasonOf(v: unknown): string {
  if (typeof v !== "string") throw new Error("reason is required (text)");
  const r = plainText(v);
  if (!r)
    throw new Error("reason is required: say why the setting should change");
  if (r.length > SETTING_REASON_MAX)
    throw new Error(
      `reason must be ${SETTING_REASON_MAX} characters or fewer (got ${r.length})`,
    );
  return r;
}

/** Reads user.yml as a document; an empty one when there is no file. */
function readDoc(file: string): yaml.Document {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const doc = yaml.parseDocument(raw);
  if (doc.errors.length)
    throw new Error(
      `config/local/user.yml doesn't parse: ${doc.errors[0]!.message}`,
    );
  return doc;
}

/**
 * Checks `key = value` against what Den reads; the card, the args and the
 * file as it will be written when it is fine. Writes nothing.
 */
/**
 * Issue 1391 (Den Builder): the concurrency caps. An agent may raise one,
 * without asking, up to twice its baseline: the last value the person set
 * or allowed (setting_baselines in user.yml), else the value in force
 * before any agent's routine raise. Lowering is always routine. 0 is no
 * limit, above any baseline.
 */
export const CAP_KEYS = [
  "agents.max_concurrent",
  "sessions.max_concurrent",
  "agents.resume.load_ceiling",
  // Issue 1417 (Builder 2): every agent limit setting_change takes. Past
  // twice its baseline asks on any install. Each one widens when raised: a
  // bigger read, a longer wait, a shell kept longer. Lowering one is
  // routine, except a guard's (LOWER_WIDENS).
  "agents.token_peer_wait_ms",
  "agents.turn_read_max_mb",
  "agents.restart_wait_minutes",
  "agents.rotation_wait_minutes",
  "agents.unasked_exit_window_minutes",
  "agents.lock_wait_minutes",
  "agents.exited_shell_minutes",
] as const;

/**
 * Issue 1417: the limits where lowering is what widens.
 * - unasked_exit_window_minutes: a second unasked exit within the window
 *   leaves the agent down (issue 926). A small window lets a crash loop
 *   come back every time. 0 is "never brought back", the safest value
 *   (SAFE_AT_ZERO), so a change to 0 is routine and any window above a 0
 *   asks.
 * - lock_wait_minutes: a lock that can't be read (its holder between
 *   making it and writing its pid) is taken over once older than the wait.
 *   A shorter wait can break a live holder's lock: two writers on one
 *   agent record.
 */
const LOWER_WIDENS: readonly string[] = [
  "agents.unasked_exit_window_minutes",
  "agents.lock_wait_minutes",
];
const SAFE_AT_ZERO: readonly string[] = ["agents.unasked_exit_window_minutes"];

const ZERO_IS_UNLIMITED: readonly string[] = [
  "agents.max_concurrent",
  "sessions.max_concurrent",
  "agents.resume.load_ceiling",
  "agents.exited_shell_minutes",
];

const isCap = (key: string): key is (typeof CAP_KEYS)[number] =>
  (CAP_KEYS as readonly string[]).includes(key);

/** A cap's value in force (defaults resolved); undefined when unreadable. */
function capInForce(
  key: (typeof CAP_KEYS)[number],
  den: DenConfig,
  user: UserConfig,
): number | undefined {
  try {
    if (key === "agents.max_concurrent")
      return readAgentsConfig(den, user).maxConcurrent;
    if (key === "sessions.max_concurrent")
      return readSessionsConfig(den, user).maxConcurrent;
    if (key === "agents.resume.load_ceiling")
      return agentsResume(() => user).loadCeiling;
    // Issue 1417: the other agent limits, from the one lookup.
    const v = limitInForce(key, user, den)?.value;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function storedBaseline(user: UserConfig, key: string): number | undefined {
  const b = user.setting_baselines;
  const v =
    b && typeof b === "object" && !Array.isArray(b)
      ? (b as Record<string, unknown>)[key]
      : undefined;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Whether this new value raises the cap past twice its baseline, or lowers a guard. */
function capRaisePast(
  key: (typeof CAP_KEYS)[number],
  value: unknown,
  den: DenConfig,
  user: UserConfig,
): boolean {
  const base = storedBaseline(user, key) ?? capInForce(key, den, user);
  // A guard put back to its default (null) may lower it: the person's.
  if (value === null) return LOWER_WIDENS.includes(key);
  if (typeof value !== "number") return true;
  if (base === undefined) return true;
  const inf = (n: number) =>
    n === 0 && ZERO_IS_UNLIMITED.includes(key) ? Infinity : n;
  if (
    LOWER_WIDENS.includes(key) &&
    inf(value) < inf(base) &&
    !(value === 0 && SAFE_AT_ZERO.includes(key))
  )
    return true;
  return inf(value) > 2 * inf(base);
}

/**
 * The baselines after a change: a routine agent raise keeps (or first
 * records) the baseline; the person's own set or Allow drops it, so the
 * value now in force is the baseline.
 */
function baselinesAfter(
  user: UserConfig,
  key: (typeof CAP_KEYS)[number],
  routine: boolean,
  den: DenConfig,
): Record<string, number> | undefined {
  const cur =
    user.setting_baselines &&
    typeof user.setting_baselines === "object" &&
    !Array.isArray(user.setting_baselines)
      ? { ...(user.setting_baselines as Record<string, number>) }
      : {};
  if (routine) {
    if (storedBaseline(user, key) === undefined) {
      const now = capInForce(key, den, user);
      if (now !== undefined) cur[key] = now;
    }
  } else delete cur[key];
  return Object.keys(cur).length ? cur : undefined;
}

/**
 * Issue 1391: the person changed settings by hand (Settings, the CLI):
 * a cap whose value in force moved takes it as its baseline.
 */
export function personSetCaps(
  was: UserConfig,
  now: UserConfig,
  den: DenConfig,
): void {
  for (const key of CAP_KEYS) {
    if (storedBaseline(now, key) === undefined) continue;
    if (capInForce(key, den, was) === capInForce(key, den, now)) continue;
    const b = baselinesAfter(now, key, false, den);
    if (b) now.setting_baselines = b;
    else delete now.setting_baselines;
  }
}

export function checkSettingChange(
  d: SettingChangeDeps,
  raw: Record<string, unknown>,
  /** person: the person's own change (Undo): a category's Never doesn't apply. */
  who: { agent?: string; person?: boolean; decidedBy?: string } = {},
): SettingChangeCheck {
  const no = (error: string): SettingChangeCheck => ({
    ok: false,
    error: scrubbed(error, raw.value),
  });
  try {
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!key)
      return no(
        "key is required: the setting's dotted name, e.g. sessions.max_concurrent",
      );
    if (!KEY_RE.test(key) || key.length > 200)
      return no(
        `${cut(key)} is not a setting's name (dotted words, e.g. sessions.max_concurrent)`,
      );
    if (!Object.hasOwn(raw, "value"))
      return no("value is required (null puts Den's default back)");
    const value = raw.value === undefined ? null : raw.value;
    const reason = reasonOf(raw.reason);
    const bad = value === null ? null : valueProblem(value);
    if (bad) return no(bad);
    const doc = readDoc(d.userFile);
    const before = (doc.toJS() ?? {}) as Record<string, unknown>;
    if (!isObj(before))
      return no(
        "config/local/user.yml is not a mapping: a person fixes it first",
      );
    const after = structuredClone(before);
    const p = patchKey(after, key, value, d.denConfig());
    if (!p.ok) {
      if (p.unknown) {
        const near = nearest(key);
        return no(
          `${key} is not a setting Den reads from config/local/user.yml${near ? ` (did you mean ${near}?)` : ""}`,
        );
      }
      return no(p.error);
    }
    const changed = changedPaths(before, after);
    if (!changed.length)
      return no(
        `${key} is already ${trailValue(value, "Den's default").text}: nothing to change`,
      );
    // The patch reaches only this key (or, for a block, inside it)...
    const parts = key.split(".");
    const own = (c: string[]) =>
      parts.every((s, i) => c[i] === s) || c.every((s, i) => parts[i] === s);
    const also = FIELD_KEYS.find((f) => matchesSetting(f.key, key))?.also ?? [];
    const stray = changed.find((c) => !own(c) && !also.includes(c.join(".")));
    if (stray)
      return no(
        `${key} would also change ${stray.join(".")}: ask for each setting on its own`,
      );
    const stored = getPath(after, parts);
    for (const c of changed) {
      const v = getPath(after, c);
      if (v === undefined) doc.deleteIn(c);
      else doc.setIn(c, v);
      // A block left empty goes, as Settings does.
      for (let n = c.length - 1; n > 0; n--) {
        const b = doc.getIn(c.slice(0, n), true);
        if (yaml.isMap(b) && b.items.length === 0) doc.deleteIn(c.slice(0, n));
      }
    }
    const text = doc.toString({ lineWidth: 0 });
    // Issue 1391: the mode the install is in now (never throws; a bad
    // value in either file is strict).
    const den = d.denConfig();
    const mode: InstallMode = readInstallMode(before as UserConfig, den);
    // Reviewer D (issue 1391): editor, terminal and runtimes are commands
    // Den runs as the person. Routine on personal only while every agent
    // is outside the sandbox (no new power); with any sandboxed, they'd
    // let one out, so they're judged as on strict.
    let sandboxed = mode === "strict";
    if (!sandboxed)
      try {
        const a = readAgentsConfig(den, before as UserConfig);
        sandboxed =
          a.sandbox !== false ||
          Object.values(a.agents ?? {}).some((x) => x?.sandbox === true);
      } catch {
        sandboxed = true;
      }
    if (
      key === "install_mode" &&
      value !== "strict" &&
      readInstallMode({}, den) === "strict"
    )
      return no(
        "The distribution's den.yml sets install_mode: strict, and a person can't loosen it: this change would do nothing.",
      );
    const kindOf =
      mode === "personal" &&
      sandboxed &&
      ROUTINE_ON_PERSONAL.some((pt) => matchesSetting(pt, key))
        ? {
            ...settingKind(key, "strict", value),
            category: settingKind(key, mode, value).category,
          }
        : settingKind(key, mode, value);
    // Issue 1391: a cap raised past twice its baseline is the person's.
    const kind =
      isCap(key) && capRaisePast(key, value, den, before as UserConfig)
        ? { ...kindOf, widens: true }
        : kindOf;
    // Issue 1371 Part 2: the person's choice for its category. Never
    // refuses here, naming the row that changes it.
    let set: ReturnType<typeof readPolicySetting>;
    try {
      set = readPolicySetting(before.approvals);
    } catch {
      set = undefined; // a bad policy is its own error; the ask still holds
    }
    const choice = settingChoice(kind.category, mode, set?.settings);
    if (choice.choice === "never" && !who.person)
      return no(
        `${key} isn't changed by agents: ${CATEGORY_LABEL[kind.category]} is set to Never in Settings › Approvals › Agents changing settings (approvals.settings.${kind.category}). A person changes it there.`,
      );
    const now = shown(getPath(before, parts));
    // Issue 1417: an unset limit's Now is the value in force, never
    // "not set", so the person sees what the change replaces.
    const inForce =
      getPath(before, parts) === undefined
        ? limitInForce(key, before as UserConfig, den)
        : undefined;
    const nowShown =
      inForce && inForce.from !== "user.yml"
        ? { value: shown(inForce.value), from: inForce.from }
        : null;
    const next = value === null ? "Den's default" : shown(stored ?? value);
    const lines: ReviewLine[] = [
      ...(kind.widens
        ? [
            line(
              "This widens what agents can do: only your own Allow runs it.",
              "ap.det.setting_change.widens",
            ),
          ]
        : []),
      line(`Setting: ${key}`, "ap.det.setting_change.key", { key }),
      nowShown?.from === "default"
        ? line(
            `Now: ${nowShown.value} (Den's default)`,
            "ap.det.setting_change.nowDefault",
            { value: nowShown.value },
          )
        : nowShown?.from === "den.yml"
          ? line(
              `Now: ${nowShown.value} (from den.yml)`,
              "ap.det.setting_change.nowDen",
              { value: nowShown.value },
            )
          : line(`Now: ${now}`, "ap.det.setting_change.now", { value: now }),
      line(`New: ${next}`, "ap.det.setting_change.new", { value: next }),
      line(`Why: ${reason}`, "ap.det.setting_change.why", { why: reason }),
      ...(who.agent
        ? [
            line(`Asked by ${who.agent}`, "ap.det.setting_change.by", {
              agent: who.agent,
            }),
          ]
        : []),
      line(
        `Den writes only ${key} in config/local/user.yml, keeps a copy of the file first, and notes the change in the audit.`,
        "ap.det.setting_change.writes",
        { key },
      ),
      kind.restart
        ? line(
            "Den reads it when it starts: it applies after a restart of Den (den_restart_server).",
            "ap.det.setting_change.restart",
          )
        : line("It applies at once.", "ap.det.setting_change.atOnce"),
    ];
    const r = reviewLines(lines);
    return {
      ok: true,
      ...(kind.widens ? { personOnly: true } : {}),
      category: kind.category,
      // Issue 1391: every approval row copies it into the trail; the
      // card's Now and New lines show the values whole.
      summary: trailChange(
        key,
        getPath(before, parts),
        value === null ? null : (stored ?? value),
        "Den's default",
      ),
      params: {
        key,
        now,
        value: next,
        ...(kind.widens ? { loosens: "1" } : {}),
      },
      details: r.details,
      detailKeys: r.detailKeys,
      args: { key, value, reason },
      kind,
      text,
      before,
    };
  } catch (e) {
    return no((e as Error).message);
  }
}

/** Keeps a copy of user.yml in the backups folder, and the newest few. */
function backup(d: SettingChangeDeps): string | undefined {
  if (!fs.existsSync(d.userFile)) return undefined;
  fs.mkdirSync(d.backupDir, { recursive: true, mode: 0o700 });
  const stamp = d.now().replace(/[:.]/g, "-");
  const file = path.join(d.backupDir, `user.yml.${stamp}`);
  fs.copyFileSync(d.userFile, file);
  fs.chmodSync(file, 0o600);
  const old = fs
    .readdirSync(d.backupDir)
    .filter((f) => f.startsWith("user.yml."))
    .sort()
    .reverse()
    .slice(SETTING_BACKUPS_KEPT);
  for (const f of old) fs.rmSync(path.join(d.backupDir, f), { force: true });
  return file;
}

/**
 * On Allow: checks again against the file as it is now, keeps a backup,
 * writes the one key and adds the audit line.
 */
export function runSettingChange(
  d: SettingChangeDeps,
  raw: Record<string, unknown>,
  asked?: { agent?: string; person?: boolean; decidedBy?: string },
):
  | {
      ok: true;
      key: string;
      value: unknown;
      /** Issue 1371 Part 2: the value before (null: unset), for Undo. */
      previous: unknown;
      /** What the key holds after (null: unset), for Undo's check. */
      set: unknown;
      restart: boolean;
      note: string;
      backup?: string;
    }
  | { ok: false; error: string } {
  const c = checkSettingChange(d, raw, asked);
  if (!c.ok) return c;
  const { key, value, reason } = c.args;
  // Issue 1391: a cap's baseline moves only on the person's set or Allow.
  let text = c.text;
  if (isCap(key)) {
    const routine = asked?.decidedBy?.startsWith("auto:") === true;
    const den = d.denConfig();
    const b = baselinesAfter(c.before as UserConfig, key, routine, den);
    const doc = yaml.parseDocument(text);
    if (b) doc.set("setting_baselines", b);
    else doc.delete("setting_baselines");
    text = doc.toString({ lineWidth: 0 });
  }
  const kept = backup(d);
  fs.mkdirSync(path.dirname(d.userFile), { recursive: true });
  writeFileAtomic(d.userFile, text);
  d.audit(
    `setting_change ${trailChange(key, getPath(c.before, key.split(".")), value, "default")}${asked?.agent ? ` (asked by ${asked.agent})` : ""}`,
    reason,
  );
  const restart = c.kind.restart === "server";
  const parts = key.split(".");
  const after = (yaml.parse(text) ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    key,
    value,
    previous: getPath(c.before, parts) ?? null,
    set: getPath(after, parts) ?? null,
    restart,
    note: restart
      ? `${key} is set. Den reads it when it starts: ask for den_restart_server to apply it.`
      : `${key} is set, and applies at once.`,
    ...(kept ? { backup: kept } : {}),
  };
}

/** The default deps: this install's user.yml, state folder and audit. */
export function settingChangeDeps(o: {
  userFile: string;
  stateDir: string;
  audit: SettingChangeDeps["audit"];
}): SettingChangeDeps {
  return {
    userFile: o.userFile,
    backupDir: path.join(o.stateDir, "settings-backups"),
    denConfig: () => {
      try {
        return readDenConfig();
      } catch {
        return {} as DenConfig;
      }
    },
    audit: o.audit,
    now: () => new Date().toISOString(),
  };
}

/**
 * Issue 1371 Part 2: Undo, the person's, of a setting an agent changed
 * without asking (`approval` is that held write as it ran). Puts the value
 * before back, as the person's own change: only when the key still holds
 * what that change set, so a second Undo, or one after a later change,
 * is refused.
 */
export function undoSettingChange(
  d: SettingChangeDeps,
  approval: {
    id: string;
    action: string;
    result?: unknown;
    /** Who decided it: auto:… is the policy, run without asking. */
    decidedBy?: string;
  },
): { ok: true; key: string; note: string } | { ok: false; error: string } {
  if (approval.action !== SETTING_CHANGE_ACTION)
    return { ok: false, error: "only a setting change can be undone here" };
  // Builder 2: Undo is for what ran without asking (its bell row has it);
  // a change the person allowed is changed back in Settings.
  if (!approval.decidedBy?.startsWith("auto:"))
    return {
      ok: false,
      error:
        "only a change that ran without asking can be undone here: change it in Settings",
    };
  const r = approval.result as
    | { ok?: unknown; key?: unknown; previous?: unknown; set?: unknown }
    | undefined;
  if (r?.ok !== true || typeof r.key !== "string" || !Object.hasOwn(r, "set"))
    return {
      ok: false,
      error: "that change didn't run, so there is nothing to undo",
    };
  const key = r.key;
  let now: unknown;
  try {
    now =
      getPath(
        (readDoc(d.userFile).toJS() ?? {}) as Record<string, unknown>,
        key.split("."),
      ) ?? null;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (JSON.stringify(now) !== JSON.stringify(r.set))
    return {
      ok: false,
      error: `${key} has changed since, so Undo would lose that: change it in Settings`,
    };
  const back = runSettingChange(
    d,
    { key, value: r.previous ?? null, reason: `Undo of ${approval.id}` },
    { person: true },
  );
  if (!back.ok) return back;
  return { ok: true, key, note: back.note };
}
