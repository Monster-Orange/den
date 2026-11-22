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
 *   web_ready: { probe_seconds?, start_seconds? }
 *                                     user.yml web.ready_probe_seconds,
 *                                     web.start_wait_seconds (den#143)
 *   web_pairing: { requests_per_minute?, approve_attempts?,
 *     approve_window_seconds? }      user.yml web.pair_requests_per_minute,
 *                                     web.approve_attempts,
 *                                     web.approve_window_seconds (issue 819)
 *   agents_list: { host_timeout_seconds?, refresh_timeout_seconds? }
 *                                     user.yml agents_list.* (den#156)
 *   agents_shell: { path_timeout_seconds? }
 *                                     user.yml agents.shell_path_timeout_seconds
 *                                     (issue 456)
 *   agent_context: { compaction_loop_count?, compaction_loop_minutes?,
 *     pause_after_loop?, instruction_share_percent?, context_tokens? }
 *                                     user.yml agent_context.* (issue 278)
 *   reports: { screenshot_keep_days?, screenshot_max_mb?,
 *              hub_screenshot_max_mb?, hub_timeout_seconds? }
 *                                     user.yml reports.* (issue 403)
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
 *   keep_running_after_logout: boolean | null
 *                                     user.yml agents.keep_running_after_logout
 *                                     (issue 163: `service install`'s mode)
 */
import { CONTEXT_WATCH_KEYS } from "./agents/context-watch.js";
import {
  SHOT_KEEP_DAYS_MAX,
  SHOT_KEEP_DAYS_MIN,
  SHOT_LIMITS,
} from "./report-shots.js";
import { PAIR_LIMITS, WEB_WAIT_RANGE } from "./web-session.js";
import { VISIBILITY_LIMITS } from "./report-store.js";
import {
  SESSIONS_SETTINGS_KEYS,
  SHELL_PATH_TIMEOUT,
  sessionsValueError,
} from "./den-config.js";
import { ADDRESS_CHECK_LIMITS } from "./edge/address-check.js";
import { LOOKUP_LIMITS } from "../ui/cli/proc-lookup.js";
import { HOOK_CALL_LIMITS } from "./agents/guardrails/hook-call.js";

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
  // Issue 144: the machine's gate slots (every install and repo here).
  "gate_slots",
  // den#156: how long the Agents list waits for the terminal host.
  "agents_list",
  // Issue 403: how long a filed report's screenshot is kept here.
  "reports",
  // Issue 456: how long Den waits for the shell's PATH.
  "agents_shell",
  // Issue 278: when an agent counts as stuck compacting, and whether Den
  // then holds its deliveries.
  "agent_context",
  // Review M5 (0.4.46): what agents may do without asking.
  "hub_allow_tools",
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
  // Issue 160: the approval policy itself: an agent asks (approval_policy).
  "approvals_policy",
  "approvals_watch",
  "approvals_critical",
] as const;

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

/** Issue 278: user.yml agent_context's numbers (context-watch.ts). */
const AGENT_CONTEXT: Record<string, Limit> = Object.fromEntries(
  Object.entries(CONTEXT_WATCH_KEYS).map(([k, l]) => [k, { key: k, ...l }]),
);

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
    const b = isObj(user[block]) ? { ...user[block] } : {};
    for (const [k, v] of Object.entries(value)) {
      const key = limits[k]!.key;
      if (v === null) delete b[key];
      else b[key] = v;
    }
    if (Object.keys(b).length) user[block] = b;
    else delete user[block];
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
  if (!isObj(value)) return `sessions is an object: ${keys.join(", ")}`;
  for (const [k, v] of Object.entries(value)) {
    if (!keys.includes(k))
      return `sessions.${k} is not a terminal limit (${keys.join(", ")})`;
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
  const e =
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
      "agents_shell",
      "agents",
      AGENTS_SHELL,
      body.agents_shell,
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
    patchSessions(user, body.sessions, apply);
  if (e) return { ok: false, error: e };
  for (const f of apply) f();
  return { ok: true };
}
