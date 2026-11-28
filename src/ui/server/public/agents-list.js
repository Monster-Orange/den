import { latestShell } from "/shell-pick.js";
import { reconnectOptions } from "/pane-reconnect.js";
import { attnSub, bandsOf, byNeed } from "/agent-bands.js";
import { groupsLineHtml, groupsOffered, groupsViewHtml, viewSwitchHtml } from "/agent-groups.js";
import { toolsBarHtml } from "/agents-bar.js";
import { BY, CLI, LAYOUTS, SERVER_WS, TITLE, agentPath, api, esc, rowOf, st, t } from "/agents-core.js";
import { refresh } from "/agents-data.js";
import { closePane, openPane } from "/agents-panes.js";
import { orderRowHtml, reorderBandHtml, reorderStoppedHtml, runningMovable, stoppedMovable } from "/agents-reorder.js";
import { exitedShell, exitedShellHtml, inStopped, isStopped, pcAttr, projName, rowHtml, seenMap, stoppedHtml, wsLinkHtml } from "/agents-rows.js";
import { agoPlain } from "/agents-start-dialog.js";
import { PAGE, phone, pickedWorkspace, shellUsed, shownLayout, urlWorkspace, viewWorkspaces, writeUrl } from "/agents-url.js";
import { belongsOn, movedNoteHtml, terminalGroups, terminalRowHtml, terminalsCountText } from "/terminals-list.js";
import { focusBack, refindKey } from "/transcript-view.js";

/**
 * #80: each helpers badge sits over its placeholder on its row's second
 * line (the row is a button, and a button can't hold one).
 */
function placeHelperToggles(root) {
  for (const w of root.querySelectorAll(".agrw")) {
    const ph = w.querySelector(".agr-hp-ph");
    const b = w.querySelector(":scope > .agr-hpb");
    if (!ph || !b) continue;
    const a = w.getBoundingClientRect();
    const r = ph.getBoundingClientRect();
    b.style.left = `${Math.round(r.left - a.left)}px`;
    b.style.top = `${Math.round(r.top - a.top)}px`;
  }
}

/** Where focus was in the list, as a selector that finds it again once
 * the list is redrawn: a helper row or button, an agent's row, a link. */
function listFocusKey(el) {
  const key = refindKey(el);
  if (key) return key;
  const q = (v) => CSS.escape(String(v ?? ""));
  if (el.matches(".agr-hpb[data-agent]"))
    return `#agl .agr-hpb[data-agent="${q(el.dataset.agent)}"][data-ws="${q(el.dataset.ws)}"]`;
  if (el.matches("button.agr[data-id]"))
    return `#agl button.agr[data-id="${q(el.dataset.id)}"]`;
  if (el.matches("[data-act]")) {
    // Issue 96: a phone's Up and Down sit in the row's .agord, beside .agst.
    const row = el.closest(".agst[data-agent], .agord[data-agent]");
    const cls = row?.classList.contains("agord") ? "agord" : "agst";
    const act = `[data-act="${q(el.dataset.act)}"]`;
    return row
      ? `#agl .${cls}[data-agent="${q(row.dataset.agent)}"][data-ws="${q(row.dataset.ws)}"] ${act}`
      : `#agl ${act}`;
  }
  return "";
}

/** The list's HTML, written only when it changed; focus inside it is kept
 * (the refresh poll redraws it every few seconds). */
function setList(el, html) {
  // Issue 96: never under a drag (its rows and drop line would go); a drop or
  // its end paints the list again.
  if (st.drag) return;
  if (el.denHtml === html) return;
  el.denHtml = html;
  const had = el.contains(document.activeElement)
    ? document.activeElement
    : null;
  const key = had ? listFocusKey(had) : "";
  el.innerHTML = html;
  placeHelperToggles(el);
  if (had) focusBack(had, key);
}

