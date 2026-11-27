import {
  bandGroup,
  chipHtml,
  markHtml,
  metaHtml,
  needsWhy,
  rowState,
  sinceShort,
  tagHtml,
} from "/agent-bands.js";
import {
  toolsRestartButton,
  toolsRestartHtml,
  toolsStale,
} from "/agent-groups.js";
import {
  helperBadgeHtml,
  helperCountSaid,
  helperRowsHtml,
  helperToggleHtml,
} from "/agent-helpers.js";
import { orderGroup, orderable } from "/agent-order.js";
import {
  CLI,
  SERVER_WS,
  TITLE,
  agd,
  api,
  esc,
  restartKey,
  rowOf,
  st,
  t,
} from "/agents-core.js";
import { viewWorkspaces, visibleIds } from "/agents-url.js";
import { formatTime, timeHtml } from "/kit/time.js";
import { modeLabel, overrideTagsHtml, ownModeLabel } from "/persona-ui.js";
import { restartRowHtml } from "/restart-result.js";
import { projectColour, projectLabel } from "/workspace-picker.js";

function stateTone(r) {
  // The shell's dot: plain is the good one (the repo table's look).
  if (r.state === "running") return "";
  if (r.state === "stopping") return "pending";
  if (/^exited \((?!0\))/.test(r.state)) return "bad";
  return "off";
}

function stateText(state) {
  const m = /^exited(?: \((-?\d+)\))?$/.exec(state);
  if (m)
    return m[1] === undefined
      ? t("ag.state.exited")
      : t("ag.state.exitedCode", { code: m[1] });
  return ["running", "stopping", "stopped", "ended", "interrupted"].includes(
    state,
  )
    ? t(`ag.state.${state}`)
    : state;
}

function displayName(r) {
  if (r.kind !== "agent") return r.label;
  return r.displayName || (r.persona ?? r.label);
}

/**
 * A row's name: the name a person gave it (AG-4b), then its persona and
 * id; else its persona, then its id (when they differ).
 */
function nameHtml(r) {
  const extra = sessionExtra(r);
  if (r.displayName)
    return `${esc(r.displayName)} <span class="id">${esc([r.persona, r.label, extra].filter(Boolean).join(" · "))}</span>`;
  const id = [r.persona && r.persona !== r.label ? r.label : "", extra]
    .filter(Boolean)
    .join(" · ");
  return `${esc(displayName(r))}${id ? ` <span class="id">${esc(id)}</span>` : ""}`;
}

/**
 * The session's name (AG-4b: the runtime's /rename or Den's, the later),
 * where it says more than the agent's own name: not empty, not the
 * persona, not the name already shown. Else "".
 */
function sessionExtra(r) {
  const n = r?.kind === "agent" ? (r.sessionTitle ?? "").trim() : "";
  if (!n || n === r.persona || n === paneName(r) || n === displayName(r))
    return "";
  return n;
}

// A pane's title and its Close: the agent's display name (AG-10.8), else
// its id, never the persona. There is no display name before AG-10.
function paneName(r) {
  return r.kind === "agent" ? r.displayName || r.agent || r.label : r.label;
}

/** An agent that isn't running: stopped, interrupted or exited (AG-14). */
export function isStopped(r) {
  return r.kind === "agent" && r.state !== "running" && r.state !== "stopping";
}

/** 0.4.45: a shell that exited (it has nothing to resume). */
export const exitedShell = (r) => r?.kind === "session" && r.exited === true;

/** 0.4.45: what the Stopped group holds: stopped agents, exited shells. */
export const inStopped = (r) => isStopped(r) || exitedShell(r);

/** issue 206: true when `iso` is today in the person's own zone. */
function isToday(iso) {
  const day = formatTime(iso, { style: "date" });
  return !!day && day === formatTime(Date.now(), { style: "date" });
}

/** "7:52 PM" today, else "Nov 6, 7:52 PM": the person's zone (issue 206). */
function when(iso) {
  return formatTime(iso, { style: isToday(iso) ? "time" : "datetime" });
}

/** Why a stopped agent stopped (AG-14.1). */
export function stopReason(r) {
  // Issue 659: its folder-trust question was declined: it never started.
  if (r.trustDeclined) return t("ag.why.trustDeclined");
  // Issue 631: it didn't come back after a restart (its terminal host's
  // too), and why.
  if (r.restartFailed?.why)
    return t("ag.why.restartFailed", { why: r.restartFailed.why });
  if (r.state === "interrupted")
    return t("ag.why.interrupted", { name: TITLE });
  if (r.state === "stopped")
    return t("ag.why.stopped", { time: when(r.stoppedAt ?? "") }).trim();
  const m = /^exited(?: \((-?\d+)\))?$/.exec(r.state);
  if (m)
    return m[1] === undefined
      ? t("ag.why.exited")
      : t("ag.why.exitedCode", { code: m[1] });
  return stateText(r.state);
}

