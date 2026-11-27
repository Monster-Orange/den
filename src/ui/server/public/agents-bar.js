import { refresh } from "/agents-data.js";
import { toolsStale } from "/agent-groups.js";
import { helperBarButtonHtml } from "/agent-helpers.js";
import { SERVER_WS, agentPath, api, esc, restartKey, rowOf, st, t } from "/agents-core.js";
import { compactingHtml, compactingTag, cwdText, hubBoundTag, instructionsTag, isStopped, linkTag, mcpStaleTag, modeName, modeTagHtml, paneName, projName, rotActionsHtml, rotMessage, rotationOf, rotationWhy, sessionExtra, signInTag, stateTone, stopReason, stoppedTip, subagentTag, tileHtml, whereTag, wsLinkHtml } from "/agents-rows.js";
import { reconnectHtml } from "/agents-term.js";
import { shownLayout } from "/agents-url.js";
import { followRestarts, restartAllHtml, restartNow, waitsOnPerson } from "/restart-result.js";
import { projectColour } from "/workspace-picker.js";

/**
 * D47: on a running agent's pane, the services it reaches only through
 * their API; on a runtime that can't be held to it, that it isn't.
 */
function apiOnlyTag(r) {
  const names = Array.isArray(st.data?.apiOnly) ? st.data.apiOnly : [];
  if (!names.length || r?.kind !== "agent" || isStopped(r)) return "";
  const list = names.join(", ");
  return r.runtime === "den-claude"
    ? `<span class="tagx" data-api-only title="${esc(t("ag.apiOnlyTip", { names: list }))}">${esc(t("ag.apiOnly", { names: list }))}</span>`
    : `<span class="tagx warn" data-api-only="off" title="${esc(t("ag.apiOnlyOffTip", { names: list }))}">${esc(t("ag.apiOnlyOff"))}</span>`;
}

/**
 * Issue 1407: above the list, when two or more agents in view need a
 * restart for their tools: how many, Restart all at their next idle, and
 * Restart all now for those that wait on the person.
 */
function toolsBarHtml(rows) {
  const stale = rows.filter((r) => {
    const why = toolsStale(r);
    return why && why !== "restarting";
  });
  if (stale.length < 2) return "";
  const run = st.restartRun;
  const asked = stale
    .map((r) => st.restarts.get(restartKey(r.workspace, r.agent)))
    .filter(Boolean);
  return (
    `<div class="agnote" data-note="tools-stale" role="status">${esc(t("rs.bar", { n: stale.length }))} ` +
    (run
      ? `<button type="button" class="den-btn sm" data-act="tools-restart-all" disabled aria-busy="true">${esc(t("rs.barBusy", { done: run.done, total: run.total }))}</button>`
      : `<button type="button" class="den-btn sm" data-act="tools-restart-all">${esc(t("rs.barBtn", { n: stale.length }))}</button>`) +
    restartAllHtml(asked, t) +
    `</div>`
  );
}

/** Which of the bar's controls `el` is: its data-act, or its place. */
function barKey(bar, el) {
  const c = el.closest("button, a, [tabindex]");
  if (!c || !bar.contains(c)) return null;
  if (c.dataset.act) return { act: c.dataset.act };
  const all = Array.from(bar.querySelectorAll("button, a, [tabindex]"));
  return { at: all.indexOf(c) };
}

function barFind(bar, k) {
  if (k.act) return bar.querySelector(`[data-act="${CSS.escape(k.act)}"]`);
  return bar.querySelectorAll("button, a, [tabindex]")[k.at] ?? null;
}

/**
 * Issue 1311: "N messages waiting" on a pane whose person is typing a
 * message: Den holds its own until theirs is sent or cleared.
 */
function draftWaitingTag(p) {
  const n = p.draftWaiting ?? 0;
  if (n <= 0) return "";
  return `<span class="tagx" role="status" data-draft-waiting="${n}" title="${esc(t("ag.draftWaitingTip"))}">${esc(t("ag.draftWaiting", { n }))}</span>`;
}

