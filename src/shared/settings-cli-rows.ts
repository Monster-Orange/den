/**
 * MODE-5 (0.4.46): the settings only `<cli> config` could change, as
 * POST /api/settings fields. Each patches user.yml in place; null clears
 * a key (back to its default), and a block left empty goes too. Nothing
 * is changed when any field is wrong.
 *
 *   local_dev: boolean | null         user.yml local_dev
 *   cli_tabs: boolean | null          user.yml cli_tabs
 *   log_window_lines: int | null      user.yml log_window_lines
 *   panes_reconnect: { seconds?, max_seconds?, max_failures?,
 *     window_seconds?, connect_timeout_seconds? }   user.yml panes.*
 *   crash_loop: { restarts?, minutes?, max_wait_seconds? }
 *                                     user.yml web.crash_loop_*
 *   web_bridge: { listen?: auto | off, probe_seconds? }
 *                                     user.yml web.bridge_listen,
 *                                     web.bridge_probe_seconds (0.4.48)
 *   web_github: { owner_name_timeout_seconds? }
 *                                     user.yml web.owner_name_timeout_seconds
 *                                     (issue 406)
 *   web_ready: { probe_seconds?, start_seconds?, tools_probe_seconds? }
 *                                     user.yml web.ready_probe_seconds,
 *                                     web.start_wait_seconds, web.tools_probe_seconds
 *   web_pairing: { requests_per_minute?, approve_attempts?,
 *     approve_window_seconds? }      user.yml web.pair_requests_per_minute,
 *                                     web.approve_attempts,
 *                                     web.approve_window_seconds (issue 819)
 *   web_agent_view: { on?: boolean, minutes? }
 *                                     user.yml web.agent_view,
 *                                     web.agent_view_minutes (issue 796)
 *   web_sessions: { lock_wait_ms? }   user.yml web.sessions_lock_wait_ms
 *                                     (issue 1299)
 *   agents_list: { host_timeout_seconds?, refresh_timeout_seconds? }
 *                                     user.yml agents_list.* (den#156)
 *   agents_rotation: { defer_max_hours? }
 *                                     user.yml agents.rotation_defer_max_hours
 *                                     (issue 765)
 *   agents_resume: { batch?, gap_seconds?, load_ceiling?, max_wait_seconds? }
 *                                     user.yml agents.resume.* (issue 1129:
 *                                     the restart queue)
 *   agents_shell: { path_timeout_seconds? }
 *                                     user.yml agents.shell_path_timeout_seconds
 *                                     (issue 456)
 *   agents_draft: { hold_max_minutes? }
 *                                     user.yml agents.draft_hold_max_minutes
 *                                     (issue 1311)
 *   agent_issue_writes: { roles?: [role, …] | null, per_hour?,
 *     visibility_minutes? }           user.yml agents.issue_writes,
 *                                     agents.issue_writes_per_hour and
 *                                     agents.issue_writes_visibility_minutes
 *                                     (issue_write; issue 1127)
 *   agent_context: { compaction_loop_count?, compaction_loop_minutes?,
 *     pause_after_loop?, instruction_share_percent?, context_tokens? }
 *                                     user.yml agent_context.* (issue 278)
 *   reports: { screenshot_keep_days?, screenshot_max_mb?,
 *              hub_screenshot_max_mb?, hub_timeout_seconds? }
 *                                     user.yml reports.* (issue 403)
 *   server_log: { max_mb? }          user.yml server_log.* (issue 707)
 *   address_check: { timeout_seconds?, retries?, cache_seconds?, drop_after?,
 *     unknown_keep_seconds? }   (the last: web.address_unknown_keep_seconds)
 *                                     user.yml web.address_check_* (issue 455)
 *   feedback: { visibility_cache_hours?, visibility_timeout_seconds?,
 *     visibility_retry_seconds? }
 *                                     user.yml feedback.* (issue 415)
 *   process_lookup: { first_seconds?, retry_seconds? }
 *                                     user.yml process_lookup.* (issue 609)
 *   agent_hooks: { timeout_seconds?, retries?, backoff_seconds? }
 *                                     user.yml agent_hooks.* (issue 609)
 *   sessions: { max_concurrent?, close_grace_seconds?, pty_close_seconds?,
 *               pty_warn_above?, pty_machine_warn_percent? }
 *                                     user.yml sessions.* (issue 532),
 *                                     checked as den-config checks them
 *   agents_limits: { max_concurrent? } (AGENTS_SETTINGS_KEYS)
 *                                     user.yml agents.* (issue 1373), each
 *                                     winning over den.yml's, checked as
 *                                     den-config checks them
 *   held_writes: { wait_minutes? }   user.yml held_writes.* (issue 742)
 *   health_poll: { visible_seconds?, hidden_seconds? }   user.yml health_poll.* (issue 1022)
 *   git_reads: { at_once? }   user.yml git_reads.*
 *   github: { watch_interval_seconds?, watch_max_interval_seconds?,
 *     api_budget_floor?, watches_max?, watch_stale_minutes?,
 *     watch_max_open_hours?, rerun_look_minutes? }
 *                                     user.yml github.* (the shared GitHub
 *                                     watcher, github-watch/settings.ts)
 *   keep_running_after_logout: boolean | null
 *                                     user.yml agents.keep_running_after_logout
 *   restore_services_on_boot: boolean | null
 *                                     user.yml services.restore_on_boot
 *                                     (issue 1225; 0.4.46's switch)
 *                                     (issue 163: `service install`'s mode)
 */
