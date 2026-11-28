/**
 * The SETTINGS registry covers every setting (R21, 0.3.0-dev.19).
 *
 * The inventory: every key `POST /api/settings` accepts, read from the
 * handler itself (the top-level `body.<key>` it reads, and for the blocks
 * it merges, the keys their prefs modules know), must have a row in Den's
 * registry (settings-registry.js) whose `keys` name it. A key the server
 * accepts with no row fails here, so no setting can be added to the API
 * without the Settings page showing it.
 *
 * The rules: every row has a scope (user, workspace or distribution); a
 * distribution row is read-only (no write); every row's category exists.
 */
import { PAGE_LIMITS } from "../../../src/shared/settings-cli-rows.js";
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { APPEARANCE_DEFAULTS } from "../../../src/ui/server/appearance-prefs.js";
import { GRAPH_DEFAULTS } from "../../../src/ui/server/graph-prefs.js";
import { SHELL_DEFAULTS } from "../../../src/ui/server/shell-prefs.js";
import { EMBED_DEFAULTS } from "../../../src/ui/server/embed-settings.js";
import {
  DEN_SETTINGS,
  DEN_SETTING_CATEGORIES,
} from "../../../src/ui/server/public/settings-registry.js";

const INDEX = fs.readFileSync(
  path.join(process.cwd(), "src", "ui", "server", "index.ts"),
  "utf-8",
);

