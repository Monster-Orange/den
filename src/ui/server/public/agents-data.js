import { railNeeds } from "/agent-bands.js";
import { toastAutoRelaunches } from "/agents-actions.js";
import { paintBar } from "/agents-bar.js";
import { REFRESH_MS, rowOf, st, t } from "/agents-core.js";
import { paintLayout, paintTabs } from "/agents-layout.js";
import { GROUPS_EVERY_MS, hideOtherProjects, loadGroups, paintList, paintSub, scopeLabelFor } from "/agents-list.js";
import { inStopped } from "/agents-rows.js";
import { connect } from "/agents-term.js";
import { urlWorkspace, viewWorkspaces, writeUrl } from "/agents-url.js";

/** 0.4.45: the projects' names changed: everything that says them. */
function repaintNames() {
  st.scopeLabel = scopeLabelFor(viewWorkspaces());
  paintList();
  paintSub();
  for (const pane of st.panes.values()) paintBar(pane);
  const strip = st.root?.querySelector("#agr > .agtabs");
  if (strip) paintTabs(strip);
}

/**
 * den#156: the list again, then the next one, always: an answer that never
 * comes (a host that doesn't answer) can't stop the list for good.
 */
async function refresh() {
  clearTimeout(st.timer);
  let listed = false;
  try {
    await refreshOnce();
    listed = true;
  } finally {
    nextRefresh(listed);
  }
}

/** den#156: until a list says otherwise (agents_list.refresh_timeout_seconds). */
const LIST_WAIT_S = 15;