import { CONTEXT_WATCH_KEYS } from "./agents/context-watch.js";
import {
  SHOT_KEEP_DAYS_MAX,
  SHOT_KEEP_DAYS_MIN,
  SHOT_LIMITS,
} from "./report-shots.js";
import {
  AGENT_VIEW_RANGE,
  SESSIONS_LOCK_WAIT_RANGE,
  PAIR_LIMITS,
  WEB_WAIT_RANGE,
} from "./web/web-session.js";
import { VISIBILITY_LIMITS } from "./report-store.js";
import {
  ROTATION_DEFER_MAX_HOURS,
  AGENTS_RESUME_LIMITS,
  HELD_WAIT_MINUTES,
  SESSIONS_SETTINGS_KEYS,
  DRAFT_HOLD_MAX_MINUTES,
  SHELL_PATH_TIMEOUT,
  sessionsValueError,
  AGENTS_SETTINGS_KEYS,
  agentsLimitValueError,
} from "./den-config.js";
import { HEALTH_POLL } from "./health-poll.js";
import { GIT_READS } from "./git-reads.js";
import {
  ISSUE_WRITES_PER_HOUR,
  ISSUE_WRITES_VISIBILITY_MINUTES,
} from "./issue-write.js";
import { ADDRESS_CHECK_LIMITS } from "./edge/address-check.js";
import { LOOKUP_LIMITS } from "../ui/cli/proc-lookup.js";
import { HOOK_CALL_LIMITS } from "./agents/guardrails/hook-call.js";
import { GITHUB_WATCH_LIMITS } from "./github-watch/settings.js";
import { SERVER_LOG_LIMITS } from "./server-log-file.js";

/** The settings a person changes and an agent never does. */
export const PERSON_ONLY_SETTINGS = [
  "agents_default_mode",
  "local_dev",
  "cli_tabs",
  "log_window_lines",
  "panes_reconnect",
  "crash_loop",
  // 0.4.48: whether Den listens on the Docker bridge for the edge (Linux).
  "web_bridge",
  // Issue 406: how long the start waits for the owner's GitHub name.
  "web_github",
  // den#143: how long `web up` waits for the server, on a busy machine too.
  "web_ready",
  // Issue 819: how many new-device requests and wrong codes are allowed.
  "web_pairing",
  // Issue 796: whether agents may view this Den's pages, read-only.
  "web_agent_view",
  // Issue 1299: how long a sessions write waits for another's lock.
  "web_sessions",
  // Issue 144: the machine's gate slots (every install and repo here).
  "gate_slots",
  // den#156: how long the Agents list waits for the terminal host.
  "agents_list",
  // Issue 1373: the agents' limits (agents at once and the waits). An
  // agent proposes one through setting_change, held for the person.
  "agents_limits",
  // Issue 403: how long a filed report's screenshot is kept here.
  "reports",
  // Issue 707: how large the server's log file on disk may grow.
  "server_log",
  // Issue 456: how long Den waits for the shell's PATH.
  "agents_shell",
  "agents_rotation",
  // Issue 1311: how long messages wait on a draft before the bell says so.
  "agents_draft",
  // Issue 1129: how many agents restart at a time, and how far apart.
  "agents_resume",
  // issue_write: which roles write GitHub issues, and how many an hour.
  "agent_issue_writes",
  // Issue 278: when an agent counts as stuck compacting, and whether Den
  // then holds its deliveries.
  "agent_context",
  // Review M5 (0.4.46): what agents may do without asking.
  "hub_allow_tools",
  // Issue 158: the Hub delivery loop in every agent's instructions.
  "hub_delivery_loop",
  // Issue 750: whether, and how long, Den reads Hub's groups.
  "hub_groups",
  // Issue 267: Hub's address (an agent asks with hub_connect).
  "hub_url",
  // The programs Den runs when a person opens a file or a terminal.
  "editor",
  "terminal",
  "editor_overrides",
  "shell",
  "editor_open",
  // The name the signed-out page shows for this machine.
  "machine_name",
  // SRV-P6 (0.4.48): whether Den updates itself without asking.
  "server_agent_self_update",
  // Issue 163: whether Den runs as LaunchDaemons that outlive a logout.
  "keep_running_after_logout",
  // Issue 1225: whether services that were up come back after a restart.
  "restore_services_on_boot",
  // Issue 103: deep links and the embedded agent pane (Settings › Embedding).
  "embed",
  // Issue 172: whether, and when, the person is alerted outside the bell.
  "alerts",
  // Issue 415: how long Report keeps, and waits for, a repo's visibility.
  "feedback",
  // Issue 455: how long, and how often, Den checks its own address.
  "address_check",
  // Issue 609: how long Den's process lookups wait.
  "process_lookup",
  // Issue 609: how agents' hooks wait for Den, and retry.
  "agent_hooks",
  // Issue 532: the terminal limits.
  "sessions",
  // Issue 1373: the agents' limits (user.yml agents.*).
  "agents_limits",
  // The shared GitHub watcher's pace and API budget: every agent's polls.
  "github",
  // Issue 160: the approval policy itself: an agent asks (approval_policy).
  "approvals_policy",
  "approvals_watch",
  "approvals_critical",
  // Issue 1371 Part 2: agents changing settings, per category.
  "approvals_settings",
  // Issue 1391: personal or strict.
  "install_mode",
  // Issue 742: how long a held write waits for the person's Allow.
  "held_writes",
  // Issue 1022: how often the page polls health, visible and hidden.
  "health_poll",
  "git_reads",
] as const;