/** The blocks POST merges as a whole, and the module that knows their keys. */
const BLOCKS: Record<string, Record<string, unknown>> = {
  graph: GRAPH_DEFAULTS as unknown as Record<string, unknown>,
  appearance: APPEARANCE_DEFAULTS as unknown as Record<string, unknown>,
  shell: SHELL_DEFAULTS as unknown as Record<string, unknown>,
  // MODE-5: the limits Settings has a row for.
  panes_reconnect: Object.fromEntries(
    PAGE_LIMITS.panes_reconnect.map((k) => [k, true]),
  ),
  crash_loop: Object.fromEntries(PAGE_LIMITS.crash_loop.map((k) => [k, true])),
  // 0.4.48: Den on the Docker bridge for the edge.
  web_bridge: { listen: true, probe_seconds: true },
  // Issue 406: how long the start waits for the owner's GitHub name.
  web_github: { owner_name_timeout_seconds: true },
  web_lists: { page_max: true },
  // den#143: how long `web up` waits for the server.
  web_ready: {
    probe_seconds: true,
    start_seconds: true,
    tools_probe_seconds: true,
  },
  // Issue 819: the new-device limits.
  web_pairing: {
    requests_per_minute: true,
    approve_attempts: true,
    approve_window_seconds: true,
  },
  // Issue 796: agents' read-only page views.
  web_agent_view: { on: true, minutes: true },
  // Issue 1299: how long a sessions write waits for another's lock.
  web_sessions: { lock_wait_ms: true },
  // Issue 144: the machine's gate slots.
  gate_slots: {
    cpu_slots: true,
    // Issue 751: cpu runs beside a browser run.
    cpu_slots_beside_browser: true,
    // Its follow-up: cpu runs beside a release browser run.
    cpu_slots_beside_release_browser: true,
    // Issue 1009: cpu runs wait at this load under a release run.
    cpu_hold_load: true,
    // Issue 1048: new cpu runs wait over this × the cores.
    load_hold_per_core: true,
    // Issue 1132: the start ceiling, its wait limit, leftovers' grace.
    max_start_load: true,
    max_start_wait_minutes: true,
    reap_grace_seconds: true,
    // Issue 1274: memory free under which new runs here wait; VM share.
    memory_free_min_percent: true,
    vm_memory_share: true,
    swap_hold_gb: true,
    // Issue 1349: a failed reading's last good value stands this long.
    memory_reading_keep_seconds: true,
    local_browser_slots: true,
    overrun_margin_minutes: true,
    // Issue 993: past this many times its estimate, in the bell.
    overrun_bell_multiple: true,
    remote_renew_seconds: true,
    remote_lapse_seconds: true,
    remote_max_slots: true,
    remote_max_asks: true,
    // Issue 715: release priority.
    priority_max: true,
    priority_pass_limit_minutes: true,
    release_pass_other_kind_minutes: true,
    priority_agents: true,
    // Issue 739: CI runners may ask for priority.
    priority_runners: true,
    // Issue 714: an agent's slot held over MCP.
    claim_minutes: true,
    mcp_renew_minutes: true,
    mcp_lapse_minutes: true,
    mcp_grace_minutes: true,
    // Issue 867: a gone waiter keeps its place this long.
    waiter_return_minutes: true,
    // Issue 625: test boxes' check and recheck.
    box_check_timeout_seconds: true,
    box_recheck_seconds: true,
    // A browser run on a macOS host declares a container browser.
    browser_requires_container: true,
    // Issue 803: priority classes per project, and their windows.
    class_order: true,
    class_map: true,
    class_windows: true,
    // Issue 1033: where a browser run with no --box goes, and the
    // projects and labels kept on this machine.
    browser_box_default: true,
    browser_host_only: true,
    // Issue 1264: Den's agent hook routes agents' heavy runs.
    route_agents: true,
    route_commands: true,
    throwaway_sweep: true,
  },
  // den#156: the Agents list's waits.
  agents_list: { host_timeout_seconds: true, refresh_timeout_seconds: true },
  // Issue 1373: the agents' limits (user.yml agents.*, over den.yml).
  agents_limits: {
    max_concurrent: true,
    max_per_project: true,
    max_subagents: true,
    subagents_respect_load_hold: true,
  },
  // Issue 403: how long a filed report's screenshot is kept.
  reports: {
    screenshot_keep_days: true,
    screenshot_max_mb: true,
    hub_screenshot_max_mb: true,
    hub_timeout_seconds: true,
  },
  // Issue 707: the server's warning lines on disk, capped.
  server_log: { max_mb: true, slow_request_ms: true, event_loop_lag_ms: true },
  // Issue 456: how long Den waits for the shell's PATH.
  agents_shell: { path_timeout_seconds: true },
  // Issue 1311: how long messages wait on a draft before the bell says so.
  agents_draft: { hold_max_minutes: true },
  // Issue 1129: the restart queue.
  agents_resume: {
    batch: true,
    gap_seconds: true,
    load_ceiling: true,
    max_wait_seconds: true,
  },
  // issue_write: which roles write GitHub issues, and how many an hour.
  // Issue 1127: and how old a repo's visibility may be for the words check.
  agent_issue_writes: {
    roles: true,
    per_hour: true,
    visibility_minutes: true,
    public: true,
  },
  // Issue 278: agents stuck compacting; instruction size.
  agent_context: {
    compaction_loop_count: true,
    compaction_loop_minutes: true,
    pause_after_loop: true,
    instruction_share_percent: true,
    context_tokens: true,
  },
  // Issue 103: Settings › Embedding.
  embed: EMBED_DEFAULTS as unknown as Record<string, unknown>,
  // Issue 172: alerts outside the bell, and quiet hours.
  // Issue 367: the push limits.
  alerts: {
    desktop: true,
    phone: true,
    quiet_from: true,
    quiet_to: true,
    push_timeout_seconds: true,
    push_ttl_seconds: true,
    finished: true,
    sound: true,
    tab_count: true,
    tab_first_seconds: true,
    max_streams: true,
  },
  // Issue 415: how long a Report destination's visibility is kept, waited for.
  feedback: {
    visibility_cache_hours: true,
    visibility_timeout_seconds: true,
    visibility_retry_seconds: true,
  },
  // Issue 455: how long, and how often, Den checks its own address.
  address_check: {
    timeout_seconds: true,
    retries: true,
    cache_seconds: true,
    // Failures in a row before the sign-in moves back off a proven address.
    drop_after: true,
    // How long can't-tell keeps it proven (web.address_unknown_keep_seconds).
    unknown_keep_seconds: true,
  },
  // Issue 609: how long Den's process lookups wait.
  process_lookup: { first_seconds: true, retry_seconds: true },
  // Issue 532: the terminal limits (user.yml sessions.*).
  sessions: {
    max_concurrent: true,
    close_grace_seconds: true,
    size_claim_grace_seconds: true,
    size_leave_grace_seconds: true,
    io_ping_seconds: true,
    pty_close_seconds: true,
    pty_warn_above: true,
    pty_machine_warn_percent: true,
  },
  // Issue 609: how agents' hooks wait for Den, and retry.
  agent_hooks: {
    timeout_seconds: true,
    retries: true,
    backoff_seconds: true,
  }, // The shared GitHub watcher's pace and API budget.
  github: {
    watch_interval_seconds: true,
    watch_max_interval_seconds: true,
    api_budget_floor: true,
    watches_max: true,
    // Issue 1166: a watch with no progress this long ends.
    watch_stale_minutes: true,
    // Issue 1194: any watch open this long ends.
    watch_max_open_hours: true,
    // Issue 1214: how often a finished run is looked at for a re-run.
    rerun_look_minutes: true,
  },
  // Issue 742: how long a held write waits for the person's Allow.
  held_writes: { wait_minutes: true },
  // Issue 1022: how often the page polls health, visible and hidden.
  health_poll: { visible_seconds: true, hidden_seconds: true },
  menu_load: { timeout_ms: true },
  git_reads: { at_once: true },
  // Issue 750: groups from Hub (user.yml hub.groups, groups_cache_seconds).
  hub_groups: { mode: true, cache_seconds: true },
};