/** Why it rotates, in words: "3 compactions", "PR merged" (den#4). */
function rotationWhy(rot) {
  if (rot.due === "pr-merged") return t("ag.rot.merged");
  return t(
    rot.compactions === 1 ? "ag.rot.compactions.one" : "ag.rot.compactions",
    {
      n: rot.compactions,
    },
  );
}

/** The Workspaces page, focused on workspace `ws` (0.4.17). */
function wsHref(ws) {
  const nav = window.denShell?.nav?.() ?? [];
  const base = nav.find((n) => n.id === "local-dev")?.href ?? "/local-dev";
  return `${base}?project=${encodeURIComponent(ws)}`;
}

/**
 * 0.4.45: a project's name as the header's picker shows it: Hub's when it
 * is linked to a Hub project, else its own (workspace-picker.js). From
 * /api/workspaces, read with the list now and then (st.projects).
 */
function projName(ws) {
  return projectLabel(st.projects, ws);
}

/**
 * Issue 168: ` data-pc="<colour>"` for what belongs to project `ws` (its
 * agents' rows, tabs and pane inherit its colour), or "" for none (the
 * server agent: neutral grey). The colour is in CSS (shell.js, --pc).
 */
function pcAttr(ws) {
  const c = projectColour(st.projects, ws);
  return c ? ` data-pc="${esc(c)}"` : "";
}

/**
 * Issue 168: an agent's letter tile, in its project's colour. The letter
 * is drawn by CSS (data-l), so the row's and the bar's text stay the
 * agent's name alone, as screen readers and copies read it.
 */
function tileHtml(name) {
  const ch = [...String(name ?? "").trim()][0] ?? "";
  return ch
    ? `<span class="agtile" data-l="${esc(ch.toLocaleUpperCase())}" aria-hidden="true"></span>`
    : "";
}

/** Workspace `ws` as a link to it on Workspaces. */
function wsLinkHtml(ws) {
  // ON-6: the server agent belongs to no workspace: its group is "Server".
  if (ws === SERVER_WS)
    return `<span class="wslink" data-server>${esc(t("ag.server"))}</span>`;
  const name = projName(ws);
  // Issue 168: its colour beside its name, never colour alone.
  return `<span class="den-pc"${pcAttr(ws)} aria-hidden="true"></span><a class="wslink" href="${esc(wsHref(ws))}" title="${esc(t("ag.goWs", { ws: name }))}">${esc(name)}</a>`;
}

/**
 * D20: where its session runs, as a tag: "Stops at logout" (the desktop
 * session) or "No GUI" (outside it: kept across logout). `button`: a
 * button that says why when tapped (the pane bar); else a span (a row,
 * itself a button). "" when the host didn't say (off macOS, older host).
 */
function whereTag(r, button = false) {
  const s = r?.launchd;
  const logout = s === "Aqua" || s === "LoginWindow";
  if (!logout && s !== "Background" && s !== "System") return "";
  const key = logout ? "ag.where.logout" : "ag.where.bg";
  const tip = t(`${key}Tip`, { cli: CLI });
  const cls = `tagx${logout ? " warn" : ""}`;
  const where = logout ? "logout" : "bg";
  return button
    ? `<button type="button" class="${cls}" data-act="where" data-where="${where}" title="${esc(tip)}" aria-label="${esc(`${t(key)}: ${tip}`)}">${logout ? "⚠ " : ""}${esc(t(key))}</button>`
    : `<span class="${cls}" data-where="${where}" title="${esc(tip)}">${logout ? "⚠ " : ""}${esc(t(key))}</span>`;
}

/**
 * D65 v2: "<project> › <repo>" in the pane bar, with Change; a repo that
 * is no longer its project's says so, with Re-link. Read from its record,
 * never its folder.
 */
function linkTag(r) {
  if (r?.kind !== "agent" || r.server) return "";
  const project = projName(r.project || r.workspace);
  const path = r.repo ? `${project} › ${r.repo}` : project;
  return (
    `<span class="aglink" data-link><span class="mono">${esc(path)}</span>` +
    (r.repoMissing
      ? `<span class="tagx warn" data-repo-missing>${esc(t("ag.link.missing"))}</span>`
      : "") +
    `<button type="button" class="den-lnk" data-act="link" aria-label="${esc(t("ag.link.changeName", { id: r.agent }))}">${esc(t(r.repoMissing ? "ag.link.relink" : "ag.link.change"))}</button></span>`
  );
}

/**
 * den#3: what its subagents run on, and where that came from: the pane
 * bar's tag. Nothing for a runtime that takes no subagent model.
 */