/**
 * Issue 402: the person-only fields a test install's fixture person may
 * still change, as its pages do: the rail's prefs (pins, collapse, order,
 * dock), which a live check sets by pressing ☆/★. Never an agent's token
 * or a claimed agent, and never a field that names a program.
 *
 * Issue 946: pins are more than a view: a held write on a pinned item
 * waits for an Allow (approval-policy.ts). So the fixture person adds pins
 * and takes off only the ones it added (shell-prefs.ts fixtureSave); the
 * person's own pins always stay.
 */
export const FIXTURE_PAGE_SETTINGS: readonly string[] = ["shell"];

/**
 * The POST /api/settings fields anyone signed in may change, agents too,
 * each with why: how a page looks, never what runs or what agents may do.
 * Every other field is in PERSON_ONLY_SETTINGS (a test keeps the two
 * covering every field).
 */
export const SETTINGS_ANYONE: Readonly<Record<string, string>> = {
  graph: "the graph page's layout",
  appearance: "light or dark, and the accent",
  language: "the language pages are shown in",
  time_zone: "the time zone pages show date-times in",
  agents_layout: "how the Agents page lays out its cards",
  agents_helpers_shown: "whether helper agents show on the Agents page",
  coach_counts: "whether the Coach tab shows counts as totals or per day",
  bell_kinds: "which kinds of notice the bell shows",
  bell_fold_days: "how many days before the bell folds old notices",
};

/** One limit: its key in user.yml, the least it may be, whole or not. */
interface Limit {
  key: string;
  min: number;
  max: number;
  int: boolean;
}

const PANES: Record<string, Limit> = {
  seconds: { key: "reconnect_seconds", min: 0.1, max: 3600, int: false },
  max_seconds: {
    key: "reconnect_max_seconds",
    min: 0.1,
    max: 3600,
    int: false,
  },
  max_failures: {
    key: "reconnect_max_failures",
    min: 1,
    max: 10_000,
    int: true,
  },
  window_seconds: {
    key: "reconnect_window_seconds",
    min: 1,
    max: 86_400,
    int: false,
  },
  connect_timeout_seconds: {
    key: "connect_timeout_seconds",
    min: 1,
    max: 600,
    int: false,
  },
};

const CRASH: Record<string, Limit> = {
  restarts: { key: "crash_loop_restarts", min: 1, max: 1000, int: true },
  minutes: { key: "crash_loop_minutes", min: 1, max: 10_080, int: true },
  max_wait_seconds: {
    key: "crash_loop_max_wait_seconds",
    min: 0,
    max: 86_400,
    int: true,
  },
};

const BRIDGE: Record<string, Limit> = {
  probe_seconds: { key: "bridge_probe_seconds", min: 1, max: 600, int: false },
};

