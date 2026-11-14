/**
 * D32: the helpers an agent starts in its own session (Claude Code's Agent
 * and Workflow subagents), read-only. Den shows them; they belong to the
 * agent's session, so nothing here stops or steers one (and the views say
 * so).
 *
 *   helperRowsHtml(row, selected): under the selected agent's row (its
 *     pane in front) only, its active helpers (running or idle, nested,
 *     running first; at most agents.helpers.row_max) and, when it has
 *     more, "All helpers (n)" (D34). Done ones never list there: the
 *     Helpers list has them, with Clear done.
 *   openHelpers({ ws, agent, name, opener }): every helper, this
 *     conversation's first and earlier ones folded under "Earlier (n)";
 *     each opens its transcript (transcript-view.js).
 *   openHelperTranscript({ ws, agent, helper, opener }).
 */
import { focusBack, openTranscript, refindKey } from "/transcript-view.js";
import { dismissable } from "/popover.js";

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
const agentUrl = (ws, agent) =>
  `/api/workspaces/${encodeURIComponent(ws)}/agents/${encodeURIComponent(agent)}`;
const base = (ws, agent) => `${agentUrl(ws, agent)}/helpers`;

/** D34: what the page does once a person cleared (set by wireHelperRows). */
let onClearedHook = null;

/** D34 Clear done (the Helpers list): hide `agent`'s finished helpers. */
export async function clearHelpers(ws, agent) {
  await window.denShell.api("POST", `${agentUrl(ws, agent)}/clear-helpers`, {});
  await onClearedHook?.(agent, ws);
}

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
/**
 * How far each helper of `list` (in sortHelpers' order) is indented: one
 * step under a parent shown just above it, none when its parent isn't in
 * the list (folded away, or another conversation's).
 */
export function shownDepths(list) {
  const at = new Map();
  for (const h of list || [])
    at.set(h.id, h.parentId && at.has(h.parentId) ? at.get(h.parentId) + 1 : 0);
  return at;
}

/** A list of helpers as rows, each indented under a parent it shows. */
export function helperListHtml(list, ctx) {
  const d = shownDepths(list);
  return (list || [])
    .map((h) => helperHtml(h, { ...ctx, depth: d.get(h.id) ?? 0 }))
    .join("");
}

export function helperHtml(h, { ws, agent, depth }) {
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
    ` style="--hp-depth:${Math.max(0, Math.min(8, depth ?? (h.depth || 1) - 1))}"` +
    ` aria-label="${esc(t("hp.open", { what: label(h), status: st }))}" title="${esc(h.statusFrom ? `${st}: ${h.statusFrom}` : st)}">` +
    `<span class="den-dot ${helperTone(h.status)}" aria-hidden="true"></span>` +
    `<span class="agh-n">${esc(label(h))}</span>` +
    // D62: the title has line 1 to itself; status, time, tool, model: 2.
    `<span class="agh-l2"><span class="agh-s">${esc(st)}${when ? ` · ${esc(when)}` : ""}</span>` +
    (meta ? `<span class="agh-m mono">${esc(meta)}</span>` : "") +
    `</span>` +
    `</button>`
  );
}

/** #80: the id of an agent's open helpers group (the badge controls it). */
export const helpersGroupId = (r) =>
  `aghs-${String(r?.workspace ?? "")}-${String(r?.agent ?? "")}`.replace(
    /[^\w-]/g,
    "_",
  );

/**
 * #80 (0.4.45): under an agent whose badge is open, its first `max`
 * running helpers in start order, oldest first, so the rows shown never
 * move when another starts; then "Show all (M)" when more run. Nothing
 * when the badge is closed (the default) or none runs.
 */
export function helperRowsHtml(r, open = false, max = 3) {
  const h = r?.helpers;
  if (!open || !h || !h.running) return "";
  const name = r.displayName || r.agent;
  const ctx = { ws: r.workspace, agent: r.agent };
  const shown = (Array.isArray(h.active) ? h.active : [])
    .filter((x) => x.status === "running")
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .slice(0, Math.max(1, max));
  return (
    `<div class="aghs" id="${esc(helpersGroupId(r))}" data-helpers-of="${esc(r.agent)}" data-ws="${esc(r.workspace)}" role="group" aria-label="${esc(t("hp.groupOf", { name }))}">` +
    // Flat: a helper's own helper may be cut off by the count.
    shown.map((x) => helperHtml(x, { ...ctx, depth: 0 })).join("") +
    (h.running > shown.length
      ? `<button type="button" class="lnk aghs-all" aria-haspopup="dialog">${esc(t("hp.showAll", { n: h.running }))}</button>`
      : "") +
    `</div>`
  );
}

/**
 * D48: one label, never two bare numbers. While any helper runs it says how
 * many run, after a pulsing dot ("Helpers · 2 running"); when none does, how
 * many there are ("Helpers (5)"). `key` is hp.title.
 */
