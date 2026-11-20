/**
 * Issue 482: the Terminals list's rules (model A, as mocked and approved).
 * Terminals have their own page (/terminals, the rail's Terminals); the
 * Agents list holds agents only. No DOM here, so the rules run without a
 * browser (tests/unit/server/terminals-482.test.ts). The page's words
 * never say "shell".
 */
import { shellUsedAt } from "./shell-pick.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"]/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

/**
 * Whether row `r` is listed on page `page` ("terminal": the Terminals
 * page, else the Agents page): a plain shell on Terminals only, an agent
 * (the server agent too) on Agents only.
 */
export function belongsOn(page, r) {
  if (!r) return false;
  return page === "terminal" ? r.kind === "session" : r.kind !== "session";
}

/** Running first, then exited; each by last used, newest first. */
export function terminalGroups(rows, used = {}) {
  const shells = (rows ?? []).filter((r) => r?.kind === "session");
  const byUse = (a, b) => shellUsedAt(b, used) - shellUsedAt(a, used);
  return {
    running: shells.filter((r) => !r.exited).sort(byUse),
    exited: shells.filter((r) => r.exited).sort(byUse),
  };
}

/** A terminal's name: its folder's last part, else its project. */
export function terminalName(r) {
  const dir = String(r?.folder ?? r?.cwd ?? "").replace(/\/+$/, "");
  const last = dir.split("/").pop();
  return last && last !== "~" ? last : r?.workspace || "";
}

/** The dot's tone: running is the good one, a failed exit is bad. */
function tone(r) {
  if (!r.exited) return r.state === "stopping" ? "pending" : "";
  return /^exited \((?!0\))/.test(r.state ?? "") ? "bad" : "off";
}

/**
 * One row: a single button over the whole row opens the terminal; an
 * exited one is dimmed, with Restart and Remove beside it (never inside
 * it, so they don't open it). A running one has no Remove (Stop first).
 * `o`: { t, when(iso) → HTML, showProject, open, current, used }.
 */
export function terminalRowHtml(r, o) {
  const t = o.t;
  const name = terminalName(r);
  const exited = r.exited === true;
  const state = exited ? t("ag.state.exited") : t("ag.state.running");
  const usedAt = shellUsedAt(r, o.used ?? {});
  const when = usedAt ? o.when(new Date(usedAt).toISOString()) : "";
  const where = r.folder || r.cwd || "";
  const meta =
    (o.showProject
      ? `<span class="proj">${esc(r.workspace)}</span>${where ? " · " : ""}`
      : "") + (where ? `<span class="mono">${esc(where)}</span>` : "");
  const cur = o.open && o.current;
  const button =
    `<button type="button" class="agr" data-id="${esc(r.id)}" data-kind="session" data-state="${esc(r.state)}"` +
    ` aria-pressed="${o.open === true}"${cur ? ' aria-current="true"' : ""}` +
    ` aria-label="${esc(t("ag.openName", { id: `${r.workspace} / ${name}` }))}">` +
    `<span class="den-dot ${tone(r)}${exited ? " hollow" : ""}" aria-hidden="true"></span>` +
    `<span class="nm">${esc(name)}</span><span class="st">${esc(state)}</span>` +
    (meta ? `<span class="meta">${meta}</span>` : "") +
    (when
      ? `<span class="meta when">${t("tm.lastUsed", { when })}</span>`
      : "") +
    `</button>`;
  const acts = exited
    ? `<span class="agacts">` +
      `<button type="button" class="den-btn sm" data-act="restart-shell" aria-label="${esc(t("tm.restartName", { id: name }))}">${esc(t("tm.restart"))}</button>` +
      `<button type="button" class="den-btn sm" data-act="remove-shell" aria-label="${esc(t("ag.removeShell", { id: name }))}">${esc(t("ag.remove"))}</button>` +
      `</span>`
    : "";
  return (
    `<div class="agst tmrow${exited ? " exited" : ""}" data-shell="${esc(r.id)}" data-state="${esc(r.state)}" data-ws="${esc(r.workspace)}">` +
    button +
    acts +
    `</div>`
  );
}

/** "3 terminals · All projects": the Terminals page's count. */
export function terminalsCountText(n, scope, t) {
  const c = t(n === 1 ? "tm.count1" : "tm.count", { n });
  return scope ? `${c} · ${scope}` : c;
}

/**
 * The projects New terminal offers under All projects: the one a
 * terminal was used in last first (preselected), then the others in
 * their own order.
 */
export function newTerminalChoices(workspaces, rows, used = {}) {
  const last = new Map();
  for (const r of rows ?? [])
    if (r?.kind === "session" && workspaces.includes(r.workspace))
      last.set(
        r.workspace,
        Math.max(last.get(r.workspace) ?? 0, shellUsedAt(r, used)),
      );
  const first = [...last.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return first
    ? [first, ...workspaces.filter((w) => w !== first)]
    : [...workspaces];
}

/**
 * The rail's Terminals under All projects with none running: the project
 * a terminal was used in last (running or not), else the first one.
 */
export function lastUsedProject(rows, used, workspaces) {
  return newTerminalChoices(workspaces, rows, used)[0] ?? null;
}

/**
 * The one-time note on Agents after the release: where the terminals
 * went. Empty when there are none in view.
 */
export function movedNoteHtml(n, t) {
  if (!n) return "";
  return (
    `<div class="agnote" data-note="moved" role="status">` +
    esc(t(n === 1 ? "tm.moved1" : "tm.moved", { n })) +
    ` · <button type="button" class="lnk" data-act="open-terminals">${esc(t("tm.openList"))}</button>` +
    ` · <button type="button" class="lnk" data-act="dismiss-moved">${esc(t("tm.dismiss"))}</button></div>`
  );
}