/**
 * Issue 403: how long a filed report's kept screenshot stays (days), the
 * largest kept and sent to Hub (MB), and how long Den waits for Hub (s).
 */
const REPORTS: Record<string, Limit> = {
  screenshot_keep_days: {
    key: "screenshot_keep_days",
    min: SHOT_KEEP_DAYS_MIN,
    max: SHOT_KEEP_DAYS_MAX,
    int: true,
  },
  screenshot_max_mb: {
    key: "screenshot_max_mb",
    min: SHOT_LIMITS.screenshot_max_mb.min,
    max: SHOT_LIMITS.screenshot_max_mb.max,
    int: false,
  },
  hub_screenshot_max_mb: {
    key: "hub_screenshot_max_mb",
    min: SHOT_LIMITS.hub_screenshot_max_mb.min,
    max: SHOT_LIMITS.hub_screenshot_max_mb.max,
    int: false,
  },
  hub_timeout_seconds: {
    key: "hub_timeout_seconds",
    min: SHOT_LIMITS.hub_timeout_seconds.min,
    max: SHOT_LIMITS.hub_timeout_seconds.max,
    int: false,
  },
};

/** Issue 707: the server's warning lines on disk, capped (MB). */
const SERVER_LOG: Record<string, Limit> = {
  max_mb: {
    key: "max_mb",
    min: SERVER_LOG_LIMITS.max_mb.min,
    max: SERVER_LOG_LIMITS.max_mb.max,
    int: false,
  },
};

/** Issue 406: the start's wait for the owner's public GitHub profile. */
const WEB_GITHUB: Record<string, Limit> = {
  owner_name_timeout_seconds: {
    key: "owner_name_timeout_seconds",
    min: 1,
    max: 600,
    int: false,
  },
};

/** den#143: `web up`'s waits (web-session.ts WEB_WAIT_RANGE). */
const WEB_READY: Record<string, Limit> = {
  probe_seconds: {
    key: "ready_probe_seconds",
    ...WEB_WAIT_RANGE,
    int: false,
  },
  start_seconds: {
    key: "start_wait_seconds",
    ...WEB_WAIT_RANGE,
    int: false,
  },
  tools_probe_seconds: {
    key: "tools_probe_seconds",
    ...WEB_WAIT_RANGE,
    int: false,
  },
};

/** Issue 819: the new-device limits (web-session.ts PAIR_LIMITS). */
const WEB_PAIRING: Record<string, Limit> = {
  requests_per_minute: {
    key: "pair_requests_per_minute",
    ...PAIR_LIMITS.pair_requests_per_minute,
  },
  approve_attempts: {
    key: "approve_attempts",
    ...PAIR_LIMITS.approve_attempts,
  },
  approve_window_seconds: {
    key: "approve_window_seconds",
    ...PAIR_LIMITS.approve_window_seconds,
  },
};

/** Issue 796: how long an agent's read-only view lasts (agent-view.ts). */
const WEB_AGENT_VIEW: Record<string, Limit> = {
  minutes: { key: "agent_view_minutes", ...AGENT_VIEW_RANGE, int: true },
};

/** Issue 1299: how long a sessions write waits for another's lock. */
const WEB_SESSIONS: Record<string, Limit> = {
  lock_wait_ms: {
    key: "sessions_lock_wait_ms",
    ...SESSIONS_LOCK_WAIT_RANGE,
    int: true,
  },
};

const AGENTS_LIST: Record<string, Limit> = {
  host_timeout_seconds: {
    key: "host_timeout_seconds",
    min: 1,
    max: 600,
    int: false,
  },
  refresh_timeout_seconds: {
    key: "refresh_timeout_seconds",
    min: 1,
    max: 600,
    int: false,
  },
};

/** Issue 456: user.yml agents.shell_path_timeout_seconds (den-config.ts). */
const AGENTS_SHELL: Record<string, Limit> = {
  path_timeout_seconds: {
    key: "shell_path_timeout_seconds",
    min: SHELL_PATH_TIMEOUT.min,
    max: SHELL_PATH_TIMEOUT.max,
    int: false,
  },
};

/** Issue 765: user.yml agents.rotation_defer_max_hours (den-config.ts). */
const AGENTS_ROTATION: Record<string, Limit> = {
  defer_max_hours: {
    key: "rotation_defer_max_hours",
    min: ROTATION_DEFER_MAX_HOURS.min,
    max: ROTATION_DEFER_MAX_HOURS.max,
    int: false,
  },
};

/** Issue 1311: user.yml agents.draft_hold_max_minutes (den-config.ts). */
const AGENTS_DRAFT: Record<string, Limit> = {
  hold_max_minutes: {
    key: "draft_hold_max_minutes",
    min: DRAFT_HOLD_MAX_MINUTES.min,
    max: DRAFT_HOLD_MAX_MINUTES.max,
    int: true,
  },
};

