/**
 * The Workspaces page's parts (WS-6.9, 0.4.3): the explainer cards, the
 * workspace list, the All workspaces table and a workspace's status line.
 * local-dev.html draws them; the actions are workspace-switch.js's
 * ([data-focus], [data-switch], [data-swmenu], [data-stopswitch]), the
 * same as the top bar's Workspace menu.
 *
 * Every string is the shell's (R19); status comes from the health rows
 * (every workspace on this machine, WS-6.4).
 */
import {
  agentsByWorkspace,
  statusesOf,
  workspaceStatus,
  wsDot,
} from "./workspace-status.js";
import {
  downHtml,
  pillHtml,
  splitHtml,
  summaryHtml,
} from "./workspace-switch.js";

const t = (k, v) => window.denShell?.t?.(k, v) ?? k;
function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/** The repos a workspace has (its services' first address segment). */
export function reposOf(wsConfig) {
  const out = [];
  for (const addr of Object.keys(wsConfig?.services ?? {})) {
    const r = addr.split("/")[0];
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

/** The other workspaces on this machine that also have `repo` (shared). */
export function sharedWith(repo, ws, data) {
  const on = Array.isArray(data?.active) ? data.active : [];
  return on.filter(
    (n) => n !== ws && reposOf(data?.workspaces?.[n]).includes(repo),
  );
}

/** The "shared" tag on a repo row, or "". */
export function sharedTagHtml(repo, ws, data) {
  const others = sharedWith(repo, ws, data);
  return others.length
    ? ` <span class="ws-shared" title="${esc(t("ws.sharedWith", { w: others.join(", ") }))}">${esc(t("ws.shared"))}</span>`
    : "";
}

/** The three explainer cards: focus, status, switch. */
export function howtoHtml() {
  const card = (k) =>
    `<div><b>${esc(t(`ws.how.${k}`))}</b>${esc(t(`ws.how.${k}.p`))}</div>`;
  return `<div class="ws-howto">${card("focus")}${card("status")}${card("switch")}</div>`;
}

/**
 * The list: All workspaces first, then every workspace (those not on
 * this machine muted, with Add to this machine in their ⋮ menu).
 * `selected` is what the page shows ("all" or a name). A row on this
 * machine carries data-pick (the page picks it: the focus); one not on
 * it only shows it here.
 */
export function wsListHtml({ data, rows, selected }) {
  const names = Object.keys(data?.workspaces ?? {});
  const on = Array.isArray(data?.active) ? data.active : [];
  const sts = statusesOf(rows, on);
  const all =
    `<div class="ws-item ws-all${selected === "all" ? " active" : ""}" data-pick="all" role="button" tabindex="0" aria-current="${selected === "all"}">` +
    `<span></span><span class="ws-nm">${esc(t("ws.all"))}</span>` +
    `<span class="ws-count">${on.length}</span>` +
    `<span class="ws-meta">${summaryHtml(sts)}</span></div>`;
  const item = (n) => {
    const here = on.includes(n);
    const st = here ? sts[n] : null;
    const dirPath = data.resolvedDirs?.[n] ?? "";
    const menuId = `ws-menu-${n.replace(/[^a-z0-9]/gi, "-")}`;
    const repos = reposOf(data.workspaces[n]).length;
    const meta =
      esc(t(repos === 1 ? "ws.repos.one" : "ws.repos", { n: repos })) +
      (st?.down ? ` · ${downHtml(st)}` : "") +
      (here ? "" : ` · ${esc(t("ws.offMachine"))}`);
    const pick = here ? `data-pick="${esc(n)}"` : `data-action="select"`;
    return (
      `<div class="ws-item${n === selected ? " active" : ""}${here ? "" : " off"}" data-name="${esc(n)}" ${pick} role="button" tabindex="0" aria-current="${n === selected}">` +
      `<span class="den-dot ${st ? wsDot(st) : "off"}" aria-hidden="true"></span>` +
      `<span class="ws-nm">${esc(n)}</span>` +
      `<span class="ws-pill">${st ? pillHtml(st) : ""}</span>` +
      `<span class="ws-item-right">` +
      `<button class="ws-term-btn" title="Open in terminal" data-open-term="${esc(dirPath)}">&#62;_</button>` +
      `<button class="ws-open-btn" title="Open in editor" data-open-path="${esc(data.codeWorkspacePaths?.[n] || dirPath)}">↗</button>` +
      `<span class="ws-menu-wrap"><button class="ws-menu-btn" title="More actions" data-menu-id="${esc(menuId)}">⋮</button>` +
      `<span class="ws-menu-dropdown" id="${esc(menuId)}">` +
      (here
        ? `<button data-action="deactivate">Remove from this machine</button>`
        : `<button data-action="activate">Add to this machine</button>`) +
      `<button data-action="rename">Rename</button>` +
      (n !== "default"
        ? `<button class="danger" data-action="delete">Delete</button>`
        : "") +
      `</span></span></span>` +
      `<span class="ws-meta">${meta}</span></div>`
    );
  };
  return all + names.map(item).join("");
}

/**
 * The All workspaces view (WS-6.9): a summary line and one row per
 * workspace on this machine: Workspace, Status, Services, Down, Agents,
 * then Focus and the [Switch | ▾] split button.
 */
export function allViewHtml({ data, rows, sessions }) {
  const on = Array.isArray(data?.active) ? data.active : [];
  const sts = statusesOf(rows, on);
  const agents = agentsByWorkspace(sessions);
  const c = (k) =>
    Object.values(sts).filter((s) =>
      k === "stopped"
        ? s.state === "stopped" || s.state === "none"
        : s.state === k,
    ).length;
  const sub = t("ws.summary", {
    n: on.length,
    r: c("running"),
    p: c("partial"),
    s: c("stopped"),
  });
  const body = on
    .map((n) => {
      const st = sts[n];
      const faint = '<span class="tbl-muted">—</span>';
      return (
        `<tr data-ws="${esc(n)}"><th scope="row"><span class="den-dot ${wsDot(st)}" aria-hidden="true"></span> <span class="repo-name">${esc(n)}</span></th>` +
        `<td>${pillHtml(st)}</td>` +
        `<td class="tbl-mono">${st.n ? `${st.up}/${st.n}` : faint}</td>` +
        `<td>${st.down ? downHtml(st) : faint}</td>` +
        `<td class="tbl-mono">${agents[n] ? agents[n] : faint}</td>` +
        `<td><div class="tbl-acts"><button type="button" class="den-btn sm" data-focus="${esc(n)}">${esc(t("ws.focusBtn"))}</button> ${splitHtml(n)}</div></td></tr>`
      );
    })
    .join("");
  return (
    `<div class="content-header ws-head"><h2>${esc(t("ws.all"))}</h2><span class="ws-sub">${esc(sub)}</span></div>` +
    `<div class="content-body">${howtoHtml()}` +
    `<div class="tablewrap"><table class="svc" id="ws-all-table"><caption>${esc(t("ws.all"))}</caption>` +
    `<thead><tr><th scope="col">${esc(t("ws.c.ws"))}</th><th scope="col">${esc(t("ws.c.status"))}</th><th scope="col">${esc(t("ws.c.svcs"))}</th><th scope="col">${esc(t("ws.c.down"))}</th><th scope="col">${esc(t("ws.c.agents"))}</th><th scope="col"><span class="den-sr">Actions</span></th></tr></thead>` +
    `<tbody>${body || `<tr class="tbl-none"><td colspan="6">${esc(t("ws.none"))}</td></tr>`}</tbody></table></div></div>`
  );
}

/**
 * A workspace's status in its header: the dot, the pill and the down
 * count (or, for one not on this machine, saying so), then Start, Stop
 * and the [Switch | ▾] split button (primary).
 */
export function wsHeadStatusHtml({ name, data, rows }) {
  const on = Array.isArray(data?.active) ? data.active : [];
  if (!on.includes(name))
    return (
      `<span class="badge">${esc(t("ws.offMachine"))}</span>` +
      `<button class="switch-btn" data-action="activate-ws">Add to this machine</button>`
    );
  const st = workspaceStatus(rows, name);
  return (
    `<span class="den-dot ${wsDot(st)}" aria-hidden="true" id="ws-head-dot"></span>` +
    `<span id="ws-head-pill">${pillHtml(st)}${downHtml(st)}</span>` +
    `<span class="ws-head-acts">` +
    (st.up < st.n
      ? `<button type="button" class="den-btn sm" data-action="ws-start">${esc(t("ws.start"))}</button>`
      : "") +
    (st.up
      ? `<button type="button" class="den-btn sm" data-action="ws-stop">${esc(t("ws.stop"))}</button>`
      : "") +
    splitHtml(name, { primary: true }) +
    `</span>`
  );
}
