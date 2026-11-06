/**
 * Workspace focus, status and switch (WS-6, 0.4.3): the pure parts.
 *
 * Three words, used the same way in the UI, the CLI help and the docs:
 *   focus   what you see: All workspaces, or one. Only a filter.
 *   status  what runs: Running n/m, Partial n/m or Stopped, worked out
 *           from a workspace's services, plus how many are down.
 *   switch  focus a workspace and start its services that aren't running.
 *           Nothing else stops. Stop & Switch also stops the other
 *           workspaces' services, except those of repos the target also
 *           has; agents and sessions always keep running.
 *
 * Input is the health rows (/api/health, every workspace on this machine,
 * WS-6.4): { repo, service, address, ok, running, runs, workspaces, inView }.
 * DOM-free, so Jest's node environment tests it; workspace-switch.js and
 * the pages draw it.
 */

/**
 * The en strings, for where there is no shell (a unit test). In a page,
 * callers pass the shell's t (R19), which has the same en text
 * (i18n.test.ts holds them equal).
 */
export const EN_FALLBACK = {
  "ws.all": "All workspaces",
  "ws.running": "Running {up}/{n}",
  "ws.partial": "Partial {up}/{n}",
  "ws.stopped": "Stopped",
  "ws.unchecked": "Not checked",
  "ws.down": "{n} down",
  "ws.sum.running": "{n} running",
  "ws.sum.partial": "{n} partial",
  "ws.sum.stopped": "{n} stopped",
  "ws.sw": "Switch",
  "ws.ss": "Stop & Switch",
  "ws.swMore": "More ways to switch to {w}",
  "ws.sw.p":
    "Show {w} and start its services that aren't running. Nothing else stops.",
  "ws.ss.p":
    "Stop the other workspaces' services first, then start {w}'s. Shared services and agents keep running.",
  "status.away": "{n} down in {w}",
};
function enT(key, vars) {
  return String(EN_FALLBACK[key] ?? key).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );
}

/** The workspaces that define a row (its owners). */
export function rowOwners(r) {
  return Array.isArray(r?.workspaces) ? r.workspaces : [];
}

/**
 * Whether a row is one of a workspace's services for its status: one Den
 * starts here. A remote service (runs: remote) or one with no commands for
 * this env (runs: none) is never started or stopped, so it isn't counted.
 */
export function countsForStatus(r) {
  return r?.runs !== "remote" && r?.runs !== "none";
}

/** Whether it runs (the server's `running`; an older server: its check answers). */
export function rowRunning(r) {
  return typeof r?.running === "boolean" ? r.running : r?.ok === true;
}

/** Down: it runs and its check fails. A stopped service is never down. */
export function rowDown(r) {
  return rowRunning(r) && r?.ok === false;
}

/**
 * One workspace's status (WS-6.3): `n` its services, `up` those running,
 * `down` those running but failing, and `state` running (all up), partial,
 * stopped (none up) or none (nothing Den starts here, or nothing known yet).
 */
export function workspaceStatus(rows, ws) {
  const mine = (rows || []).filter(
    (r) => countsForStatus(r) && rowOwners(r).includes(ws),
  );
  const n = mine.length;
  const up = mine.filter(rowRunning).length;
  const down = mine.filter(rowDown).length;
  const state =
    n === 0 ? "none" : up === 0 ? "stopped" : up === n ? "running" : "partial";
  return { n, up, down, state };
}

/** { name: status } for each workspace. */
export function statusesOf(rows, names) {
  return Object.fromEntries(
    (names || []).map((n) => [n, workspaceStatus(rows, n)]),
  );
}

/** The pill's words: "Running 2/2", "Partial 1/3", "Stopped", "Not checked". */
export function pillText(st, t = enT) {
  if (st.state === "none") return t("ws.unchecked");
  if (st.state === "stopped") return t("ws.stopped");
  return t(`ws.${st.state}`, { up: st.up, n: st.n });
}

/** The pill's class (running, partial, stopped). */
export function pillClass(st) {
  return st.state === "none" ? "stopped" : st.state;
}

/** A workspace's dot: off when stopped, bad with a service down, warn when partial. */
export function wsDot(st) {
  if (st.state === "stopped" || st.state === "none") return "off";
  if (st.down) return "bad";
  return st.state === "partial" ? "warn" : "";
}

/** "2 running · 1 partial · 1 stopped" (zeros left out), and the down count. */
export function summaryParts(statuses, t = enT) {
  const list = Object.values(statuses || {});
  const c = (k) =>
    list.filter((s) => (k === "stopped" ? pillClass(s) : s.state) === k).length;
  const parts = ["running", "partial", "stopped"]
    .filter((k) => c(k))
    .map((k) => t(`ws.sum.${k}`, { n: c(k) }));
  const down = list.reduce((k, s) => k + s.down, 0);
  return { text: parts.join(" · "), down };
}