function paintList() {
  const el = st.root.querySelector("#agl");
  el.removeAttribute("aria-busy");
  const notes = [];
  if (st.signedOut || st.data?.io?.allowed === false)
    notes.push(
      `<div class="signin" data-note="signin">${esc(t("ag.signin", { cli: CLI }))}</div>`,
    );
  else if (st.data && st.data.backend?.available === false)
    notes.push(
      `<div class="agnote" data-note="backend">${esc(t("ag.noBackend", { cli: CLI }))}</div>`,
    );
  // den#156: the host didn't answer in time: this list may be old.
  if (st.hostDown)
    notes.push(
      `<div class="agnote" data-note="host" role="status">${esc(t("ag.hostDown"))}</div>`,
    );
  if (!st.data) {
    setList(
      el,
      notes.join("") +
        (st.loadFailed
          ? `<div class="agnote" data-note="load-failed" role="status">${esc(t("ag.list.failed"))} <button type="button" class="den-btn sm" data-act="retry-list">${esc(t("ag.list.retry"))}</button> ${esc(t("ag.list.keepRunning"))}</div>`
          : `<div class="agskel" role="status" aria-label="${esc(t("ag.list.loading"))}"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>`),
    );
    return;
  }
  // D71: agents whose workspace was deleted, under its old name.
  const orphans = st.data.sessions.filter(
    (s) => s.orphan && belongsOn(PAGE, s),
  );
  const shown = [
    ...new Set([
      ...(!pickedWorkspace() && st.data.sessions.some((s) => s.server)
        ? [SERVER_WS]
        : []),
      ...viewWorkspaces(),
      ...orphans.map((s) => s.workspace),
    ]),
  ];
  if (orphans.length)
    notes.push(
      `<div class="agnote" data-note="orphan" role="status">` +
        esc(
          t(orphans.length === 1 ? "ag.orphan.one" : "ag.orphan.many", {
            n: orphans.length,
            // The agent, not its persona: its given name, else its id.
            names: orphans.map((r) => r.displayName || r.agent).join(", "),
          }),
        ) +
        `</div>`,
    );
  // #80: an agent opened on purpose switched the project: say so.
  const now = viewWorkspaces();
  if (st.switchedFrom && now.length === 1 && now[0] !== st.switchedFrom)
    notes.push(
      `<div class="agnote" data-note="switched" role="status">` +
        esc(t("ag.switchedTo", { ws: now[0] })) +
        ` · <button type="button" class="lnk" data-act="switch-back">${esc(t("ag.backTo", { ws: st.switchedFrom }))}</button></div>`,
    );
  // #80: tabs ?open= named from other projects, left out of this view.
  if (st.hiddenOpen.length)
    notes.push(
      `<div class="agnote" data-note="other-tabs" role="status">` +
        esc(
          t("ag.otherTabs", {
            n: st.hiddenOpen.length,
          }),
        ) +
        ` · <button type="button" class="lnk" data-act="show-all">${esc(t("ag.showAllActive"))}</button></div>`,
    );
  // ?ws= names a workspace that isn't active: say so, and offer the switch.
  const asked = st.data.requested;
  if (asked && !asked.active)
    notes.push(
      `<div class="agnote" data-note="inactive" role="status">` +
        esc(t("ag.inactive", { ws: asked.workspace })) +
        (asked.known
          ? ` · <button type="button" class="lnk" data-act="switch-ws">${esc(t("ag.switchWs", { ws: asked.workspace }))}</button>`
          : ` ${esc(t("ag.unknownWs"))}`) +
        `</div>`,
    );
  // AG-14.3: one line after a restart, for the agents it interrupted.
  const hit = visibleRows().filter((r) => r.state === "interrupted");
  if (hit.length)
    notes.push(
      `<div class="agnote" data-note="interrupted" role="status">` +
        `${esc(t(hit.length === 1 ? "ag.interrupted.one" : "ag.interrupted", { n: hit.length, name: TITLE }))}` +
        (hit.some((r) => r.resumable)
          ? ` · <button type="button" class="lnk" data-act="resume-all">${esc(t("ag.resumeAll"))}</button>`
          : "") +
        ` · <button type="button" class="lnk" data-act="review">${esc(t("ag.review"))}</button></div>`,
    );
  // Issue 482: the Agents page says once where the shells went.
  if (PAGE !== "terminal") notes.push(movedNote());
  const inView = shown.flatMap((ws) =>
    st.data.sessions.filter((s) => s.workspace === ws && belongsOn(PAGE, s)),
  );
  const stopped = inView.filter(inStopped);
  if (PAGE !== "terminal") {
    const bar = toolsBarHtml(inView);
    if (bar) notes.push(bar);
  }
  const gLine = PAGE === "terminal" ? "" : groupsLineHtml(st.groupsRead, t);
  if (gLine) notes.push(gLine);
  const running = inView.filter((s) => !inStopped(s));
  const need = (xs) => byNeed(xs, { seenNow: seenMap() });
  const byGroup =
    PAGE !== "terminal" && st.by === "group" && groupsOffered(st.groupsRead);
  const byProject = PAGE !== "terminal" && st.by === "project";
  const none = `<div class="none">${esc(t("ag.none.scope", { scope: st.scopeLabel }))}</div>`;
  let body;
  if (PAGE === "terminal") body = terminalsBodyHtml();
  else if (byGroup)
    body = groupsViewHtml(inView, st.groupsRead.groups, {
      t,
      rowHtml,
      groupsUrl: st.groupsRead.groupsUrl,
      order: need,
    });
  else if (byProject) {
    const groups = shown
      .map((ws) => ({
        ws,
        rows: need(running.filter((s) => s.workspace === ws)),
      }))
      .filter((g) => g.rows.length > 0);
    body =
      groups.length || stopped.length
        ? groups
            .map(
              (g, i) =>
                `<div class="wsg" data-ws="${esc(g.ws)}"${pcAttr(g.ws)} role="group" aria-labelledby="agp-${i}"><div class="wsh"><span id="agp-${i}">${wsLinkHtml(g.ws)}</span><span>${esc(g.rows.length)}</span></div>` +
                g.rows.map((r) => rowHtml(r)).join("") +
                `</div>`,
            )
            .join("") + stoppedGroupHtml(stopped)
        : none;
  } else {
    const bands = bandsOf(running, { seenNow: seenMap() });
    body =
      bands.length || stopped.length
        ? bands
            .map(
              (b) =>
                `<div class="wsg agband" data-band="${b.state}" role="group" aria-labelledby="agb-${b.state}"><div class="wsh"><span id="agb-${b.state}">${esc(t(`ag.band.${b.state}`))}</span><span class="n" data-count>${esc(b.rows.length)}</span></div>` +
                reorderBandHtml(b) +
                b.rows
                  .map((r) =>
                    orderRowHtml(
                      rowHtml(r),
                      r,
                      phone() &&
                        st.reorderBand === b.state &&
                        runningMovable(r),
                    ),
                  )
                  .join("") +
                `</div>`,
            )
            .join("") + stoppedGroupHtml(stopped)
        : none;
  }
  setList(
    el,
    notes.join("") +
      viewSwitchHtml(st.groupsRead, st.by, t) +
      body +
      `<div class="aghint" id="agl-hint">${esc(t(`ag.hint.${shownLayout()}`))} ${esc(t("ag.hint.keys"))}</div>`,
  );
  const clear = st.root.querySelector("#ag-clear");
  if (clear)
    clear.hidden = PAGE === "terminal" || !visibleRows().some(inStopped);
  // No such workspace: nothing to start an agent in.
  const start = st.root.querySelector("#ag-start");
  if (start) start.hidden = st.data.requested?.known === false;
  fitListFloor();
}