function countLabel(key, total, running) {
  return running
    ? `${esc(t(`${key}Plain`))} · <span class="hp-run"><span class="hp-dot" aria-hidden="true"></span>${esc(t("hp.runningN", { n: running }))}</span>`
    : esc(t(key, { n: total }));
}

/**
 * D62: the row's count of helpers running now (any row), on its second
 * line ("2 helpers"). #80: inside the row's button it only holds the
 * place (unseen, unspoken: the row's label carries the count); the badge
 * itself is helperToggleHtml's button, laid over it.
 */
export function helperBadgeHtml(r) {
  const n = r?.helpers?.running;
  if (!n) return "";
  return `<span class="agr-hp agr-hp-ph hp-run" aria-hidden="true"><span class="hp-dot"></span>${esc(t("hp.chip", { n }))}</span>`;
}

/**
 * #80 (0.4.45): the badge as a toggle: it opens or closes the agent's
 * helpers under its row (helperRowsHtml). A button of its own, beside the
 * row's (a button can't hold one), laid over the row's placeholder.
 */
export function helperToggleHtml(r, open = false) {
  const n = r?.helpers?.running;
  if (!n) return "";
  return (
    `<button type="button" class="agr-hp agr-hpb hp-run" data-act="helpers-toggle" data-agent="${esc(r.agent)}" data-ws="${esc(r.workspace)}"` +
    ` aria-expanded="${open}"${open ? ` aria-controls="${esc(helpersGroupId(r))}"` : ""}>` +
    `<span class="hp-dot" aria-hidden="true"></span>${esc(t("hp.chip", { n }))}</button>`
  );
}

/** D62: "2 helpers running", for the row's label; "" when none run. */
export function helperCountSaid(r) {
  const n = r?.helpers?.running;
  return n ? t("hp.rowRunning", { n }) : "";
}

/** The pane bar's Helpers button: "Helpers · 2 running", or "Helpers (5)". */
export function helperBarButtonHtml(r) {
  const h = r?.helpers;
  if (!h || !h.total) return "";
  return (
    `<button type="button" class="den-btn sm" data-act="helpers" aria-haspopup="dialog"` +
    ` aria-label="${esc(t(h.running ? "hp.barRunning" : "hp.bar", { n: h.total, r: h.running }))}">` +
    countLabel("hp.title", h.total, h.running) +
    `</button>`
  );
}

const CSS = `
.hp-dlg{font-family:var(--sans);width:min(760px,calc(100vw - 32px));max-height:calc(100vh - 48px);padding:0;border:1px solid var(--border-strong);border-radius:10px;background:var(--raised, var(--surface));color:var(--text);box-shadow:var(--shadow)}
.hp-dlg::backdrop{background:rgba(0,0,0,.35)}
.hp-hd{display:flex;gap:8px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)}
.hp-hd h2{font-size:15px;margin:0;outline:none;min-width:0;flex:1 1 auto;overflow-wrap:anywhere}
.hp-acts{display:flex;gap:8px;align-items:center;flex:none;margin-inline-start:auto}
.hp-body{padding:8px 12px;overflow:auto;max-height:calc(100vh - 200px)}
.hp-note{margin:0;padding:8px 16px 12px;color:var(--muted);font-size:12px;border-top:1px solid var(--border)}
.hp-none{color:var(--muted);font-size:13px;padding:8px 4px}
.hp-earlier{margin-top:8px}
.hp-earlier summary{cursor:pointer;color:var(--muted);font-size:13px;padding:4px}
.aghs{display:flex;flex-direction:column;gap:2px;margin:2px 0 6px 18px;padding-left:8px;border-left:2px solid var(--border)}
.agh{all:unset;box-sizing:border-box;display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px;align-items:center;width:100%;padding:4px 6px 4px calc(6px + var(--hp-depth,0) * 14px);border-radius:var(--radius-button,6px);cursor:pointer;font-size:12px;color:var(--text)}
.agh:hover{background:var(--sunken)}
.agh:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.agh-n{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agh-l2{grid-column:2;display:flex;align-items:baseline;gap:8px;min-width:0}
.agh-s{color:var(--muted);white-space:nowrap;flex:none}
.agh-m{color:var(--faint);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agh[data-status="running"] .agh-s{color:var(--text)}
.aghs-all{align-self:flex-start;font-size:12px;margin:2px 6px}
.hp-cleared{margin-top:8px}
.hp-cleared summary{cursor:pointer;color:var(--muted);font-size:13px;padding:4px}
.hp-run{white-space:nowrap}
.agr-hp{flex:none;display:inline-flex;align-items:center;padding:0 6px;border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:11px;line-height:16px;font-weight:400;cursor:pointer}
.agr-hp:hover{color:var(--text);border-color:var(--border-strong)}
.agr-hp-ph{visibility:hidden}
.agrw{position:relative}
.agrw>.agr-hpb{position:absolute;margin:0;font:inherit;font-size:11px;line-height:16px;background:var(--surface);min-height:0;z-index:1}
.agrw>.agr-hpb[aria-expanded="true"]{color:var(--text);border-color:var(--border-strong)}
.agrw>.agr-hpb:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.agrw>.agr-hpb::after{content:"";position:absolute;inset:-6px -4px}
.hp-dot{display:inline-block;width:6px;height:6px;margin-right:4px;border-radius:50%;background:var(--ok);vertical-align:1px;animation:hp-pulse 1.6s ease-in-out infinite}
@keyframes hp-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion: reduce){.hp-dot{animation:none}}
`;

