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
  readAgentsConfig,
  readDenConfig,
  readMcpConfig,
  USER_ONLY_WIDENING,
  type DenConfig,
  type UserConfig,
} from "../../shared/den-config.js";
import { readPolicySetting } from "../../shared/approval-policy.js";
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
/** Part 2 adds more; "agent_powers" always asks the person. */
export type SettingCategory = "agent_powers" | "settings";

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
  "agents_list.host_timeout_seconds",
  "agents_list.refresh_timeout_seconds",
  "agents.max_concurrent",
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
];

/**
 * The keys that widen, named (any key not on NARROW_SETTINGS widens too):
 * the user.yml-only ones (USER_ONLY_WIDENING), the approval policy itself,
 * the programs and runtimes Den runs, and those that guard sign-in, what
 * agents see and do, what keeps running, and what goes to Hub.
 */
export const WIDENING_SETTINGS: readonly string[] = [
  ...USER_ONLY_WIDENING,
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
  "agents.keep_running_after_logout",
  "services.restore_on_boot",
  "held_writes.wait_minutes",
  "hub.groups",
  "reports.hub_screenshot_max_mb",
  "agent_context.instruction_share_percent",
  "agent_context.context_tokens",
];

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
export function settingKind(key: string): SettingKind {
  // Fails closed: routine only when NARROW_SETTINGS names it.
  const widens =
    WIDENING_SETTINGS.some((p) => matchesSetting(p, key)) ||
    !NARROW_SETTINGS.some((p) => matchesSetting(p, key));
  const restart = AT_START.some((p) => matchesSetting(p, key))
    ? ("server" as const)
    : undefined;
  return widens
    ? {
        category: "agent_powers",
        severity: "high",
        widens: true,
        ...(restart ? { restart } : {}),
      }
    : {
        category: "settings",
        severity: "medium",
        widens: false,
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
  // The cap on agents running at once (per machine, issue 1371).
  {
    key: "agents.max_concurrent",
    check: (u, d) => void readAgentsConfig(d, u),
  },
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
  {
    key: "secrets.**",
    check: () => undefined,
    refuse: "where secrets come from is set by the person, in Settings",
  },
  {
    key: "agents.runtime_catalog",
    check: () => undefined,
    refuse: "the runtimes agents run as are set by the person, in Settings",
  },
  {
    key: "agents.runtime_catalog.**",
    check: () => undefined,
    refuse: "the runtimes agents run as are set by the person, in Settings",
  },
  {
    key: "agents.runtimes.**",
    check: () => undefined,
    refuse: "the runtimes agents run as are set by the person, in Settings",
  },
];

/** `config`'s top-level keys setting_change takes. */
const TOP_LEVEL = [
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
  if (key === "editor" || key === "terminal") {
    if (v !== null && (typeof v !== "string" || !v.trim()))
      return { ok: false, error: `${key} is a command (text), or null` };
    setPath(user, key, v);
    return { ok: true };
  }
  if (key === "editor_overrides" || key.startsWith("editor_overrides.")) {
    const ok = (x: unknown) =>
      x === null ||
      (typeof x === "string" && !!x.trim()) ||
      (key === "editor_overrides" &&
        isObj(x) &&
        Object.values(x).every((y) => typeof y === "string" && !!y.trim()));
    if (!ok(v))
      return {
        ok: false,
        error: `${key} is ${key === "editor_overrides" ? "a mapping of" : ""} a command (text), or null`,
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
  ];
}

/** What a near miss was meant to be: the known key it is closest to. */
function nearest(key: string): string | undefined {
  const known = [
    ...configKeyNames().filter((k) => k.includes(".")),
    ...SETTING_KEYS.filter((e) => !e.key.includes("*")).map((e) => e.key),
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
export function checkSettingChange(
  d: SettingChangeDeps,
  raw: Record<string, unknown>,
  who: { agent?: string } = {},
): SettingChangeCheck {
  const no = (error: string): SettingChangeCheck => ({ ok: false, error });
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
        `${key} is already ${value === null ? "Den's default" : shown(value)}: nothing to change`,
      );
    // The patch reaches only this key (or, for a block, inside it)...
    const parts = key.split(".");
    const own = (c: string[]) =>
      parts.every((s, i) => c[i] === s) || c.every((s, i) => parts[i] === s);
    const stray = changed.find((c) => !own(c));
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
    const kind = settingKind(key);
    const now = shown(getPath(before, parts));
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
      line(`Now: ${now}`, "ap.det.setting_change.now", { value: now }),
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
      summary: `${key}: ${now} → ${next}`,
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
  asked?: { agent?: string },
):
  | {
      ok: true;
      key: string;
      value: unknown;
      restart: boolean;
      note: string;
      backup?: string;
    }
  | { ok: false; error: string } {
  const c = checkSettingChange(d, raw, asked);
  if (!c.ok) return c;
  const { key, value, reason } = c.args;
  const kept = backup(d);
  fs.mkdirSync(path.dirname(d.userFile), { recursive: true });
  writeFileAtomic(d.userFile, c.text);
  d.audit(
    `setting_change ${key}: ${shown(getPath(c.before, key.split(".")))} → ${value === null ? "default" : shown(value)}${asked?.agent ? ` (asked by ${asked.agent})` : ""}`,
    reason,
  );
  const restart = c.kind.restart === "server";
  return {
    ok: true,
    key,
    value,
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