function subagentTag(r) {
  if (r?.kind !== "agent" || !r.subagentModel) return "";
  const inherit = r.subagentModel === "inherit";
  const model = inherit ? t("ag.subagents.inherit") : r.subagentModel;
  const from = r.subagentModelFrom || "default";
  // inherit: Den sets none, said plainly (not "runs on the runtime's").
  const tip = inherit
    ? t(`ag.subagents.inheritFrom.${from === "persona" ? "persona" : "org"}`)
    : t(`ag.subagents.from.${from}`, { model });
  return `<span class="tagx" data-subagents="${esc(r.subagentModel)}" title="${esc(tip)}">${esc(t("ag.subagents", { model }))}</span>`;
}

/**
 * Issue 340: the vendor account it runs on under the always-on service, by
 * its label (never an email): the pane bar's tag. Nothing without one.
 */
function signInTag(r) {
  if (r?.kind !== "agent" || !r.signIn) return "";
  return `<span class="tagx" data-signin title="${esc(t("ag.signIn.tip", { label: r.signIn }))}">${esc(t("ag.signIn", { label: r.signIn }))}</span>`;
}

function hubBoundTag(r) {
  if (r?.kind !== "agent" || typeof r.hubBound !== "boolean") return "";
  const [word, tip] = r.hubBound
    ? [t("ag.hub.bound"), t("ag.hub.bound.tip")]
    : [t("ag.hub.unbound"), t("ag.hub.unbound.tip")];
  return `<span class="tagx" data-hub-bound="${r.hubBound}" title="${esc(tip)}">${esc(word)}</span>`;
}

/** Its rotation, when one is due: "ready" or "due" (den#4). */
function rotationOf(r) {
  // D28: on_due off: nothing will happen, so nothing is shown.
  if (!r.rotation?.due || r.rotation.onDue === "off") return "";
  return r.rotation.ready ? "ready" : "due";
}

/** D28: Settings › Agents (its Rotation row). */
function settingsHref() {
  const nav = window.denShell?.nav?.() ?? [];
  const base = nav.find((n) => n.id === "settings")?.href ?? "/settings";
  return `${base}?q=rotation#agents`;
}

/**
 * D28: what happens to a due agent, in words, from its on_due (auto: Den
 * asks for the handoff at idle and relaunches it; ask; auto that gave up
 * asking). Older servers send no on_due: as ask.
 */
function rotMessage(r) {
  const rot = r.rotation;
  const why = rotationWhy(rot);
  const auto = rot.onDue === "auto" && !rot.fellBack;
  // Issue 914: its turn is over, but background work it started still runs.
  if (rot.waiting > 0)
    return t(rot.waiting === 1 ? "ag.rc.waiting.one" : "ag.rc.waiting", {
      why,
      n: rot.waiting,
    });
  if (rot.relaunchWanted && !rot.ready) return t("ag.rc.wanted", { why });
  if (auto && !isStopped(r))
    return t(rot.ready ? "ag.rc.autoReady" : "ag.rc.autoAsk", { why });
  if (rot.fellBack && !rot.ready)
    return t(
      rot.handoff === "invalid" ? "ag.rc.fellBackBad" : "ag.rc.fellBack",
      { why },
    );
  return t(
    rot.ready
      ? "ag.rc.ready"
      : rot.handoff === "invalid"
        ? "ag.rc.bad"
        : "ag.rc.missing",
    { why },
  );
}

/**
 * D28: the rotation callout's buttons, wherever it shows (a row, the pane
 * bar): Relaunch now (from the handoff, or asking for it first), Write
 * handoff (a running agent without one), Keep this conversation with
 * "don't ask again", and Settings. "" when nothing is due or on_due is off.
 */
function rotActionsHtml(r) {
  const rot = r.rotation;
  if (!rot?.due || rot.onDue === "off") return "";
  const id = r.agent;
  const now = `<button type="button" class="den-btn sm primary" data-act="relaunch" aria-label="${esc(t("ag.relaunchName", { id }))}">${esc(t("ag.relaunch"))}</button>`;
  const write =
    !isStopped(r) && !rot.ready && !rot.relaunchWanted
      ? `<button type="button" class="den-btn sm" data-act="rot-write" aria-label="${esc(t("ag.rc.writeName", { id }))}">${esc(t("ag.rc.write"))}</button>`
      : "";
  const keep = `<button type="button" class="den-btn sm" data-act="rot-keep" aria-label="${esc(t("ag.rc.keepName", { id }))}">${esc(t("ag.rc.keep"))}</button>`;
  const never = `<label class="agnever"><input type="checkbox" data-rot-never> ${esc(t("ag.rc.never"))}</label>`;
  const settings = `<a class="lnk" data-rot-settings href="${esc(settingsHref())}">${esc(t("ag.rc.settings"))}</a>`;
  return now + write + keep + never + settings;
}

/** D28: the effective settings and where each comes from, in words. */
function rotFromText(rot) {
  if (!rot?.from) return "";
  return t(
    rot.after === 0
      ? "ag.rc.fromNever"
      : rot.after === 1
        ? "ag.rc.from.one"
        : "ag.rc.from",
    {
      n: rot.after,
      src: rot.from.after_compactions,
      mode: t(`ag.rc.mode.${rot.onDue}`),
      src2: rot.from.on_due,
    },
  );
}