/** How many whole rows the list keeps in view over an open pane (narrow). */
const LIST_FLOOR_ROWS = 3;

/** The floor's least, as before (6rem): the list scrolls under it. */
const LIST_FLOOR_MIN_PX = 96;

/**
 * On a narrow screen the list sits above the panes, and its height has a
 * floor (agents.html: --agl-floor). The floor holds the list's notes and
 * its view switch, then LIST_FLOOR_ROWS whole rows: the notes never take
 * the rows' room. But an open pane keeps its own minimum (its To line stays
 * above the runs dock shut, with no page scroll): where both
 * don't fit, the list gets what's left, never less than 6rem, and scrolls.
 * With the dock open the page scrolls to the To line anyway: the list keeps
 * its first whole row. Measured after
 * each paint and on resize; the CSS caps it.
 */
function fitListFloor() {
  const agx = st.root?.querySelector("#agx");
  const el = st.root?.querySelector("#agl");
  if (!agx || !el) return;
  // The floor is used at 860px and below only: wider, read no layout.
  if (!matchMedia("(max-width: 860px)").matches) {
    agx.style.removeProperty("--agl-floor");
    return;
  }
  // Only rows that are drawn: not those in a shut Stopped (n), which some
  // engines still give a box (content-visibility), nor any hidden one.
  const rows = Array.from(el.querySelectorAll(".agr")).filter(
    (r) => !r.closest("details:not([open])") && r.getClientRects().length > 0,
  );
  if (!rows.length) {
    agx.style.removeProperty("--agl-floor");
    return;
  }
  const top = el.getBoundingClientRect().top - el.scrollTop;
  const border = el.offsetHeight - el.clientHeight;
  const upTo = (r) =>
    Math.ceil(r.getBoundingClientRect().bottom - top + border);
  let px = upTo(rows[Math.min(LIST_FLOOR_ROWS, rows.length) - 1]);
  const right = agx.querySelector("#agr");
  const pane = right?.querySelector(".pane:not([hidden])");
  if (pane) {
    if (document.querySelector(".den-dock.open"))
      px = Math.max(LIST_FLOOR_MIN_PX, upTo(rows[0]));
    const gap = parseFloat(getComputedStyle(agx).rowGap) || 0;
    // The right side's least: the pane's minimum, plus what sits beside it
    // there (the tab strip in Tabs).
    const beside =
      right.getBoundingClientRect().height -
      pane.getBoundingClientRect().height;
    const room =
      agx.clientHeight -
      gap -
      Math.max(0, beside) -
      (parseFloat(getComputedStyle(pane).minHeight) || 0);
    px = Math.max(LIST_FLOOR_MIN_PX, Math.min(px, Math.floor(room)));
  }
  agx.style.setProperty(
    "--agl-floor",
    `${Math.max(LIST_FLOOR_MIN_PX, Math.ceil(px))}px`,
  );
}