let dlg = null;
/** D50: a press on its backdrop closes it (popover.js); Esc is native. */
let release = null;
let opener = null;
let openerKey = "";

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
    // D50: Clear done and Close at the end, in the top-right corner.
    `<span class="hp-acts"><button type="button" class="den-btn sm hp-clear" data-hp-clear hidden></button>` +
    `<button type="button" class="den-btn sm x" data-hp-close></button></span></div>` +
    `<div class="hp-body" id="hp-body" aria-live="polite"></div>` +
    `<p class="hp-note" id="hp-note"></p>`;
  dlg.querySelector("[data-hp-close]").addEventListener("click", () => {
    if (dlg.open && typeof dlg.close === "function") dlg.close();
    else dlg.removeAttribute("open");
  });
  // D34: Clear done, from the list: cleared, then the list again.
  dlg.querySelector("[data-hp-clear]").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    const at = dlg.dataset;
    b.disabled = true;
    try {
      await clearHelpers(at.ws, at.agent);
    } catch (err) {
      const body = dlg.querySelector("#hp-body");
      body.insertAdjacentHTML(
        "afterbegin",
        `<p class="hp-none" role="alert">${esc(t("hp.clearFailed", { err: err?.message || String(err) }))}</p>`,
      );
      b.disabled = false;
      return;
    }
    b.disabled = false;
    await loadHelpers(at.ws, at.agent);
    dlg.querySelector("#hp-h").focus();
  });
  dlg.addEventListener("close", () => {
    release?.();
    release = null;
    const o = opener;
    const k = openerKey;
    opener = null;
    openerKey = "";
    // The Agents page's poll may have replaced it meanwhile: find it again.
    focusBack(o, k);
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
  openerKey = refindKey(opener);
  d.dataset.ws = ws;
  d.dataset.agent = agent;
  d.querySelector("#hp-h").textContent = t("hp.dlg", { name: name || agent });
  d.querySelector("[data-hp-close]").textContent = t("tx.close");
  const clear = d.querySelector("[data-hp-clear]");
  clear.textContent = t("hp.clear");
  clear.title = t("hp.clearTip", { name: name || agent });
  clear.hidden = true;
  d.querySelector("#hp-note").textContent = t("hp.note");
  const body = d.querySelector("#hp-body");
  body.innerHTML = `<p class="hp-none">${esc(t("tx.loading"))}</p>`;
  if (!d.open) {
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  }
  release ??= dismissable(d, {
    close: () => {
      if (d.open && typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    },
  });
  d.querySelector("#hp-h").focus();
  await loadHelpers(ws, agent);
}

const ENDED = new Set(["done", "failed", "stopped"]);

/** The list's body: this conversation's, earlier ones', cleared ones'. */
async function loadHelpers(ws, agent) {
  const d = dialog();
  const body = d.querySelector("#hp-body");
  const clear = d.querySelector("[data-hp-clear]");
  body.setAttribute("aria-busy", "true");
  try {
    const r = await api("GET", `${base(ws, agent)}?all=1`);
    const all = Array.isArray(r?.helpers) ? r.helpers : [];
    const cleared = Array.isArray(r?.cleared) ? r.cleared : [];
    const now = all.filter((h) => !h.earlier);
    const before = all.filter((h) => h.earlier);
    const ctx = { ws, agent };
    clear.hidden = !all.some((h) => ENDED.has(h.status));
    body.innerHTML =
      (r?.supported === false
        ? `<p class="hp-none">${esc(t("hp.unsupported"))}</p>`
        : now.length
          ? helperListHtml(now, ctx)
          : `<p class="hp-none">${esc(t(cleared.length && !before.length ? "hp.allCleared" : "hp.none"))}</p>`) +
      (before.length
        ? `<details class="hp-earlier"><summary>${esc(t("hp.earlier", { n: before.length }))}</summary>` +
          helperListHtml(before, ctx) +
          `</details>`
        : "") +
      (cleared.length
        ? `<details class="hp-cleared"><summary>${esc(t("hp.cleared", { n: cleared.length }))}</summary>` +
          helperListHtml(cleared, ctx) +
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
export function wireHelperRows(root, nameOf = (a) => a, onCleared = null) {
  ensureCss();
  if (onCleared) onClearedHook = onCleared;
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