function paintBar(p) {
  const r = rowOf(p.id);
  const bar = p.el.querySelector(".bar2");
  const name = r ? paneName(r) : p.label || p.id;
  // AG-4b: the session's name last, when it says more. The workspace is a
  // link to it on Workspaces (0.4.17).
  const ws = r ? r.workspace : p.workspace || "";
  // D37: a stopped agent's pane has what its one-line row leaves out.
  const rest = r
    ? (isStopped(r)
        ? [r.persona, r.agent, r.runtime, cwdText(r)]
        : [r.runtime, sessionExtra(r)]
      )
        .filter(Boolean)
        .join(" · ")
    : "";
  // 0.4.44: the project stays whole; the runtime and the rest are cut.
  const where =
    (ws ? `<span class="wsn">${wsLinkHtml(ws)}</span>` : "") +
    (rest ? `<span class="rt">${ws ? " · " : ""}${esc(rest)}</span>` : "");
  const tone = r ? stateTone(r) : p.exited ? "off" : "pending";
  const stop =
    r?.kind === "agent" && (r.state === "running" || r.state === "stopping")
      ? `<button type="button" class="den-btn sm" data-act="stop" aria-label="${esc(t("ag.stopName", { id: r.agent }))}">${esc(t("ag.stop"))}</button>`
      : "";
  // The 0.4.39 gate's note: a shell is closed here, not only with `exit`.
  const closeShell =
    r?.kind === "session" && !r.exited
      ? `<button type="button" class="den-btn sm" data-act="close-shell" title="${esc(t("ag.closeShellTip"))}">${esc(t("ag.closeShell"))}</button>`
      : "";
  // Issue 448: a second shell on purpose (the rail's Terminal reopens this).
  const newShell =
    r?.kind === "session"
      ? `<button type="button" class="den-btn sm" data-act="new-shell" title="${esc(t("ag.newShellTip"))}">${esc(t("ag.newShell"))}</button>`
      : "";
  // The mock's pane bar: Resume (primary) on an ended agent that can.
  const resume =
    r && isStopped(r) && r.resumable
      ? `<button type="button" class="den-btn sm primary" data-act="resume" aria-label="${esc(t("ag.resumeName", { id: r.agent }))}">${esc(t("ag.resume"))}</button>`
      : "";
  const reconnect = reconnectHtml(p);
  // AG-DROP: Attach (a touch screen has no drop): a live session's only.
  const attach =
    !p.lost && !p.exited && !(r && isStopped(r))
      ? `<button type="button" class="den-btn sm" data-act="attach" aria-label="${esc(t("ag.up.attachName", { id: name }))}" title="${esc(t("ag.up.attachTip"))}">${esc(t("ag.up.attach"))}</button>`
      : "";
  // AG-18: ⋯, its menu: Rename… (D25, every agent), Change persona… (a
  // runtime that can resume).
  const more =
    r?.kind === "agent"
      ? `<button type="button" class="den-btn sm" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t("ag.more", { id: r.agent }))}" title="${esc(t("ag.more", { id: r.agent }))}">⋯</button>`
      : "";
  // Issue 170: the tags in one box. Beside the name on a wide pane; on a
  // phone a line of their own, so they never cut the project's name.
  const tags =
    (r?.tokenRevoked
      ? `<span class="tagx warn" title="${esc(t("ag.revokedTip"))}">${esc(t("ag.revoked"))}</span>`
      : "") +
    apiOnlyTag(r) +
    // Issue 278: compacting repeatedly; instructions. Why and Clear are
    // on a line of their own below (Stop is the bar's own).
    compactingTag(r) +
    instructionsTag(r) +
    mcpStaleTag(r, true) +
    modeTagHtml(r, true) +
    whereTag(r, true) +
    linkTag(r) +
    subagentTag(r) +
    signInTag(r) +
    hubBoundTag(r) +
    draftWaitingTag(p);
  const html =
    `<span class="den-dot ${tone}" aria-hidden="true"></span>` +
    // Issue 168: the agent's letter tile, in its project's colour.
    (r?.kind === "agent" ? tileHtml(name) : "") +
    `<b>${esc(name)}</b>${where ? '<span class="sep" aria-hidden="true">·</span>' : ""}<span class="where mono">${where}</span>` +
    (r && isStopped(r)
      ? `<span class="why" data-why title="${esc(stoppedTip(r))}">${esc(stopReason(r))}</span>`
      : "") +
    (tags ? `<span class="agtags" data-tags>${tags}</span>` : "") +
    (r?.kind === "agent" && rotActionsHtml(r)
      ? `<span class="agrot" data-rot-bar title="${esc(rotMessage(r))}"><span class="tagx warn" data-rotation="${rotationOf(r)}">${esc(t(rotationOf(r) === "ready" ? "ag.rot.ready" : "ag.rot.due", { why: rotationWhy(r.rotation) }))}</span>${rotActionsHtml(r)}</span>`
      : "") +
    (r?.kind === "agent" && compactingHtml(r, t, { withStop: false })
      ? `<span class="agctx" data-compacting-bar>${compactingHtml(r, t, { withStop: false })}</span>`
      : "") +
    `<span class="x">${r?.kind === "agent" ? helperBarButtonHtml(r) : ""}${reconnect}${attach}${stop}${newShell}${closeShell}${resume}${more}<button type="button" class="den-btn sm" data-act="close" aria-label="${esc(t("ag.detachName", { id: name }))}" title="${esc(t("ag.detach"))}">×</button></span>`;
  // A refresh (a helper's update, the list's poll) redraws only what
  // changed, and never takes the keyboard off the bar: a button there that
  // had focus has it again after a redraw.
  if (p.barHtml !== html) {
    const had = bar.contains(document.activeElement)
      ? barKey(bar, document.activeElement)
      : null;
    bar.innerHTML = html;
    p.barHtml = html;
    if (had) barFind(bar, had)?.focus();
  } else {
    // Unchanged: a button an action turned off while it ran (Stop, Write
    // handoff) comes back, as a redraw used to bring it back. The bar's
    // own HTML never turns one off.
    for (const b of bar.querySelectorAll("button:disabled")) b.disabled = false;
  }
  // 0.4.44: who the keyboard types to, under the terminal, in the
  // project's colour (a message once went to the wrong agent's tab).
  const to = p.el.querySelector(".agto");
  if (to) {
    const said = ws
      ? t("ag.to", {
          name,
          ws: ws === SERVER_WS ? t("ag.server") : projName(ws),
        })
      : t("ag.toName", { name });
    if (to.textContent !== said) to.textContent = said;
  }
  // Issue 168: the pane's band and To line in its project's colour (the
  // server agent's: none, neutral grey).
  const pc = projectColour(st.projects, ws);
  if (pc) {
    if (p.el.dataset.pc !== pc) p.el.dataset.pc = pc;
  } else if (p.el.dataset.pc) delete p.el.dataset.pc;
  // Tabs: the tab's × closes it; the pane's bar has none.
  const x = bar.querySelector('[data-act="close"]');
  if (x) x.hidden = shownLayout() === "tabs";
}