/**
 * Issue 482: the Terminals page's list: Running, then Exited, each by
 * last used, newest first; under All projects each row names its
 * project. Empty: says so, and how to open one.
 */
function terminalsBodyHtml() {
  const used = shellUsed();
  const { running, exited } = terminalGroups(visibleRows(), used);
  if (!running.length && !exited.length)
    return (
      `<div class="none tmnone"><strong>${esc(t("tm.none"))}</strong>` +
      `<span>${esc(t("tm.noneP", { scope: st.scopeLabel }))}</span></div>`
    );
  const view = viewWorkspaces();
  const showProject = view.length !== 1;
  const row = (r) =>
    terminalRowHtml(r, {
      t,
      when: agoPlain,
      showProject,
      open: st.open.includes(r.id),
      current: r.id === st.cur,
      used,
    });
  const group = (key, list) =>
    list.length
      ? `<div class="wsg tmg" data-tm="${key}"><div class="wsh"><span>${esc(t(`tm.${key}`, { n: list.length }))}</span></div>` +
        list.map(row).join("") +
        `</div>`
      : "";
  return group("running", running) + group("exited", exited);
}

/** Issue 482: the Agents page's note, once per browser (until dismissed). */
const MOVED_KEY = "den-terminals-moved-seen";

function movedSeen() {
  try {
    return localStorage.getItem(MOVED_KEY) === "1";
  } catch {
    return false;
  }
}

function movedNote() {
  if (movedSeen()) return "";
  const view = viewWorkspaces();
  const n = (st.data?.sessions ?? []).filter(
    (s) => s.kind === "session" && view.includes(s.workspace),
  ).length;
  return movedNoteHtml(n, t);
}

/** Issue 750: how often the page asks Den for Hub's groups again (ms). */
const GROUPS_EVERY_MS = 30_000;

/**
 * Issue 750: Hub's groups for the By group view (Den reads them from Hub,
 * keeps them in memory only). `fresh`: Try again, past Den's copy.
 */
async function loadGroups(fresh = false) {
  st.groupsAt = Date.now();
  try {
    const r = await fetch(`/api/hub/groups${fresh ? "?fresh=1" : ""}`, {
      headers: { accept: "json" },
    });
    const b = r.ok ? await r.json() : null;
    st.groupsRead = b?.state ? b : { state: "unreachable" };
  } catch {
    st.groupsRead = { state: "unreachable" };
  }
  if (st.data) paintList();
}

const STOPPED_OPEN_KEY = "den-agents-stopped-open";

/** D37: whether "Stopped (n)" is open: as a person left it, else open
 * for 3 or fewer. */
function stoppedOpen(n) {
  try {
    const v = localStorage.getItem(STOPPED_OPEN_KEY);
    if (v === "1" || v === "0") return v === "1";
  } catch {
    /* none: the default */
  }
  return n <= 3;
}