/**
 * The top bar's Workspace menu (WS-6.6): the workspace in focus first (✓),
 * then All workspaces, then the rest in their order. `sep` marks where a
 * rule goes (after the focused one).
 */
export function menuRows(focus, names) {
  const list = names || [];
  const one = focus && focus !== "all" && list.includes(focus) ? focus : null;
  const rows = [];
  if (one) rows.push({ value: one, checked: true, sep: true });
  rows.push({ value: "all", checked: !one });
  for (const n of list) if (n !== one) rows.push({ value: n, checked: false });
  return rows;
}

/** The Workspace part's label: "All workspaces" or the workspace. */
export function focusLabel(focus, names, t = enT) {
  return focus && focus !== "all" && (names || []).includes(focus)
    ? focus
    : t("ws.all");
}

/**
 * Down services outside the focus (WS-6.5's "· n down in <ws>"): the
 * total, and the workspace with the most of them.
 */
export function awayDown(rows) {
  const by = new Map();
  let n = 0;
  for (const r of rows || []) {
    if (r.inView !== false || !rowDown(r)) continue;
    n++;
    const ws = rowOwners(r)[0] ?? "";
    by.set(ws, (by.get(ws) ?? 0) + 1);
  }
  let ws = null;
  let most = 0;
  for (const [w, k] of by)
    if (k > most) {
      ws = w;
      most = k;
    }
  return { n, ws, by: Object.fromEntries(by) };
}

/** The chip's "· n down in <ws>" part, or "". */
export function awayText(away, t = enT) {
  return away && away.n
    ? ` · ${t("status.away", { n: away.n, w: away.ws })}`
    : "";
}

/** A row's address (the server's; else repo or repo/service). */
export function rowAddress(r) {
  if (r.address) return r.address;
  return r.repo === r.service ? r.repo : `${r.repo}/${r.service}`;
}

/**
 * What Switch and Stop & Switch to `target` do (WS-6.7, WS-6.8), from
 * live health and the sessions:
 *   starts  the target's services that aren't running
 *   stops   running services no workspace in `target` defines, grouped by
 *           the workspace they are stopped in (their first owner)
 *   keeps   the target's repos another workspace also has that run
 *           (shared: never stopped)
 *   agents  agents and sessions that run outside the target: they keep
 *           running (stopping services never touches a session)
 */
export function switchPlan(target, rows, sessions) {
  const list = (rows || []).filter(countsForStatus);
  const mine = list.filter((r) => rowOwners(r).includes(target));
  const starts = mine.filter((r) => !rowRunning(r)).map(rowAddress);
  const byWs = new Map();
  for (const r of list) {
    if (!rowRunning(r) || rowOwners(r).includes(target)) continue;
    const ws = rowOwners(r)[0];
    if (!ws) continue;
    if (!byWs.has(ws))
      byWs.set(ws, { workspace: ws, addresses: [], repos: [] });
    const g = byWs.get(ws);
    g.addresses.push(rowAddress(r));
    if (!g.repos.includes(r.repo)) g.repos.push(r.repo);
  }
  const keeps = [];
  for (const r of mine)
    if (
      rowRunning(r) &&
      rowOwners(r).some((w) => w !== target) &&
      !keeps.some((k) => k.repo === r.repo)
    )
      keeps.push({
        repo: r.repo,
        with: rowOwners(r).filter((w) => w !== target),
      });
  const agents = agentsByWorkspace(sessions);
  delete agents[target];
  return {
    target,
    starts,
    stops: [...byWs.values()],
    keeps,
    agents: Object.entries(agents).map(([workspace, n]) => ({ workspace, n })),
  };
}

/** Whether a session (GET /api/sessions) is running: not exited, stopped or ended. */
export function sessionRunning(s) {
  return !!s && !s.exited && (s.state === "running" || s.state === "stopping");
}

/** { workspace: running agents and sessions } (the All table's Agents column). */
export function agentsByWorkspace(sessions) {
  const out = {};
  for (const s of sessions || [])
    if (sessionRunning(s) && s.workspace)
      out[s.workspace] = (out[s.workspace] ?? 0) + 1;
  return out;
}

/** How many services a plan stops. */
export function stopCount(plan) {
  return (plan?.stops || []).reduce((k, s) => k + s.addresses.length, 0);
}

/**
 * What picking a workspace does (WS-6.10 "When I pick a workspace"):
 * "show" (just show it, the default), "ask" (ask whether to start it) or
 * "switch" (start it automatically). Picking All, or a workspace with
 * nothing to start, only shows it.
 */
export function pickAction(setting, startsCount, value) {
  if (value === "all" || !startsCount) return "show";
  return setting === "ask" || setting === "switch" ? setting : "show";
}

/** The Workspaces prefs (user.yml `switching`, WS-6.10), with their defaults. */
export function switchPrefs(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    on_pick: ["show", "ask", "switch"].includes(p.on_pick) ? p.on_pick : "show",
    confirm_stop_switch: p.confirm_stop_switch !== false,
  };
}