/** Issue 1129: user.yml agents.resume.* (den-config.ts agentsResume). */
const AGENTS_RESUME: Record<string, Limit> = Object.fromEntries(
  Object.entries(AGENTS_RESUME_LIMITS).map(([k, l]) => [k, { key: k, ...l }]),
);

/** issue_write: user.yml agents.issue_writes_per_hour (issue-write.ts). */
const AGENT_ISSUE_WRITES: Record<string, Limit> = {
  per_hour: {
    key: "issue_writes_per_hour",
    min: ISSUE_WRITES_PER_HOUR.min,
    max: ISSUE_WRITES_PER_HOUR.max,
    int: true,
  },
  // Issue 1127: how old a repo's visibility may be for the words check.
  visibility_minutes: {
    key: "issue_writes_visibility_minutes",
    min: ISSUE_WRITES_VISIBILITY_MINUTES.min,
    max: ISSUE_WRITES_VISIBILITY_MINUTES.max,
    int: true,
  },
};

/** Issue 455: the address check's limits (address-check.ts), in user.yml web. */
const ADDRESS_CHECK: Record<string, Limit> = Object.fromEntries(
  Object.entries(ADDRESS_CHECK_LIMITS).map(([k, l]) => [
    k,
    {
      // The sign-in's window has its own name in user.yml web.
      key:
        k === "unknown_keep_seconds"
          ? "address_unknown_keep_seconds"
          : `address_check_${k}`,
      min: l.min,
      max: l.max,
      int: k === "retries" || k === "drop_after",
    },
  ]),
);

/** Issue 609: user.yml process_lookup.* (proc-lookup.ts). */
const PROCESS_LOOKUP: Record<string, Limit> = Object.fromEntries(
  Object.entries(LOOKUP_LIMITS).map(([k, l]) => [
    k,
    { key: k, min: l.min, max: l.max, int: false },
  ]),
);

/** Issue 609: user.yml agent_hooks.* (hook-call.ts). */
const AGENT_HOOKS: Record<string, Limit> = Object.fromEntries(
  Object.entries(HOOK_CALL_LIMITS).map(([k, l]) => [
    k,
    { key: k, min: l.min, max: l.max, int: k === "retries" },
  ]),
);

/** Issue 415: user.yml feedback's visibility lookup (report-store.ts). */
const FEEDBACK: Record<string, Limit> = Object.fromEntries(
  Object.entries(VISIBILITY_LIMITS).map(([k, l]) => [
    k,
    { key: k, min: l.min, max: l.max, int: false },
  ]),
);

/** The shared GitHub watcher: user.yml github.* (github-watch/settings.ts). */
const GITHUB_WATCH: Record<string, Limit> = Object.fromEntries(
  Object.entries(GITHUB_WATCH_LIMITS).map(([k, l]) => [
    k,
    { key: k, min: l.min, max: l.max, int: true },
  ]),
);

/** Issue 278: user.yml agent_context's numbers (context-watch.ts). */
const AGENT_CONTEXT: Record<string, Limit> = Object.fromEntries(
  Object.entries(CONTEXT_WATCH_KEYS).map(([k, l]) => [k, { key: k, ...l }]),
);

/** Issue 742: user.yml held_writes.wait_minutes (den-config.ts). */
const HELD_WRITES: Record<string, Limit> = {
  wait_minutes: {
    key: "wait_minutes",
    min: HELD_WAIT_MINUTES.min,
    max: HELD_WAIT_MINUTES.max,
    int: true,
  },
};

/** Issue 1022: user.yml health_poll.* (health-poll.ts). */
const HEALTH_POLL_LIMITS: Record<string, Limit> = {
  visible_seconds: {
    key: "visible_seconds",
    ...HEALTH_POLL.visible,
    int: true,
  },
  hidden_seconds: { key: "hidden_seconds", ...HEALTH_POLL.hidden, int: true },
};

const GIT_READS_LIMITS: Record<string, Limit> = {
  at_once: { key: "at_once", ...GIT_READS, int: true },
};

/** The Log pane's lines: at least 1,000, at most 1,000,000. */
const LOG_LINES = { min: 1000, max: 1_000_000 };

type Patch = { ok: true } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function limitError(name: string, l: Limit, v: unknown): string | null {
  if (v === null) return null;
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < l.min ||
    v > l.max ||
    (l.int && !Number.isInteger(v))
  )
    return `${name} is ${l.int ? "a whole number" : "a number"} from ${l.min} to ${l.max}`;
  return null;
}