/**
 * MODE-3: restart it now, on the same conversation; it starts in its mode
 * (the server reads it again at every start). Only a person's page can
 * (the restart route refuses an agent).
 */
async function applyMode(r, button) {
  await window.denShell.busyAction(
    "restart-agent",
    (headers) =>
      api("POST", agentPath(r, "restart"), { when: "now" }, { headers }),
    {
      button,
      vars: { name: r.agent },
      success: () => t("ag.mode.applied", { id: r.agent, m: modeName(r.mode) }),
    },
  );
  await refresh();
}

/**
 * D44: Restart at its next idle. Issue 1407: the answer is its own, under
 * its row: restarting now, after its turn, a background job (what, how
 * long) or can't tell, those two with Restart now (which ends the job).
 */
async function restartForTools(r, button) {
  const base = { id: r.agent, workspace: r.workspace };
  let answer = null;
  await window.denShell.busyAction(
    "restart-agent",
    (headers) =>
      api(
        "POST",
        agentPath(r, "restart"),
        { when: "after-turn" },
        { headers },
      ).then(
        (x) => (answer = { ...base, state: x?.state ?? "turn" }),
        (e) => {
          if (e?.code === "job_running")
            answer = {
              ...base,
              state: "job",
              job: {
                command: String(e.data?.job?.command ?? ""),
                minutes: Number(e.data?.job?.minutes) || 0,
              },
            };
          else if (e?.code === "turn_unknown")
            answer = { ...base, state: "unknown" };
          else throw e;
          return answer;
        },
      ),
    {
      button,
      vars: { name: r.agent },
      success: (out) =>
        waitsOnPerson(out)
          ? t("ag.job.held", { id: r.agent })
          : t("ag.mcp.restarting", { id: r.agent }),
    },
  );
  if (answer) st.restarts.set(restartKey(r.workspace, r.agent), answer);
  await refresh();
  followAgentRestarts();
}

