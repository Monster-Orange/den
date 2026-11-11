/**
 * D32: the helpers an agent starts in its own session (Claude Code's Agent
 * and Workflow subagents), read-only. Den shows them; they belong to the
 * agent's session, so nothing here stops or steers one (and the views say
 * so).
 *
 *   helperRowsHtml(row): under an agent's row on the Agents page, its
 *     recent helpers (the row's `helpers.recent`: running, or ended a short
 *     while ago) and "All helpers (n)".
 *   openHelpers({ ws, agent, name, opener }): every helper, this
 *     conversation's first and earlier ones folded under "Earlier (n)";
 *     each opens its transcript (transcript-view.js).
 *   openHelperTranscript({ ws, agent, helper, opener }).
 */
import { openTranscript } from "/transcript-view.js";

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const api = (method, url) => window.denShell.api(method, url);
const base = (ws, agent) =>
  `/api/workspaces/${encodeURIComponent(ws)}/agents/${encodeURIComponent(agent)}/helpers`;

/** A dot's tone for a helper's status (the shell's .den-dot tones). */
export function helperTone(status) {
  return status === "running"
    ? "ok"
    : status === "failed"
      ? "bad"
      : status === "idle" || status === "stopped"
        ? "warn"
        : "off";
}

/** 65 s → "1m 5s". */
export function dur(ms) {
  if (typeof ms !== "number" || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const label = (h) => h.description || h.workflow?.label || h.id;

/** One helper as a button row (opens its transcript). */
export function helperHtml(h, { ws, agent }) {
  const meta = [
    h.workflow
      ? t("hp.workflow", { name: h.workflow.name || h.workflow.runId })
      : h.type,
    h.model,
    h.branch,
  ]
    .filter(Boolean)
    .join(" · ");
  const st = t(`hp.st.${h.status}`);
  const when = [
    h.durationMs !== undefined ? dur(h.durationMs) : "",
    h.lastTool && h.status === "running" ? h.lastTool : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    `<button type="button" class="agh" data-helper="${esc(h.id)}" data-agent="${esc(agent)}" data-ws="${esc(ws)}" data-status="${esc(h.status)}"` +
    ` style="--hp-depth:${Math.max(0, (h.depth || 1) - 1)}"` +
    ` aria-label="${esc(t("hp.open", { what: label(h), status: st }))}" title="${esc(h.statusFrom ? `${st}: ${h.statusFrom}` : st)}">` +
    `<span class="den-dot ${helperTone(h.status)}" aria-hidden="true"></span>` +
    `<span class="agh-n">${esc(label(h))}</span>` +
    `<span class="agh-s">${esc(st)}${when ? ` · ${esc(when)}` : ""}</span>` +
    (meta ? `<span class="agh-m mono">${esc(meta)}</span>` : "") +
    `</button>`
  );
}

/** Under an agent's row: its recent helpers and "All helpers (n)". */
export function helperRowsHtml(r) {
  const h = r?.helpers;
  if (!h || !h.total) return "";
  const ctx = { ws: r.workspace, agent: r.agent };
  return (
    `<div class="aghs" data-helpers-of="${esc(r.agent)}" data-ws="${esc(r.workspace)}" role="group" aria-label="${esc(t("hp.groupOf", { name: r.displayName || r.agent }))}">` +
    (h.recent || []).map((x) => helperHtml(x, ctx)).join("") +
    `<button type="button" class="lnk aghs-all">` +
    esc(t("hp.all", { n: h.total })) +
    (h.running
      ? ` <span class="hpbdg" aria-label="${esc(t("hp.runningN", { n: h.running }))}">${esc(h.running)}</span>`
      : "") +
    `</button></div>`
  );
}

/** "Helpers (n)" for a pane's bar: a count badge while any run. */
export function helperBarButtonHtml(r) {
  const h = r?.helpers;
  if (!h || !h.total) return "";
  return (
    `<button type="button" class="den-btn sm" data-act="helpers" aria-haspopup="dialog"` +
    ` aria-label="${esc(t(h.running ? "hp.barRunning" : "hp.bar", { n: h.total, r: h.running }))}">` +
    esc(t("hp.title", { n: h.total })) +
    (h.running
      ? ` <span class="hpbdg" aria-hidden="true">${esc(h.running)}</span>`
      : "") +
    `</button>`
  );
}

const CSS = `
.hp-dlg{font-family:var(--sans);width:min(760px,calc(100vw - 32px));max-height:calc(100vh - 48px);padding:0;border:1px solid var(--border-strong);border-radius:10px;background:var(--raised, var(--surface));color:var(--text);box-shadow:var(--shadow)}
.hp-dlg::backdrop{background:rgba(0,0,0,.35)}
.hp-hd{display:flex;gap:8px;align-items:baseline;padding:12px 16px;border-bottom:1px solid var(--border)}
.hp-hd h2{font-size:15px;margin:0;outline:none;min-width:0;overflow-wrap:anywhere}
.hp-hd .x{margin-left:auto;flex:none}
.hp-body{padding:8px 12px;overflow:auto;max-height:calc(100vh - 200px)}
.hp-note{margin:0;padding:8px 16px 12px;color:var(--muted);font-size:12px;border-top:1px solid var(--border)}
.hp-none{color:var(--muted);font-size:13px;padding:8px 4px}
.hp-earlier{margin-top:8px}
.hp-earlier summary{cursor:pointer;color:var(--muted);font-size:13px;padding:4px}
.aghs{display:flex;flex-direction:column;gap:2px;margin:2px 0 6px 18px;padding-left:8px;border-left:2px solid var(--border)}
.agh{all:unset;box-sizing:border-box;display:grid;grid-template-columns:auto 1fr auto;gap:2px 8px;align-items:center;width:100%;padding:4px 6px 4px calc(6px + var(--hp-depth,0) * 14px);border-radius:var(--radius-button,6px);cursor:pointer;font-size:12px;color:var(--text)}
.agh:hover{background:var(--sunken)}
.agh:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.agh-n{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agh-s{color:var(--muted);white-space:nowrap}
.agh-m{grid-column:2 / 4;color:var(--faint);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agh[data-status="running"] .agh-s{color:var(--text)}
.aghs-all{align-self:flex-start;font-size:12px;margin:2px 6px}
.hpbdg{display:inline-block;min-width:16px;padding:0 5px;border-radius:8px;background:var(--accent);color:var(--accent-text);font-size:11px;line-height:16px;text-align:center}
`;

let dlg = null;
let opener = null;

function ensureCss() {
  if (document.getElementById("hp-css")) return;
  const s = document.createElement("style");
  s.id = "hp-css";
  s.textContent = CSS;
  document.head.append(s);
}

function dialog() {
  ensureCss();
  if (dlg && dlg.isConnected) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "hp-dlg";
  dlg.id = "hp-dlg";
  dlg.setAttribute("aria-labelledby", "hp-h");
  dlg.innerHTML =
    `<div class="hp-hd"><h2 id="hp-h" tabindex="-1"></h2>` +
    `<button type="button" class="den-btn sm x" data-hp-close></button></div>` +
    `<div class="hp-body" id="hp-body" aria-live="polite"></div>` +
    `<p class="hp-note" id="hp-note"></p>`;
  dlg.querySelector("[data-hp-close]").addEventListener("click", () => {
    if (dlg.open && typeof dlg.close === "function") dlg.close();
    else dlg.removeAttribute("open");
  });
  dlg.addEventListener("close", () => {
    const o = opener;
    opener = null;
    if (o?.isConnected) o.focus?.();
  });
  // A helper opens its transcript over this list.
  dlg.addEventListener("click", (e) => {
    const b = e.target.closest("button.agh");
    if (b)
      void openHelperTranscript({
        ws: b.dataset.ws,
        agent: b.dataset.agent,
        helper: b.dataset.helper,
        opener: b,
      });
  });
  document.body.append(dlg);
  return dlg;
}

/** Every helper of agent `agent` (see the file's comment). */
export async function openHelpers({ ws, agent, name, opener: from = null }) {
  const d = dialog();
  opener = from ?? document.activeElement;
  d.querySelector("#hp-h").textContent = t("hp.dlg", { name: name || agent });
  d.querySelector("[data-hp-close]").textContent = t("tx.close");
  d.querySelector("#hp-note").textContent = t("hp.note");
  const body = d.querySelector("#hp-body");
  body.setAttribute("aria-busy", "true");
  body.innerHTML = `<p class="hp-none">${esc(t("tx.loading"))}</p>`;
  if (!d.open) {
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  }
  d.querySelector("#hp-h").focus();
  try {
    const r = await api("GET", base(ws, agent));
    const all = Array.isArray(r?.helpers) ? r.helpers : [];
    const now = all.filter((h) => !h.earlier);
    const before = all.filter((h) => h.earlier);
    const ctx = { ws, agent };
    body.innerHTML =
      (r?.supported === false
        ? `<p class="hp-none">${esc(t("hp.unsupported"))}</p>`
        : now.length
          ? now.map((h) => helperHtml(h, ctx)).join("")
          : `<p class="hp-none">${esc(t("hp.none"))}</p>`) +
      (before.length
        ? `<details class="hp-earlier"><summary>${esc(t("hp.earlier", { n: before.length }))}</summary>` +
          before.map((h) => helperHtml(h, ctx)).join("") +
          `</details>`
        : "");
  } catch (e) {
    body.innerHTML = `<p class="hp-none" role="alert">${esc(t("tx.failed", { err: e?.message || String(e) }))}</p>`;
  } finally {
    body.removeAttribute("aria-busy");
  }
}

/** One helper's transcript, in the shared transcript view. */
export function openHelperTranscript({ ws, agent, helper, opener: from }) {
  let head = null;
  return openTranscript({
    title: t("tx.loading"),
    note: t("hp.note"),
    opener: from,
    load: async () => {
      const r = await api(
        "GET",
        `${base(ws, agent)}/${encodeURIComponent(helper)}`,
      );
      head = r?.helper;
      const h2 = document.getElementById("tx-h");
      const sub = document.getElementById("tx-sub");
      if (h2 && head) h2.textContent = label(head);
      if (sub && head)
        sub.textContent = [
          t(`hp.st.${head.status}`),
          head.workflow
            ? t("hp.workflow", {
                name: head.workflow.name || head.workflow.runId,
              })
            : head.type,
          head.model,
          head.branch,
          head.durationMs !== undefined ? dur(head.durationMs) : "",
        ]
          .filter(Boolean)
          .join(" · ");
      return { items: r?.items ?? [], omitted: r?.omitted ?? 0 };
    },
  });
}

/** Wire helper rows and "All helpers" inside `root` (a list's container). */
export function wireHelperRows(root, nameOf = (a) => a) {
  ensureCss();
  root.addEventListener("click", (e) => {
    const row = e.target.closest("button.agh");
    if (row && root.contains(row)) {
      e.stopPropagation();
      void openHelperTranscript({
        ws: row.dataset.ws,
        agent: row.dataset.agent,
        helper: row.dataset.helper,
        opener: row,
      });
      return;
    }
    const all = e.target.closest(".aghs-all");
    if (all && root.contains(all)) {
      e.stopPropagation();
      const g = all.closest(".aghs");
      void openHelpers({
        ws: g.dataset.ws,
        agent: g.dataset.helpersOf,
        name: nameOf(g.dataset.helpersOf, g.dataset.ws),
        opener: all,
      });
    }
  });
}