/** A block's limits: checked first, then written (null deletes). */
function patchBlock(
  user: Record<string, unknown>,
  field: string,
  block: string,
  limits: Record<string, Limit>,
  value: unknown,
  apply: (() => void)[],
): string | null {
  if (value === undefined) return null;
  if (!isObj(value))
    return `${field} is an object: ${Object.keys(limits).join(", ")}`;
  for (const [k, v] of Object.entries(value)) {
    const l = limits[k];
    if (!l)
      return `${field}.${k} is not a limit (${Object.keys(limits).join(", ")})`;
    const e = limitError(`${field}.${k}`, l, v);
    if (e) return e;
  }
  apply.push(() => {
    // "agents.resume": a block inside another; the outer one stays.
    const [outer, inner] = block.split(".", 2) as [string, string?];
    const host: Record<string, unknown> = inner
      ? isObj(user[outer])
        ? { ...user[outer] }
        : {}
      : user;
    const name = inner ?? outer;
    const b = isObj(host[name]) ? { ...host[name] } : {};
    for (const [k, v] of Object.entries(value)) {
      const key = limits[k]!.key;
      if (v === null) delete b[key];
      else b[key] = v;
    }
    if (Object.keys(b).length) host[name] = b;
    else delete host[name];
    if (inner) {
      if (Object.keys(host).length) user[outer] = host;
      else delete user[outer];
    }
  });
  return null;
}

/**
 * Issue 1373: user.yml agents.<limit> (AGENTS_SETTINGS_KEYS), checked
 * with den-config's own ranges and words. The rest of the person's agents
 * block (sandbox, git, layout, …) stays as it is.
 */
function patchAgentsLimits(
  user: Record<string, unknown>,
  value: unknown,
  apply: (() => void)[],
): string | null {
  if (value === undefined) return null;
  const keys: readonly string[] = AGENTS_SETTINGS_KEYS;
  if (!isObj(value)) return `the agents' limits are ${keys.join(", ")}`;
  for (const [k, v] of Object.entries(value)) {
    if (v === null && keys.includes(k)) continue;
    const e = agentsLimitValueError(k, v);
    if (e) return e;
  }
  apply.push(() => {
    const b = isObj(user.agents) ? { ...user.agents } : {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) delete b[k];
      else b[k] = v;
    }
    if (Object.keys(b).length) user.agents = b;
    else delete user.agents;
  });
  return null;
}

/**
 * Issue 532: user.yml sessions.*, the terminal limits, checked with
 * den-config's own ranges and words (sessionsValueError).
 */
function patchSessions(
  user: Record<string, unknown>,
  value: unknown,
  apply: (() => void)[],
): string | null {
  if (value === undefined) return null;
  const keys: readonly string[] = SESSIONS_SETTINGS_KEYS;
  if (!isObj(value)) return `the terminal limits are ${keys.join(", ")}`;
  for (const [k, v] of Object.entries(value)) {
    if (!keys.includes(k))
      return `${k} is not a terminal limit (${keys.join(", ")})`;
    if (v === null) continue;
    const e = sessionsValueError(k, v);
    if (e) return e;
  }
  apply.push(() => {
    const b = isObj(user.sessions) ? { ...user.sessions } : {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) delete b[k];
      else b[k] = v;
    }
    if (Object.keys(b).length) user.sessions = b;
    else delete user.sessions;
  });
  return null;
}

/**
 * The limits Settings has a row for, per field. `config` takes the rest
 * too (the first wait, the connect timeout): they have no row.
 */
export const PAGE_LIMITS = {
  panes_reconnect: ["max_failures", "window_seconds", "max_seconds"],
  crash_loop: ["restarts", "minutes", "max_wait_seconds"],
} as const;

const only = (all: Record<string, Limit>, names: readonly string[]) =>
  Object.fromEntries(names.map((n) => [n, all[n]!]));

/**
 * Patches `user` with the fields in `body`, or says what is wrong (and
 * changes nothing). `cli`: `config`'s, which takes every limit.
 */