/** D28: the callout under a row: the message, its line of settings, the buttons. */
function rotCalloutHtml(r) {
  const acts = rotActionsHtml(r);
  if (!acts) return "";
  const from = rotFromText(r.rotation);
  return (
    `<span class="agcant" data-rot-msg data-handoff="${esc(r.rotation.handoff)}">${esc(rotMessage(r))}</span>` +
    (from
      ? `<span class="agcant agfrom" data-rot-from>${esc(from)}</span>`
      : "") +
    acts
  );
}

/** D37: "10:13 PM" today, else "Nov 6": short, a <time> (issue 206). */
function whenShort(iso) {
  return timeHtml(iso, { style: isToday(iso) ? "time" : "date" });
}

/** D37: a not-running agent's chip: Stopped, Exited or Interrupted. */
function stoppedChip(r) {
  if (r.state === "interrupted") return t("ag.chip.interrupted");
  if (/^exited\b/.test(r.state)) return t("ag.chip.exited");
  return t("ag.chip.stopped");
}

/** D37: what a stopped row leaves out, for its tooltip. */
function stoppedTip(r) {
  const who = [r.persona, r.agent].filter(Boolean).join(" · ");
  const meta = [r.runtime, cwdText(r)].filter(Boolean).join(" · ");
  const cant = !r.resumable && r.noResume ? noResumeText(r) : "";
  return [who, meta, stopReason(r), cant].filter(Boolean).join("\n");
}

function noResumeText(r) {
  const why = r.noResume;
  if (why === `${r.runtime} can't resume a conversation`)
    return t("ag.noResume", { runtime: r.runtime });
  if (
    why ===
    `${r.runtime} can't resume ${r.agent}: it reported no conversation to resume`
  )
    return t("ag.noResumeNone", { runtime: r.runtime, id: r.agent });
  return why;
}

/**
 * A stopped agent's row (D37): one line. A hollow dot, its name, a chip
 * (Stopped, Exited, Interrupted), when, then Resume and ⋯ (Start fresh,
 * Remove). Its persona, id, runtime and folder are in its tooltip and its
 * pane. No Rename (a running agent's), no helpers (D34: only a running
 * agent's active ones). A runtime that can't resume: Start fresh instead
 * of Resume, and ⋯ has Remove. D28: a due rotation's callout stays.
 */
function stoppedHtml(r, wsTag = false) {
  const open = st.open.includes(r.id);
  const name = displayName(r);
  // Its own name, else its id: short, and unique (the persona is in the
  // tooltip; several stopped agents often share one).
  const label = r.displayName || r.agent || name;
  const who = esc(r.agent);
  const rot = rotationOf(r);
  const callout = rotCalloutHtml(r);
  const at = whenShort(r.stoppedAt ?? r.endedAt ?? "");
  const chip =
    rot === "ready"
      ? t("ag.rot.ready", { why: rotationWhy(r.rotation) })
      : stoppedChip(r);
  const first = r.resumable
    ? `<button type="button" class="den-btn sm primary" data-act="resume" aria-label="${esc(t("ag.resumeName", { id: r.agent }))}">${esc(t("ag.resume"))}</button>`
    : `<button type="button" class="den-btn sm" data-act="fresh" aria-label="${esc(t("ag.freshName", { id: r.agent }))}">${esc(t("ag.fresh"))}</button>`;
  const more = `<button type="button" class="den-btn sm" data-act="row-more" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t("ag.more", { id: r.agent }))}" title="${esc(t("ag.more", { id: r.agent }))}">⋯</button>`;
  return (
    `<div class="agst agst1" data-agent="${who}" data-state="${esc(r.state)}" data-ws="${esc(r.workspace)}"${rot ? ` data-rotation="${rot}"` : ""}>` +
    // D45: a click (or Enter) opens its details, with Resume in them.
    `<button type="button" class="agr" data-id="${esc(r.id)}" data-kind="agent" data-state="${esc(r.state)}"${pcAttr(r.workspace)} data-details=""` +
    ` aria-haspopup="dialog" aria-expanded="${agd.r?.id === r.id}"` +
    ` title="${esc(stoppedTip(r))}"` +
    ` aria-label="${esc(t("ag.det.label", { id: `${r.workspace} / ${name}` }))}">` +
    gripHtml(r) +
    `<span class="den-dot ${stateTone(r)} hollow" aria-hidden="true"></span>` +
    `<span class="nm">${tileHtml(label)}${esc(label)}${wsTag ? ` <span class="id">${esc(r.workspace)}</span>` : ""}</span>` +
    `<span class="stchip" title="${esc(chip)}">${esc(chip)}</span>` +
    (at ? `<span class="when">${at}</span>` : "") +
    `</button>` +
    `<span class="agacts">${first}${more}</span>` +
    (callout ? `<div class="agcallout">${callout}</div>` : "") +
    // Issue 278: deliveries still held after a loop: Clear.
    (compactingHtml(r)
      ? `<div class="agcallout">${compactingHtml(r)}</div>`
      : "") +
    hubWorkHtml(r) +
    `</div>`
  );
}