let restartFollow = null;

/**
 * The asked restarts, followed live: each row takes the
 * server's state (restarted, a wait that ran out, failed); one the server
 * doesn't list has cleared. The list refreshes on each change, so the
 * stale bar drops an agent the moment it is back.
 */
function followAgentRestarts() {
  if (restartFollow || (!st.restarts.size && !st.restartRun)) return;
  restartFollow = followRestarts({
    api,
    onRows: (rows, run) => {
      const before = JSON.stringify(st.restartRun);
      st.restartRun = run ?? null;
      if (JSON.stringify(st.restartRun) !== before) void refresh();
      if (!st.root?.isConnected || (!st.restarts.size && !st.restartRun)) {
        restartFollow?.stop();
        restartFollow = null;
        return;
      }
      let changed = false;
      for (const [k, a] of [...st.restarts]) {
        const live = rows.find((b) => restartKey(b.workspace, b.id) === k);
        if (!live) {
          st.restarts.delete(k);
          changed = true;
        } else if (live.state !== a.state) {
          st.restarts.set(k, live);
          changed = true;
        }
      }
      if (!st.restarts.size && !st.restartRun) {
        restartFollow?.stop();
        restartFollow = null;
      }
      if (changed) void refresh();
    },
    onEnd: () => {
      restartFollow = null;
    },
  });
}

/** Issue 1407: Restart all the stale agents at their next idle (restart-stale). */
async function restartAllForTools(button) {
  const out = await window.denShell.busyAction(
    "restart-agent",
    (headers) => api("POST", "/api/agents/restart-stale", {}, { headers }),
    { button, vars: { name: t("rs.allName") } },
  );
  for (const a of Array.isArray(out?.agents) ? out.agents : [])
    st.restarts.set(restartKey(a.workspace, a.id), a);
  st.restartRun = out?.run ?? null;
  await refresh();
  followAgentRestarts();
}

async function resumeRestartRun() {
  try {
    const r = await api("GET", "/api/agents/restart-status");
    st.restartRun = r?.run ?? null;
  } catch {
    st.restartRun = null;
  }
  if (st.restartRun) followAgentRestarts();
}

/** Issue 1407: Restart now (ends a job), one agent's or all that wait. */
async function restartNowFor(buttons) {
  const o = {
    api,
    busyAction: window.denShell.busyAction?.bind(window.denShell),
  };
  for (const b of buttons) {
    const ok = await restartNow(b, o);
    const k = restartKey(b.dataset.rsWs, b.dataset.rsNow);
    const a = st.restarts.get(k) ?? {
      id: b.dataset.rsNow,
      workspace: b.dataset.rsWs,
    };
    st.restarts.set(k, { ...a, state: ok ? "done" : "failed" });
  }
  await refresh();
  followAgentRestarts();
}

export { apiOnlyTag, applyMode, barFind, barKey, draftWaitingTag, followAgentRestarts, paintBar, restartAllForTools, restartFollow, restartForTools, restartNowFor, resumeRestartRun, toolsBarHtml };