export function patchCliRows(
  user: Record<string, unknown>,
  body: Record<string, unknown>,
  { cli = false }: { cli?: boolean } = {},
): Patch {
  const panes = cli ? PANES : only(PANES, PAGE_LIMITS.panes_reconnect);
  const crash = cli ? CRASH : only(CRASH, PAGE_LIMITS.crash_loop);
  const apply: (() => void)[] = [];
  for (const k of ["local_dev", "cli_tabs"] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "boolean")
      return { ok: false, error: `${k} is true, false or null` };
    apply.push(() => {
      if (v === null) delete user[k];
      else user[k] = v;
    });
  }
  // Issue 163: agents.keep_running_after_logout; the other agents keys stay.
  const keep = body.keep_running_after_logout;
  if (keep !== undefined) {
    if (keep !== null && typeof keep !== "boolean")
      return {
        ok: false,
        error: "keep_running_after_logout is true, false or null",
      };
    apply.push(() => {
      const a = isObj(user.agents) ? { ...user.agents } : {};
      if (keep === null) delete a.keep_running_after_logout;
      else a.keep_running_after_logout = keep;
      if (Object.keys(a).length) user.agents = a;
      else delete user.agents;
    });
  }
  // Issue 1225: services.restore_on_boot; the other services keys stay.
  const restore = body.restore_services_on_boot;
  if (restore !== undefined) {
    if (restore !== null && typeof restore !== "boolean")
      return {
        ok: false,
        error: "restore_services_on_boot is true, false or null",
      };
    apply.push(() => {
      const sv = isObj(user.services) ? { ...user.services } : {};
      if (restore === null) delete sv.restore_on_boot;
      else sv.restore_on_boot = restore;
      if (Object.keys(sv).length) user.services = sv;
      else delete user.services;
    });
  }
  const lines = body.log_window_lines;
  if (lines !== undefined) {
    if (
      lines !== null &&
      !(
        typeof lines === "number" &&
        Number.isInteger(lines) &&
        lines >= LOG_LINES.min &&
        lines <= LOG_LINES.max
      )
    )
      return {
        ok: false,
        error: `log_window_lines is a whole number from ${LOG_LINES.min} to ${LOG_LINES.max}`,
      };
    apply.push(() => {
      if (lines === null) delete user.log_window_lines;
      else user.log_window_lines = lines;
    });
  }
  // 0.4.48: web.bridge_listen (auto or off) and its probe's seconds.
  const wb = body.web_bridge;
  let bridgeRest: unknown = undefined;
  if (wb !== undefined) {
    if (!isObj(wb))
      return {
        ok: false,
        error: "web_bridge is an object: listen, probe_seconds",
      };
    const { listen, ...rest } = wb;
    if (
      listen !== undefined &&
      listen !== null &&
      listen !== "auto" &&
      listen !== "off"
    )
      return { ok: false, error: "web_bridge.listen is auto, off or null" };
    if (listen !== undefined)
      apply.push(() => {
        const w = isObj(user.web) ? { ...user.web } : {};
        if (listen === null) delete w.bridge_listen;
        else w.bridge_listen = listen;
        if (Object.keys(w).length) user.web = w;
        else delete user.web;
      });
    if (Object.keys(rest).length) bridgeRest = rest;
  }
  // Issue 796: web.agent_view (a switch) and how long a view lasts.
  const av = body.web_agent_view;
  let viewRest: unknown = undefined;
  if (av !== undefined) {
    if (!isObj(av))
      return { ok: false, error: "web_agent_view is an object: on, minutes" };
    const { on, ...rest } = av;
    if (on !== undefined && on !== null && typeof on !== "boolean")
      return { ok: false, error: "web_agent_view.on is true, false or null" };
    if (on !== undefined)
      apply.push(() => {
        const w = isObj(user.web) ? { ...user.web } : {};
        if (on === null) delete w.agent_view;
        else w.agent_view = on;
        if (Object.keys(w).length) user.web = w;
        else delete user.web;
      });
    if (Object.keys(rest).length) viewRest = rest;
  }
  // Issue 278: agent_context.pause_after_loop (a switch) and its numbers.
  const ac = body.agent_context;
  let contextRest: unknown = undefined;
  if (ac !== undefined) {
    if (!isObj(ac))
      return {
        ok: false,
        error: `agent_context is an object: pause_after_loop, ${Object.keys(AGENT_CONTEXT).join(", ")}`,
      };
    const { pause_after_loop: pause, ...rest } = ac;
    if (pause !== undefined && pause !== null && typeof pause !== "boolean")
      return {
        ok: false,
        error: "agent_context.pause_after_loop is true, false or null",
      };
    if (pause !== undefined)
      apply.push(() => {
        const b = isObj(user.agent_context) ? { ...user.agent_context } : {};
        if (pause === null) delete b.pause_after_loop;
        else b.pause_after_loop = pause;
        if (Object.keys(b).length) user.agent_context = b;
        else delete user.agent_context;
      });
    if (Object.keys(rest).length) contextRest = rest;
  }
  // issue_write: agents.issue_writes (a list of roles; [] none, null the
  // default) and its limit.
  const iw = body.agent_issue_writes;
  let issueRest: unknown = undefined;
  if (iw !== undefined) {
    if (!isObj(iw))
      return {
        ok: false,
        error:
          "agent_issue_writes is an object: roles, per_hour, visibility_minutes",
      };
    const { roles, ...rest } = iw;
    if (
      roles !== undefined &&
      roles !== null &&
      !(
        Array.isArray(roles) &&
        roles.every(
          (r) => typeof r === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(r),
        )
      )
    )
      return {
        ok: false,
        error:
          "agent_issue_writes.roles is a list of roles (lowercase letters, digits and -), or null",
      };
    if (roles !== undefined)
      apply.push(() => {
        const a = isObj(user.agents) ? { ...user.agents } : {};
        if (roles === null) delete a.issue_writes;
        else a.issue_writes = [...new Set(roles as string[])];
        if (Object.keys(a).length) user.agents = a;
        else delete user.agents;
      });
    if (Object.keys(rest).length) issueRest = rest;
  }
  const e =
    patchBlock(
      user,
      "agent_issue_writes",
      "agents",
      AGENT_ISSUE_WRITES,
      issueRest,
      apply,
    ) ??
    patchBlock(
      user,
      "agent_context",
      "agent_context",
      AGENT_CONTEXT,
      contextRest,
      apply,
    ) ??
    patchBlock(user, "web_bridge", "web", BRIDGE, bridgeRest, apply) ??
    patchBlock(user, "web_github", "web", WEB_GITHUB, body.web_github, apply) ??
    patchBlock(user, "web_ready", "web", WEB_READY, body.web_ready, apply) ??
    patchBlock(
      user,
      "web_pairing",
      "web",
      WEB_PAIRING,
      body.web_pairing,
      apply,
    ) ??
    patchBlock(
      user,
      "web_agent_view",
      "web",
      WEB_AGENT_VIEW,
      viewRest,
      apply,
    ) ??
    patchBlock(
      user,
      "web_sessions",
      "web",
      WEB_SESSIONS,
      body.web_sessions,
      apply,
    ) ??
    patchBlock(
      user,
      "panes_reconnect",
      "panes",
      panes,
      body.panes_reconnect,
      apply,
    ) ??
    patchBlock(user, "crash_loop", "web", crash, body.crash_loop, apply) ??
    patchBlock(
      user,
      "agents_list",
      "agents_list",
      AGENTS_LIST,
      body.agents_list,
      apply,
    ) ??
    patchBlock(user, "reports", "reports", REPORTS, body.reports, apply) ??
    patchBlock(
      user,
      "server_log",
      "server_log",
      SERVER_LOG,
      body.server_log,
      apply,
    ) ??
    patchBlock(
      user,
      "agents_shell",
      "agents",
      AGENTS_SHELL,
      body.agents_shell,
      apply,
    ) ??
    patchBlock(
      user,
      "agents_rotation",
      "agents",
      AGENTS_ROTATION,
      body.agents_rotation,
      apply,
    ) ??
    patchBlock(
      user,
      "agents_draft",
      "agents",
      AGENTS_DRAFT,
      body.agents_draft,
      apply,
    ) ??
    patchBlock(
      user,
      "agents_resume",
      "agents.resume",
      AGENTS_RESUME,
      body.agents_resume,
      apply,
    ) ??
    patchBlock(user, "feedback", "feedback", FEEDBACK, body.feedback, apply) ??
    patchBlock(
      user,
      "address_check",
      "web",
      ADDRESS_CHECK,
      body.address_check,
      apply,
    ) ??
    patchBlock(
      user,
      "process_lookup",
      "process_lookup",
      PROCESS_LOOKUP,
      body.process_lookup,
      apply,
    ) ??
    patchBlock(
      user,
      "agent_hooks",
      "agent_hooks",
      AGENT_HOOKS,
      body.agent_hooks,
      apply,
    ) ??
    patchSessions(user, body.sessions, apply) ??
    patchAgentsLimits(user, body.agents_limits, apply) ??
    patchBlock(
      user,
      "held_writes",
      "held_writes",
      HELD_WRITES,
      body.held_writes,
      apply,
    ) ??
    patchBlock(
      user,
      "health_poll",
      "health_poll",
      HEALTH_POLL_LIMITS,
      body.health_poll,
      apply,
    ) ??
    patchBlock(
      user,
      "git_reads",
      "git_reads",
      GIT_READS_LIMITS,
      body.git_reads,
      apply,
    ) ??
    patchBlock(user, "github", "github", GITHUB_WATCH, body.github, apply);
  if (e) return { ok: false, error: e };
  for (const f of apply) f();
  return { ok: true };
}