/** Every key POST /api/settings accepts, from its handler's source. */
function acceptedKeys(source: string): string[] {
  const start = source.indexOf('if (pathname === "/api/settings") {');
  expect(start).toBeGreaterThan(0);
  const post = source.indexOf('if (req.method === "POST") {', start);
  // The handler ends where the next route begins.
  const end = source.indexOf("// ── API:", post);
  const handler = source.slice(post, end);
  const top = [
    ...new Set([...handler.matchAll(/\bbody\.([a-z_]+)/g)].map((m) => m[1])),
  ];
  expect(top.length).toBeGreaterThan(0);
  return top.flatMap((k) =>
    BLOCKS[k] ? Object.keys(BLOCKS[k]).map((sub) => `${k}.${sub}`) : [k],
  );
}

/** The accepted keys with no registry row naming them. */
function unregistered(
  accepted: string[],
  rows: readonly { keys?: string[] }[],
): string[] {
  const covered = new Set(rows.flatMap((r) => r.keys ?? []));
  return accepted.filter((k) => !covered.has(k));
}

describe("the settings inventory (R21)", () => {
  const accepted = acceptedKeys(INDEX);

  it("reads every key POST /api/settings accepts from the handler", () => {
    expect(accepted.sort()).toEqual(
      [
        // 0.4.46 MODE-UI: the install's mode for every agent.
        "agents_default_mode",
        // AG-4b: the Agents tab's layout.
        "agents_layout",
        // #80: how many running helpers an open badge shows.
        "agents_helpers_shown",
        "appearance.mode",
        // Bell v6: the person's notification kinds and fold days.
        "bell_fold_days",
        "bell_kinds",
        "appearance.theme",
        "editor",
        // AG-4b: where a path link in an agent's pane opens.
        "editor_open",
        "editor_overrides",
        "graph.density",
        "graph.direction",
        "graph.group",
        "graph.groupBy",
        "graph.panelWidth",
        "graph.workspaces",
        // HUB-1.5: Hub's tools without asking.
        "hub_allow_tools",
        // Issue 158: the Hub delivery loop in agents' instructions.
        "hub_delivery_loop",
        "hub_url",
        // The UI's language (R19, 0.3.0-dev.39).
        "language",
        // issue 206: the time zone date-times are shown in.
        "time_zone",
        // SEC-2a: the name the signed-out page gives this machine.
        "machine_name",
        // SRV-P6: whether Den updates itself without asking.
        "server_agent_self_update",
        // Issue 1225: whether services that were up come back after a restart.
        "restore_services_on_boot",
        "shell.collapsed",
        "shell.dock",
        "shell.dockHeight",
        // Issue 1444: the rail sections the person folded.
        "shell.folded",
        "shell.hidden",
        "shell.order",
        "shell.pins",
        // Issue 168: a project's colour, the person's own.
        "shell.projectColours",
        // 0.4.45: this person's project order.
        "shell.projectOrder",
        "terminal",
        // MODE-5: what only `config` could change.
        "cli_tabs",
        "coach_counts",
        "local_dev",
        "log_window_lines",
        "panes_reconnect.max_failures",
        "panes_reconnect.window_seconds",
        "panes_reconnect.max_seconds",
        "crash_loop.restarts",
        "crash_loop.minutes",
        "crash_loop.max_wait_seconds",
        // 0.4.48: Den on the Docker bridge for the edge (Linux).
        "web_agent_view.minutes",
        "web_agent_view.on",
        "web_bridge.listen",
        "web_bridge.probe_seconds",
        // Issue 406: the owner's GitHub name at start, its wait.
        "web_github.owner_name_timeout_seconds",
        "web_lists.page_max",
        // The shared GitHub watcher's pace and API budget.
        "github.watch_interval_seconds",
        "github.watch_max_interval_seconds",
        "github.api_budget_floor",
        "github.watches_max",
        "github.watch_stale_minutes",
        "github.watch_max_open_hours",
        "github.rerun_look_minutes",
        "web_pairing.approve_attempts",
        "web_pairing.approve_window_seconds",
        "web_pairing.requests_per_minute",
        // den#143: how long `web up` waits for the server.
        "web_ready.probe_seconds",
        "web_ready.start_seconds",
        "web_ready.tools_probe_seconds",
        // Issue 1299: how long a sessions write waits for another's lock.
        "web_sessions.lock_wait_ms",
        "gate_slots.box_check_timeout_seconds",
        "gate_slots.box_recheck_seconds",
        "gate_slots.browser_box_default",
        "gate_slots.browser_host_only",
        "gate_slots.browser_requires_container",
        "gate_slots.claim_minutes",
        "gate_slots.class_map",
        "gate_slots.class_order",
        "gate_slots.class_windows",
        "gate_slots.cpu_hold_load",
        "gate_slots.cpu_slots",
        "gate_slots.cpu_slots_beside_browser",
        "gate_slots.cpu_slots_beside_release_browser",
        "gate_slots.load_hold_per_core",
        "gate_slots.local_browser_slots",
        "gate_slots.max_start_load",
        "gate_slots.max_start_wait_minutes",
        "gate_slots.mcp_grace_minutes",
        "gate_slots.mcp_lapse_minutes",
        "gate_slots.mcp_renew_minutes",
        "gate_slots.memory_free_min_percent",
        "gate_slots.memory_reading_keep_seconds",
        "gate_slots.overrun_bell_multiple",
        "gate_slots.overrun_margin_minutes",
        "gate_slots.priority_agents",
        "gate_slots.priority_max",
        "gate_slots.priority_pass_limit_minutes",
        "gate_slots.priority_runners",
        "gate_slots.reap_grace_seconds",
        "gate_slots.release_pass_other_kind_minutes",
        "gate_slots.route_agents",
        "gate_slots.route_commands",
        "gate_slots.remote_lapse_seconds",
        "gate_slots.remote_max_asks",
        "gate_slots.remote_max_slots",
        "gate_slots.remote_renew_seconds",
        "gate_slots.swap_hold_gb",
        "gate_slots.throwaway_sweep",
        "gate_slots.vm_memory_share",
        "gate_slots.waiter_return_minutes",
        // den#156: the Agents list's waits.
        "agents_list.host_timeout_seconds",
        "agents_list.refresh_timeout_seconds",
        // Issue 1373: the agents' limits.
        "agents_limits.max_concurrent",
        "agents_limits.max_subagents",
        "agents_limits.subagents_respect_load_hold",
        "skill_packs",
        "agents_limits.max_per_project",
        // Issue 403: how long a filed report's screenshot is kept.
        "reports.screenshot_keep_days",
        "reports.screenshot_max_mb",
        "reports.hub_screenshot_max_mb",
        "reports.hub_timeout_seconds",
        // Issue 707: the server's warning lines on disk, capped.
        "server_log.max_mb",
        "server_log.slow_request_ms",
        "server_log.event_loop_lag_ms",
        // Issue 456: how long Den waits for the shell's PATH.
        "agents_shell.path_timeout_seconds",
        // Issue 1311: how long messages wait on a draft before the bell says so.
        "agents_draft.hold_max_minutes",
        // issue_write: which roles write GitHub issues, and how many an hour.
        "agent_issue_writes.roles",
        "agent_issue_writes.per_hour",
        "agent_issue_writes.visibility_minutes",
        "agent_issue_writes.public",
        // Issue 278: agents stuck compacting; instruction size.
        "agent_context.compaction_loop_count",
        "agent_context.compaction_loop_minutes",
        "agent_context.pause_after_loop",
        "agent_context.instruction_share_percent",
        "agent_context.context_tokens",
        // Issue 103: Settings › Embedding.
        "embed.url_max_chars",
        "embed.origins",
        "embed.key_minutes",
        "embed.context_max_kb",
        "embed.feed_event_max_kb",
        "embed.feed_events_per_minute",
        "embed.feed_max_streams",
        "embed.feed_keep_events",
        "embed.feed_read_max_kb",
        "embed.feed_list_timeout_seconds",
        "embed.feed_list_max_mb",
        "embed.paste_max_kb",
        // Issue 172: alerts outside the bell.
        "alerts.desktop",
        "alerts.phone",
        "alerts.quiet_from",
        "alerts.quiet_to",
        // Issue 367: how long a push may take, and a push service keeps it.
        "alerts.push_timeout_seconds",
        "alerts.push_ttl_seconds",
        "alerts.finished",
        "alerts.sound",
        "alerts.tab_count",
        "alerts.tab_first_seconds",
        "alerts.max_streams",
        // Issue 334: an app key's reads, one audit line per window.
        "embed.app_key_audit_window_seconds",
        // Issue 160: the install's approval policy.
        "approvals_policy",
        "approvals_watch",
        "approvals_critical",
        // Issue 1371 Part 2: agents changing settings, per category.
        "approvals_settings",
        // Issue 1391: personal or strict.
        "install_mode",
        // Issue 415: a Report destination's visibility, kept and waited for.
        "feedback.visibility_cache_hours",
        "feedback.visibility_timeout_seconds",
        "feedback.visibility_retry_seconds",
        // Issue 455: the address check's limits.
        "address_check.timeout_seconds",
        "address_check.retries",
        "address_check.cache_seconds",
        "address_check.drop_after",
        "address_check.unknown_keep_seconds",
        // Issue 609: how long Den's process lookups wait.
        "process_lookup.first_seconds",
        "process_lookup.retry_seconds",
        // Issue 532: the terminal limits.
        "sessions.close_grace_seconds",
        "sessions.max_concurrent",
        "sessions.pty_close_seconds",
        "sessions.pty_machine_warn_percent",
        "sessions.pty_warn_above",
        "sessions.size_claim_grace_seconds",
        "sessions.size_leave_grace_seconds",
        "sessions.io_ping_seconds",
        // Issue 609: how agents' hooks wait for Den, and retry.
        "agent_hooks.timeout_seconds",
        "agent_hooks.retries",
        "agent_hooks.backoff_seconds",
        // Issue 742: how long a held write waits for the person's Allow.
        "held_writes.wait_minutes",
        // Issue 1022: how often the page polls health, visible and hidden.
        "health_poll.visible_seconds",
        "health_poll.hidden_seconds",
        "menu_load.timeout_ms",
        "git_reads.at_once",
        // Issue 750: groups from Hub.
        "hub_groups.mode",
        "hub_groups.cache_seconds",
        // Issue 1129: the restart queue.
        "agents_resume.batch",
        "agents_resume.gap_seconds",
        "agents_resume.load_ceiling",
        "agents_resume.max_wait_seconds",
      ].sort(),
    );
  });

  it("every accepted key has a registry row", () => {
    expect(unregistered(accepted, DEN_SETTINGS)).toEqual([]);
  });

  it("catches a key the server accepts with no row", () => {
    // A deliberately unregistered key: the check names it.
    expect(unregistered([...accepted, "graph.zoom"], DEN_SETTINGS)).toEqual([
      "graph.zoom",
    ]);
    // And dropping a row uncovers its keys.
    expect(
      unregistered(
        accepted,
        DEN_SETTINGS.filter((r) => r.id !== "terminal"),
      ),
    ).toEqual(["terminal"]);
  });

  it("no row claims a key the server does not accept", () => {
    const known = new Set(accepted);
    const claimed = DEN_SETTINGS.flatMap((r) => r.keys ?? []);
    expect(claimed.filter((k) => !known.has(k))).toEqual([]);
  });
});