/**
 * 0.4.45: an exited shell in Stopped: its name, "Exited", and Remove. A
 * click opens its pane, where its last output still reads.
 */
function exitedShellHtml(r, wsTag = false) {
  const label = r.label || r.name;
  return (
    `<div class="agst agst1" data-shell="${esc(r.id)}" data-state="${esc(r.state)}" data-ws="${esc(r.workspace)}">` +
    `<button type="button" class="agr" data-id="${esc(r.id)}" data-kind="session" data-state="${esc(r.state)}"${pcAttr(r.workspace)}` +
    ` aria-label="${esc(t("ag.openName", { id: `${r.workspace} / ${label}` }))}">` +
    `<span class="den-dot ${stateTone(r)} hollow" aria-hidden="true"></span>` +
    `<span class="nm">${tileHtml(label)}${esc(label)}${wsTag ? ` <span class="id">${esc(r.workspace)}</span>` : ""}</span>` +
    `<span class="stchip">${esc(stoppedChip(r))}</span>` +
    `</button>` +
    `<span class="agacts"><button type="button" class="den-btn sm" data-act="remove-shell" aria-label="${esc(t("ag.removeShell", { id: label }))}">${esc(t("ag.remove"))}</button></span>` +
    `</div>`
  );
}

/**
 * 0.4.40: "Working on N Hub comments · <artifact>" (its turn has them), or
 * "N Hub comments wait for it" (stopped, or mid-turn); the artifact links
 * to Hub. Under the row (never inside its button).
 */
export function hubWorkHtml(r, tr = t) {
  const w = r?.kind === "agent" ? r.hubWork : null;
  if (!w || !(w.working > 0 || w.queued > 0)) return "";
  const n = w.working > 0 ? w.working : w.queued;
  const key = w.working > 0 ? "ag.hub.working" : "ag.hub.queued";
  const url =
    typeof w.url === "string" && /^https?:\/\//.test(w.url) ? w.url : "";
  const art = w.artifact
    ? url
      ? ` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(w.artifact)}</a>`
      : ` · ${esc(w.artifact)}`
    : "";
  // Issue 664: why the queued ones wait, when Den knows.
  const why =
    w.working > 0 || w.held !== "not_at_prompt"
      ? ""
      : ` · <span data-held="not_at_prompt">${esc(tr("ag.hub.notAtPrompt"))}</span>`;
  return (
    `<div class="aghub" data-hubwork="${w.working > 0 ? "working" : "queued"}">` +
    `<span class="den-dot ${w.working > 0 ? "ok" : "warn"}" aria-hidden="true"></span> ` +
    `${esc(tr(key, { n }))}${art}${why}</div>`
  );
}