async function refreshOnce() {
  try {
    const ws = urlWorkspace();
    // den#156: a list that doesn't come in time is a problem the page
    // says out loud (paintList), not a wait that holds it.
    const ac = new AbortController();
    const wait = setTimeout(
      () => ac.abort(),
      (st.listWaitS ?? LIST_WAIT_S) * 1000,
    );
    let r;
    try {
      r = await fetch(
        ws ? `/api/sessions?ws=${encodeURIComponent(ws)}` : "/api/sessions",
        { headers: { accept: "json" }, signal: ac.signal },
      );
    } catch (e) {
      st.hostDown = true;
      throw e;
    } finally {
      clearTimeout(wait);
    }
    // 0.4.45: the projects' names (a rename in Hub shows here within
    // 30 s of reaching this install). The first list waits for them, so
    // nothing paints a slug first.
    if (!st.projectsAt || Date.now() - st.projectsAt > 30_000) {
      st.projectsAt = Date.now();
      const names = fetch("/api/workspaces", { headers: { accept: "json" } })
        .then((x) => (x.ok ? x.json() : null))
        .then((d) => {
          if (!d) return false;
          // Issue 168: a colour change repaints too, not only a name.
          const key = (x) =>
            JSON.stringify([x?.workspaces ?? null, x?.projectColours ?? null]);
          const was = key(st.projects);
          st.projects = d;
          return key(d) !== was;
        })
        .catch(() => false);
      // At most 3 s: a slow answer paints the slugs, then the names.
      if (!st.projects)
        await Promise.race([
          names.then((changed) => {
            if (changed && st.data) repaintNames();
          }),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      else
        void names.then((changed) => {
          if (changed) repaintNames();
        });
    }
    // Issue 750: Hub's groups, now and then (Den keeps its own copy too).
    if (!st.groupsAt || Date.now() - st.groupsAt > GROUPS_EVERY_MS)
      void loadGroups();
    if (r.status === 401) {
      st.signedOut = true;
    } else if (r.ok) {
      st.data = await r.json();
      st.signedOut = false;
      // den#156: the host didn't answer (or couldn't be reached): say so.
      st.hostDown = !!st.data?.hostError;
      if (typeof st.data?.refreshTimeoutSeconds === "number")
        st.listWaitS = st.data.refreshTimeoutSeconds;
      toastAutoRelaunches(st.data?.sessions ?? []);
    }
  } catch {
    /* the last list stays; the next ask may answer */
  }
  st.loadFailed = !st.data && !st.signedOut;
  followAgents();
  window.denShell?.setState?.({
    helpersRunning: (st.data?.sessions ?? []).reduce(
      (n, r) => n + (r.helpers?.running ?? 0),
      0,
    ),
    agentsNeedYou: railNeeds(
      (st.data?.sessions ?? []).filter((r) => !inStopped(r)),
    ),
  });
  for (const [id, at] of st.seenNow) {
    const r = rowOf(id);
    if (!r || r.attn !== "done" || r.attnSince !== at) st.seenNow.delete(id);
  }
  st.scopeLabel = scopeLabelFor(viewWorkspaces());
  hideOtherProjects();
  paintList();
  paintSub();
  for (const p of st.panes.values()) {
    // D66: each pane keeps its soft newline for when its row is gone.
    const seq = rowOf(p.id)?.softNewline;
    if (typeof seq === "string" && seq) p.softNewline = seq;
    paintBar(p);
  }
  const strip = st.root.querySelector("#agr > .agtabs");
  if (strip) paintTabs(strip);
}

function nextRefresh(listed) {
  if (!st.root?.isConnected) return;
  // A pane whose session just ended may have a new one soon (a persona
  // change, a resume): look again every second for a while.
  const soon =
    Date.now() < (st.followUntil ?? 0) || (listed && !!st.data?.helpersPending);
  st.timer = setTimeout(
    () => {
      if (!document.hidden) void refresh();
      else st.timer = setTimeout(refresh, REFRESH_MS);
    },
    soon ? FOLLOW_MS : REFRESH_MS,
  );
}

/** How often, and how long, the list is read after a pane's session ends. */
const FOLLOW_MS = 1_000;

const FOLLOW_FOR_MS = 15_000;

/**
 * A pane follows its agent, not a session (AG-18): when the agent's
 * session changes (Change persona, Resume, a rotation), the pane moves to
 * the new one in the same slot, its scrollback kept.
 */
function followAgents() {
  for (const p of [...st.panes.values()]) {
    const r = knowAgent(p);
    if (!p.agent || p.closed || r?.state === "running") continue;
    const next = st.data?.sessions?.find(
      (x) =>
        x.kind === "agent" &&
        x.agent === p.agent &&
        x.workspace === p.agentWs &&
        x.id !== p.id &&
        x.state === "running",
    );
    if (next && !st.panes.has(next.id)) retarget(p, next);
  }
}

/**
 * Pane `p` notes its agent from its row, while the row is there; its row
 * goes when its session ends. Issue 202: a pane opened after a list read
 * learns it at once, not at the next read: a session ended before then
 * (Change persona) left the pane on the old one for good.
 */
function knowAgent(p) {
  const r = rowOf(p.id);
  if (r?.kind === "agent" && r.agent) {
    p.agent = r.agent;
    p.agentWs = r.workspace;
  }
  return r;
}

/** The pane's line for a resume that had nothing to continue (AG-14); kept, as noteLine's. */
function freshLine(p) {
  noteLine(p, `\x1b[2m${t("ag.freshLine")}\x1b[0m\r\n`);
}

function noteLine(p, line) {
  (p.notes ??= []).push(line);
  p.term?.write(line);
}

function forgetPty(p) {
  p.pty = null;
  delete p.el.dataset.ptyCols;
  delete p.el.dataset.ptyRows;
}

/** Move pane `p` to session row `row`, where it was. */
function retarget(p, row) {
  const old = p.id;
  // Another session: a connection of its own.
  p.conn?.stop();
  p.conn = null;
  p.sock = null;
  p.recon = null;
  forgetPty(p);
  st.panes.delete(old);
  p.id = row.id;
  st.panes.set(row.id, p);
  st.open = st.open.map((x) => (x === old ? row.id : x));
  if (st.side.delete(old)) st.side.add(row.id);
  if (st.cur === old) st.cur = row.id;
  p.el.dataset.id = row.id;
  p.el.setAttribute("aria-label", row.label ?? row.id);
  p.exited = false;
  p.lost = false;
  p.notes = [];
  noteLine(
    p,
    `\r\n\x1b[2m${t("ag.switched", { p: row.persona ?? row.agent })}\x1b[0m\r\n`,
  );
  if (st.fresh.delete(`${p.agentWs}\u0000${p.agent}`)) freshLine(p);
  paintBar(p);
  paintLayout();
  writeUrl();
  void connect(p);
}

export { FOLLOW_FOR_MS, FOLLOW_MS, LIST_WAIT_S, followAgents, forgetPty, freshLine, knowAgent, nextRefresh, refresh, refreshOnce, repaintNames, retarget };