/** D37: the agents that aren't running, one line each, in one group. */
function stoppedGroupHtml(rows) {
  if (!rows.length) return "";
  // More than one workspace among them: each row names its own.
  const wsTag = new Set(rows.map((r) => r.workspace)).size > 1;
  return (
    `<details class="wsg agstg" data-stopped${stoppedOpen(rows.length) ? " open" : ""}>` +
    `<summary class="wsh" title="${esc(t("ag.stoppedGroupTip"))}"><span>${esc(t("ag.stoppedGroup", { n: rows.length }))}</span></summary>` +
    reorderStoppedHtml(rows) +
    rows
      .map((r) =>
        exitedShell(r)
          ? exitedShellHtml(r, wsTag)
          : // Issue 226: a phone's Reorder gives stopped agents Up and Down too.
            orderRowHtml(
              stoppedHtml(r, wsTag),
              r,
              phone() && st.reorderStopped && stoppedMovable(r),
            ),
      )
      .join("") +
    `</details>`
  );
}

/**
 * #80: whether session `s` belongs in this view: the view's projects, the
 * server agent (it spans projects; in All projects only) and an agent whose project was deleted
 * (D71). 0.4.44 added the open tabs' projects too, which mixed another
 * project's agents into a project's list; a tab from another project is
 * now left out instead (hideOtherProjects), so the list always has the
 * session in front.
 */
function inView(s) {
  if (!s) return false;
  // Issue 482: a shell is on the Terminals page, an agent on Agents.
  if (!belongsOn(PAGE, s)) return false;
  if (s.server || s.workspace === SERVER_WS) return !pickedWorkspace();
  if (s.orphan) return true;
  return viewWorkspaces().includes(s.workspace);
}

function visibleRows() {
  return (st.data?.sessions ?? []).filter(inView);
}

/**
 * #80: the open panes of sessions outside this view leave the tabs (and
 * ?open=), kept in st.hiddenOpen for "Show in All active".
 */
function hideOtherProjects() {
  if (!st.data) return;
  const out = st.open.filter((id) => {
    const r = rowOf(id);
    return r && !inView(r);
  });
  if (!out.length) return;
  // Issue 482: the other page's kind leaves quietly (it is on its page).
  const other = out.filter((id) => belongsOn(PAGE, rowOf(id)));
  st.hiddenOpen = [...new Set([...st.hiddenOpen, ...other])];
  for (const id of out)
    if (st.panes.has(id)) closePane(id, { quiet: true });
    else st.open = st.open.filter((x) => x !== id);
  writeUrl();
}

/**
 * #80: opening another project's session from elsewhere (a link, ⌘K, a
 * bell item) switches this page to that project first.
 */
async function switchToProjectOf(r) {
  if (!r || inView(r)) return;
  const was = viewWorkspaces();
  st.switchedFrom = was.length === 1 ? was[0] : null;
  await showProject(r.workspace);
}

/** This page shows project `ws`: the address, the stored view, the top bar. */
async function showProject(ws) {
  const u = new URL(location.href);
  u.searchParams.delete("ws");
  u.searchParams.set("project", ws);
  history.replaceState(history.state, "", u.pathname + u.search);
  st.scope = ws;
  try {
    // busy-ok: the stored view follows the page, which shows it already
    await window.denShell?.api?.("POST", "/api/scope", { scope: ws });
  } catch {
    /* the address still says it, for this page */
  }
  try {
    await (await import("/header.js")).refreshWorkspacePill?.();
  } catch {
    /* the top bar repaints on the next load */
  }
  await refresh();
}

function paintSub() {
  const rows = visibleRows();
  const count = st.root.querySelector("#ag-count");
  if (count)
    count.textContent =
      PAGE === "terminal"
        ? terminalsCountText(rows.length, st.scopeLabel, t)
        : attnSub(
            rows.filter((r) => !inStopped(r)),
            st.scopeLabel,
            seenMap(),
          );
  const url = st.root.querySelector("#ag-url");
  if (url) url.textContent = location.pathname + location.search;
  // Issue 482: the rail lights the page's own item (Terminals or Agents):
  // each page holds only its own kind.
}

function scopeLabelFor(shown) {
  const ws = urlWorkspace();
  if (ws && shown.length === 1 && shown[0] === ws) return projName(ws);
  return st.scope === "all" ? t("ag.all") : projName(st.scope);
}


/** Issue 278: a person looked: the loop is over for now; held deliveries go. */
async function clearCompacting(r, button) {
  await window.denShell.busyAction(
    "save",
    (headers) =>
      api("POST", agentPath(r, "compacting-clear"), undefined, { headers }),
    {
      button,
      success: () => t("ag.ctx.cleared", { id: r.agent }),
    },
  );
  await refresh();
}