/** Issue 278: "840 KB" (whole KB; under 1 KB: bytes). */
function sizeText(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Issue 278: the agent's instruction files were over the share of its
 * context at its last start: a tag, its tooltip naming the largest file.
 */
export function instructionsTag(r, tr = t) {
  const i = r?.kind === "agent" ? r.instructions : null;
  if (!i) return "";
  const tip = tr("ag.ins.tip", {
    size: sizeText(i.totalBytes),
    share: i.sharePercent,
    path: i.largest?.path ?? "",
    big: sizeText(i.largest?.bytes ?? 0),
  });
  return `<span class="tagx warn" data-instructions title="${esc(tip)}">${esc(tr("ag.ins.tag"))}</span>`;
}

/** Issue 278: "Compacting repeatedly" (a loop now) as a tag. */
export function compactingTag(r, tr = t) {
  const c = r?.kind === "agent" ? r.compacting : null;
  if (!c?.active) return "";
  return `<span class="tagx warn" data-compacting title="${esc(tr("ag.ctx.looping", { n: c.count }))}">${esc(tr("ag.ctx.tag"))}</span>`;
}

/**
 * Issue 278: under the row of an agent stuck compacting: what is
 * happening, the likely cause (its instruction files, when its start's
 * check warned), Stop (the same Stop as its pane's) and, when Den holds its
 * deliveries, Clear. Nothing when there is neither a loop nor a hold.
 */
export function compactingHtml(r, tr = t, { withStop = true } = {}) {
  const c = r?.kind === "agent" ? r.compacting : null;
  if (!c || !(c.active || c.paused)) return "";
  const i = r.instructions;
  const cause = i
    ? tr("ag.ctx.causeFiles", {
        size: sizeText(i.totalBytes),
        share: i.sharePercent,
        path: i.largest?.path ?? "",
        big: sizeText(i.largest?.bytes ?? 0),
      })
    : tr("ag.ctx.causeOther");
  const said = [
    c.active ? tr("ag.ctx.looping", { n: c.count }) : "",
    c.active ? cause : "",
    c.paused ? tr("ag.ctx.held") : "",
  ]
    .filter(Boolean)
    .join(" ");
  const stop =
    withStop && c.active && (r.state === "running" || r.state === "stopping")
      ? `<button type="button" class="den-btn sm" data-act="stop" aria-label="${esc(tr("ag.stopName", { id: r.agent }))}">${esc(tr("ag.stop"))}</button>`
      : "";
  const clear = `<button type="button" class="den-btn sm" data-act="ctx-clear" aria-label="${esc(tr("ag.ctx.clearName", { id: r.agent }))}">${esc(tr(c.paused ? "ag.ctx.clearHeld" : "ag.ctx.clear"))}</button>`;
  return (
    `<span class="agcant" data-compacting-msg>${esc(said)}</span>` +
    stop +
    clear
  );
}

/** NT-3b: what the "waiting" badge says: why, when the server knows. */
function waitingText(r) {
  const k = r.waitingWhy ? `ag.waiting.${r.waitingWhy}` : "";
  const s = k ? t(k) : "";
  return s && s !== k ? s : t("ag.waiting");
}

function seenMap() {
  const out = new Map(st.seenNow);
  if (typeof document !== "undefined" && document.visibilityState !== "hidden")
    for (const id of visibleIds()) {
      const r = rowOf(id);
      if (r?.attn === "done") out.set(id, r.attnSince);
    }
  return out;
}

function markOpened(id) {
  const r = rowOf(id);
  if (!r || r.kind !== "agent") return;
  if (r.attn === "done") st.seenNow.set(id, r.attnSince);
  sayLooking([r.agent]);
}

function sayLooking(agents) {
  // busy-ok: a background ping while the tab is looked at; no button
  if (agents.length)
    void api("POST", "/api/notifications/looking", { agents }).catch(() => {});
}

function allProjects() {
  return viewWorkspaces().length > 1;
}

function attnParts(r, attn) {
  const ago = (iso) =>
    iso && Number.isFinite(Date.parse(iso))
      ? formatTime(iso, { style: "relative" })
      : "";
  if (r.kind !== "agent") return { detail: cwdText(r) };
  if (attn === "needs") {
    const w = needsWhy(r);
    return {
      detail: w && !w.startsWith("ag.whyLong.") ? w : waitingText(r),
      time: r.attnSince ? sinceShort(r.attnSince) : "",
    };
  }
  if (attn === "done")
    return {
      detail: r.attnSince
        ? t("ag.meta.finished", { ago: ago(r.attnSince) })
        : "",
    };
  if (attn === "working")
    return { detail: r.attnSince ? sinceShort(r.attnSince) : "" };
  if (r.attn === "done") return { detail: t("ag.meta.seen") };
  return { detail: r.attnSince ? ago(r.attnSince) : cwdText(r) };
}

function rowHtml(r) {
  if (isStopped(r)) return stoppedHtml(r);
  const open = st.open.includes(r.id);
  const nm =
    r.kind === "agent"
      ? nameHtml(r)
      : `${esc(r.label)} <span class="sbdg">${esc(t("ag.session"))}</span>`;
  const seen = seenMap();
  const attn = rowState(r, seen);
  const right = chipHtml(r, seen);
  const meta = metaHtml({
    runtime: r.runtimeLabel || r.runtime,
    ...attnParts(r, attn),
  });
  const ptag = tagHtml(r, {
    all: allProjects(),
    name: projName,
    pc: (ws) => projectColour(st.projects, ws),
  });
  // D62: the helpers chip is on line 2, before the meta, never in the dot's
  // column (it pushed this row's name right of the others').
  const chip = r.kind === "agent" ? helperBadgeHtml(r) : "";
  const said = r.kind === "agent" ? helperCountSaid(r) : "";
  const rot = rotationOf(r);
  const rotTag = rot
    ? `<span class="tagx warn" data-rotation="${rot}">${esc(
        t(rot === "ready" ? "ag.rot.ready" : "ag.rot.due", {
          why: rotationWhy(r.rotation),
        }),
      )}</span>`
    : "";
  const revokedTag = r.tokenRevoked
    ? `<span class="tagx warn" title="${esc(t("ag.revokedTip"))}">${esc(t("ag.revoked"))}</span>`
    : "";
  const ovTags = r.kind === "agent" ? overrideTagsHtml(r) : "";
  const wTag = whereTag(r);
  const mTag = mcpStaleTag(r, false);
  const modeTag = modeTagHtml(r, false);
  // Issue 144: this agent holds (or waits for) the machine's gate slot.
  const gateText =
    r.kind === "agent" ? (st.gate?.tagFor(`agent:${r.agent}`) ?? "") : "";
  const gateTag = gateText
    ? `<span class="tagx" data-gate-tag>${esc(gateText)}</span>`
    : "";
  // Issue 278: compacting repeatedly; instruction files over the share.
  const ctxTags = compactingTag(r) + instructionsTag(r);
  const tags =
    rotTag ||
    revokedTag ||
    ovTags ||
    wTag ||
    mTag ||
    modeTag ||
    gateTag ||
    ctxTags
      ? `<span class="agtags">${ctxTags}${revokedTag}${mTag}${modeTag}${gateTag}${rotTag}${wTag}${ovTags}</span>`
      : "";
  const button =
    `<button type="button" class="agr" data-id="${esc(r.id)}" data-kind="${esc(r.kind)}" data-state="${esc(r.state)}" data-ws="${esc(r.workspace)}"${pcAttr(r.workspace)}` +
    ` aria-pressed="${open}"${open && r.id === st.cur ? ' aria-current="true"' : ""}${r.attachable ? "" : ' aria-disabled="true"'}` +
    ` data-attn="${attn}"` +
    ` aria-label="${esc(t("ag.openName", { id: `${r.workspace} / ${displayName(r)}` }) + ` · ${t(`ag.chip.${attn}`)}` + (said ? ` · ${said}` : ""))}">` +
    gripHtml(r) +
    markHtml(attn) +
    `<span class="nm">${tileHtml(r.kind === "agent" ? displayName(r) : r.label)}${nm}</span>${right}` +
    (chip
      ? `<span class="agl2">${chip}${meta || ptag ? `<span class="meta" data-meta>${ptag}${meta}</span>` : ""}</span>`
      : meta || ptag
        ? `<span class="meta" data-meta>${ptag}${meta}</span>`
        : "") +
    tags +
    (attn ? `<span class="agchev" data-chev aria-hidden="true">›</span>` : "") +
    `</button>`;
  // D28: a running agent whose rotation is due: its callout, with buttons
  // (before, only a tag: nothing to press).
  // MODE-3: Restart to apply, under a row whose mode differs.
  // Issue 278: compacting repeatedly: why, Stop, and Clear.
  const callout =
    r.kind === "agent"
      ? rotCalloutHtml(r) +
        modeApplyHtml(r) +
        // Issues 750 and 1223: Restart for its tools, on the row too.
        // Issue 1407: once asked, its own answer (and Restart now).
        restartAnswerHtml(r) +
        compactingHtml(r)
      : "";
  // D32: the helpers it started in its own session, under it. #80: only
  // once its badge is opened (closed by default, the agent in front too).
  const hOpen = r.kind === "agent" && st.helpersOpen.has(helperKey(r));
  const helpers =
    r.kind === "agent" ? helperRowsHtml(r, hOpen, st.helpersShown) : "";
  // #80: the badge is a button beside the row's (laid over its place).
  const toggle = r.kind === "agent" ? helperToggleHtml(r, hOpen) : "";
  const row = toggle ? `<div class="agrw">${button}${toggle}</div>` : button;
  const hub = hubWorkHtml(r);
  if (!callout) return row + hub + helpers;
  return (
    `<div class="agst" data-agent="${esc(r.agent)}" data-state="${esc(r.state)}" data-ws="${esc(r.workspace)}"${rot ? ` data-rotation="${rot}"` : ""}>` +
    row +
    `<div class="agacts">${callout}</div>` +
    hub +
    `</div>` +
    helpers
  );
}

/** #80: an agent's key in st.helpersOpen. */
const helperKey = (r) => `${r.workspace}\0${r.agent}`;

/**
 * D44: a running agent whose MCP servers are out of date (Hub connected or
 * disconnected since it launched): a tag, and on the pane bar Restart (at
 * its next idle, same conversation). Issue 749: so does one whose session
 * failed to load a server's tools, with the error in the tag's title.
 */
function mcpStaleTag(r, withButton) {
  const why = toolsStale(r);
  if (!why) return "";
  // Issue 193: Den restarts it to load Hub's new tools (no button: under way).
  if (why === "restarting")
    return `<span class="tagx warn" data-tools-restarting="1" title="${esc(t("ag.mcp.reloadingTip"))}">${esc(t("ag.mcp.reloading"))}</span>`;
  let tag;
  if (why === "failed") {
    // Issue 749: its session didn't get a server's tools (the error says why).
    const fx = r.mcpFailed[0];
    const tip = t("ag.mcp.failedTip", { error: String(fx?.error ?? "") });
    tag = `<span class="tagx warn" data-mcp-failed="${esc(String(fx?.server ?? ""))}" title="${esc(tip)}">${esc(t("ag.mcp.failed"))}</span>`;
  } else if (why === "den") {
    // Issue 1223: its Den tools are an older Den's (Den updated since).
    const v = {
      from: String(r.mcpStale.den.from),
      to: String(r.mcpStale.den.to),
    };
    tag = `<span class="tagx warn" data-mcp-stale="den" title="${esc(t("ag.mcp.denTip", v))}">${esc(t("ag.mcp.den", v))}</span>`;
  } else {
    tag = `<span class="tagx warn" data-mcp-stale="${why}" title="${esc(t(`ag.mcp.${why}Tip`))}">${esc(t(`ag.mcp.${why}`))}</span>`;
  }
  if (!withButton) return tag;
  return `<span class="agstale">${tag}${toolsRestartButton(r, t)}</span>`;
}

/**
 * MODE-3 (0.4.48): a running agent's mode differs from the one its
 * process runs in (a mode chosen while it ran; MODE-2 restarts it after
 * its turn, unless that waits on something): { want, running }, else null.
 */
export function modeDriftOf(r) {
  if (r?.kind !== "agent" || isStopped(r) || !r.mode || !r.modeRunning)
    return null;
  return r.mode === r.modeRunning
    ? null
    : { want: r.mode, running: r.modeRunning };
}

const modeName = (m) => t(`pm.name.${m}`);

/**
 * MODE-3: its mode on its row and its pane bar ("mode: Auto"); on a
 * mismatch, "Set to Auto, running Ask", and in the pane bar Restart to
 * apply beside it (the row has it under the row: modeApplyHtml).
 */
export function modeTagHtml(r, withButton) {
  if (r?.kind !== "agent" || isStopped(r) || !r.mode) return "";
  const d = modeDriftOf(r);
  // Issue 199: a mode of its own says so, and the project's it doesn't follow.
  // Issue 225: every mode says where it comes from.
  const own = ownModeLabel(r);
  const src = r.modeSource ? ` data-mode-source="${esc(r.modeSource)}"` : "";
  if (!d)
    return `<span class="tagx${r.mode === "all" || own ? " warn" : ""}" data-mode="${esc(r.mode)}"${src}${own ? ' data-mode-own="1"' : ""}>${esc(modeLabel(r))}</span>`;
  const tag = `<span class="tagx warn" data-mode-drift="${esc(d.want)}">${esc(t("ag.mode.drift", { want: modeName(d.want), running: modeName(d.running) }))}</span>`;
  return withButton
    ? `<span class="agmode">${tag}${modeApplyHtml(r)}</span>`
    : tag;
}

/** MODE-3: Restart to apply, a person's one click (a mismatch only). */
function modeApplyHtml(r) {
  if (!modeDriftOf(r)) return "";
  return `<button type="button" class="den-btn sm primary" data-act="mode-apply" aria-label="${esc(t("ag.mode.applyName", { id: r.agent }))}">${esc(t("ag.mode.apply"))}</button>`;
}

/**
 * Issue 1407: agent `r`'s answer under its row, once a restart for its
 * tools was asked (now, turn, job with what and how long, unknown, with
 * Restart now for the last two); else its Restart. Gone once its tools
 * are current.
 */
function restartAnswerHtml(r) {
  const k = restartKey(r.workspace, r.agent);
  const a = st.restarts.get(k);
  const why = toolsStale(r);
  if (a && (!why || why === "restarting") && a.state !== "failed") {
    st.restarts.delete(k);
    return toolsRestartHtml(r, t);
  }
  return a ? restartRowHtml(a, t) : toolsRestartHtml(r, t);
}

const groupOf = (r) =>
  inStopped(r)
    ? orderGroup(st.data?.sessions ?? [], r, inStopped)
    : bandGroup(
        (st.data?.sessions ?? []).filter((s) => !inStopped(s)),
        r,
        { seenNow: seenMap() },
      );

/** The grip a pointer drags a row by (any pointer: mouse, pen, touch). */
const gripHtml = (r) =>
  orderable(r, SERVER_WS) && (inStopped(r) || groupOf(r).length > 0)
    ? `<span class="agrip" data-grip="" role="img" aria-label="${esc(t("ag.ord.gripOne", { id: displayName(r) }))}" title="${esc(t("ag.ord.grip"))}">⠿</span>`
    : "";

/** D56: where an agent runs, saying so when that is outside its project. */
function cwdText(r) {
  return r.outside && r.cwd ? t("ag.outside", { folder: r.cwd }) : r.cwd;
}

export {
  allProjects,
  attnParts,
  cwdText,
  displayName,
  exitedShellHtml,
  gripHtml,
  groupOf,
  helperKey,
  hubBoundTag,
  isToday,
  linkTag,
  markOpened,
  mcpStaleTag,
  modeApplyHtml,
  modeName,
  nameHtml,
  paneName,
  pcAttr,
  projName,
  restartAnswerHtml,
  rotActionsHtml,
  rotCalloutHtml,
  rotFromText,
  rotMessage,
  rotationOf,
  rotationWhy,
  rowHtml,
  sayLooking,
  seenMap,
  sessionExtra,
  settingsHref,
  signInTag,
  sizeText,
  stateText,
  stateTone,
  stoppedChip,
  stoppedHtml,
  stoppedTip,
  subagentTag,
  tileHtml,
  waitingText,
  when,
  whenShort,
  whereTag,
  wsHref,
  wsLinkHtml,
};