describe("the registry's rules", () => {
  it("every row has a scope: user, workspace or distribution", () => {
    const bad = DEN_SETTINGS.filter(
      (r) => !["user", "workspace", "distribution"].includes(r.scope),
    ).map((r) => r.id);
    expect(bad).toEqual([]);
  });

  it("a distribution row is read-only: it has no write", () => {
    const dist = DEN_SETTINGS.filter((r) => r.scope === "distribution");
    expect(dist.length).toBeGreaterThan(0);
    expect(
      dist
        .filter((r) => "write" in r && r.write !== undefined)
        .map((r) => r.id),
    ).toEqual([]);
  });

  it("only rows that store an /api/settings key or a workspace's settings write", () => {
    for (const r of DEN_SETTINGS) {
      const writes = "write" in r && typeof r.write === "function";
      const stores = (("keys" in r && r.keys) || []).length > 0;
      // A custom row saves through its own route (H5's Hub project).
      const ownRoute = r.control.type === "custom";
      expect([r.id, writes]).toEqual([
        r.id,
        stores || (r.scope === "workspace" && !ownRoute),
      ]);
    }
  });

  it("every row is complete and in a category that exists", () => {
    const cats = new Set(DEN_SETTING_CATEGORIES.map((c) => c.id));
    const ids = new Set<string>();
    for (const r of DEN_SETTINGS) {
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
      expect(cats.has(r.category)).toBe(true);
      expect(typeof r.label).toBe("string");
      expect(r.description.length).toBeGreaterThan(10);
      expect(Array.isArray(r.keywords)).toBe(true);
      expect(typeof r.read).toBe("function");
      expect(typeof r.control.type).toBe("string");
    }
  });

  it("the shell refuses a distribution row with a write, or an unknown scope", () => {
    const shell = fs.readFileSync(
      path.join(process.cwd(), "src", "ui", "server", "public", "shell.js"),
      "utf-8",
    );
    expect(shell).toMatch(
      /scope === "distribution" && r\.write\)\s*throw new Error/,
    );
    expect(shell).toMatch(
      /var SCOPES = \["user", "workspace", "distribution"\]/,
    );
  });
});