function markMovedSeen() {
  try {
    localStorage.setItem(MOVED_KEY, "1");
  } catch {
    /* none: shown again on the next load */
  }
}

/** Issue 482: the Terminals page, in the project in view. */
function terminalsHref() {
  const view = viewWorkspaces();
  return view.length === 1
    ? `/terminals?project=${encodeURIComponent(view[0])}`
    : "/terminals";
}

function setBy(by) {
  st.by = BY.includes(by) ? by : "need";
  try {
    localStorage.setItem("den-agents-by", st.by);
  } catch {
    /* this page only */
  }
  paintList();
}

function saveStoppedOpen(open) {
  try {
    localStorage.setItem(STOPPED_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* none: this page only */
  }
}

/** #80: All active, with the hidden tabs back. */
async function showAllActive() {
  try {
    // busy-ok: the stored view follows the page; the reload is its answer
    await window.denShell?.api?.("POST", "/api/scope", { scope: "all" });
  } catch {
    /* the link below still shows every project for this page */
  }
  const u = new URL(location.href);
  u.searchParams.delete("ws");
  u.searchParams.delete("project");
  u.searchParams.set(
    "open",
    [...new Set([...st.open, ...st.hiddenOpen])].join(","),
  );
  location.assign(
    u.pathname + "?" + u.searchParams.toString().replace(/%2C/gi, ","),
  );
}

/** #80: "Back to <project>": the project left, its tabs back. */
async function switchBack() {
  const ws = st.switchedFrom;
  if (!ws) return;
  st.switchedFrom = null;
  await showProject(ws);
  // Its tabs come back from where the browser kept them.
  for (const id of [...st.hiddenOpen]) {
    const r = rowOf(id);
    if (r && inView(r)) {
      st.hiddenOpen = st.hiddenOpen.filter((x) => x !== id);
      await openPane(id);
    }
  }
  paintList();
  writeUrl();
}

/**
 * #80, scope wins: no pane of this project is open (the top bar's project
 * changed under the pane): its most recent running agent comes in front,
 * else the pane says to pick one there.
 */
async function paneFollowsProject() {
  if (st.open.length) return;
  const view = viewWorkspaces();
  if (view.length !== 1) return;
  // Issue 482: the Terminals page: the project's terminal used last.
  if (PAGE === "terminal") {
    const sh = latestShell(visibleRows(), view[0], shellUsed());
    if (sh) await openPane(sh.id);
    return;
  }
  const latest = visibleRows()
    .filter(
      (r) => r.kind === "agent" && !isStopped(r) && r.workspace === view[0],
    )
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];
  if (latest) await openPane(latest.id);
}

/**
 * The person's layout (GET /api/settings agents_layout), else Focus; and
 * where a path link opens (editor_open), else none.
 */
async function savedLayout() {
  try {
    const r = await fetch("/api/settings", { headers: { accept: "json" } });
    const b = r.ok ? await r.json() : null;
    if (typeof b?.editor_open === "string") st.editorOpen = b.editor_open;
    st.reconnect = reconnectOptions(b?.panes_reconnect);
    if (Number.isInteger(b?.agents_helpers_shown) && b.agents_helpers_shown > 0)
      st.helpersShown = b.agents_helpers_shown;
    return LAYOUTS.includes(b?.agents_layout) ? b.agents_layout : "focus";
  } catch {
    return "focus";
  }
}

async function loadScope() {
  try {
    const r = await fetch("/api/scope");
    const s = r.ok ? await r.json() : null;
    st.scope = s?.scope ?? "all";
  } catch {
    st.scope = "all";
  }
}

export { GROUPS_EVERY_MS, LIST_FLOOR_MIN_PX, LIST_FLOOR_ROWS, MOVED_KEY, STOPPED_OPEN_KEY, clearCompacting, fitListFloor, hideOtherProjects, inView, listFocusKey, loadGroups, loadScope, markMovedSeen, movedNote, movedSeen, paintList, paintSub, paneFollowsProject, placeHelperToggles, saveStoppedOpen, savedLayout, scopeLabelFor, setBy, setList, showAllActive, showProject, stoppedGroupHtml, stoppedOpen, switchBack, switchToProjectOf, terminalsBodyHtml, terminalsHref, visibleRows };
