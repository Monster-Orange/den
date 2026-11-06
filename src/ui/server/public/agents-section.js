/**
 * The Workspaces page's Agents section (AG-4a, AG spec §5c): under the
 * repo table, one row per agent of the selected workspace (persona and id,
 * runtime, state, cwd, started at), Stop and, where the record allows it,
 * Resume; "+ Start agent" picks a persona and a runtime. The workspace
 * header counts them ("n agents", R24c).
 *
 * Every call is the server's agent routes (agent-routes.ts), which are the
 * CLI's own operations: nothing here keeps an agent's state. Each action
 * goes through denShell.api() (a refusal is its error toast) after the
 * lock rule (requireUnlock, R8), as a service action does. There is no
 * terminal and no Open: attaching from the browser comes with SEC-1.
 *
 * The page's table styles (table.svc, .tablewrap, .tbl-*) and the shell's
 * (.den-sec, .den-btn, .den-dot) are reused as they are.
 */
import { requireUnlock } from "/topbar.js";

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const api = (method, url, body) => window.denShell.api(method, url, body);
const base = (ws) => `/api/workspaces/${encodeURIComponent(ws)}/agents`;

/** How often the list is asked again (faster while one is stopping). */
const REFRESH_MS = 15_000;
const STOPPING_MS = 1_000;

let current = null; // { ws, rows, timer }
let personasAsked = null;

/** The section's frame, drawn with the page; mountAgents fills it. */
export function agentsSectionHtml(ws) {
  return `<section class="agents" id="agents-section" data-ws="${esc(ws)}" aria-labelledby="agents-h">
            <h2 class="den-sec" id="agents-h">${esc(t("ag.title"))}</h2>
            <div class="tablewrap">
              <table class="svc" id="agent-table">
                <caption>${esc(t("ag.caption", { ws }))}</caption>
                <thead><tr>
                  <th scope="col">${esc(t("ag.col.agent"))}</th>
                  <th scope="col">${esc(t("ag.col.runtime"))}</th>
                  <th scope="col">${esc(t("ag.col.state"))}</th>
                  <th scope="col">${esc(t("ag.col.cwd"))}</th>
                  <th scope="col">${esc(t("ag.col.started"))}</th>
                  <th scope="col"><span class="tbl-sr">${esc(t("ag.col.actions"))}</span></th>
                </tr></thead>
                <tbody><tr class="tbl-none"><td colspan="6">${esc(t("ag.loading"))}</td></tr></tbody>
              </table>
            </div>
            <div class="tbl-foot">
              <button type="button" class="add-svc-open-btn" id="agent-start-open" aria-expanded="false" aria-controls="agent-start-form">${esc(t("ag.start"))}</button>
              <form class="agent-form" id="agent-start-form" hidden>
                <label>${esc(t("ag.persona"))} <select class="form-sel" name="persona" required></select></label>
                <label>${esc(t("ag.runtime"))} <select class="form-sel" name="runtime"></select></label>
                <button type="submit" class="den-btn sm primary" id="agent-start-go">${esc(t("ag.go"))}</button>
                <button type="button" class="den-btn sm" data-agent-cancel>${esc(t("ag.cancel"))}</button>
              </form>
            </div>
          </section>`;
}

/** A state word in the page's language (the server's word is the key). */
function stateText(state) {
  const m = /^exited(?: \((-?\d+)\))?$/.exec(state);
  if (m)
    return m[1] === undefined
      ? t("ag.state.exited")
      : t("ag.state.exitedCode", { code: m[1] });
  return ["running", "stopping", "stopped", "ended"].includes(state)
    ? t(`ag.state.${state}`)
    : state;
}

/** The state cell: the repo table's health look (dot, then the word). */
function stateCell(state) {
  const cls =
    state === "running"
      ? { tone: " ok", dot: "" }
      : state === "stopping"
        ? { tone: "", dot: "pending" }
        : /^exited \((?!0\))/.test(state)
          ? { tone: " bad", dot: "bad" }
          : { tone: "", dot: "off" };
  return `<span class="tbl-health${cls.tone}" data-state="${esc(state)}"><span class="den-dot ${cls.dot}" aria-hidden="true"></span><span class="tbl-ht">${esc(stateText(state))}</span></span>`;
}

function when(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(window.denShell?.lang?.() || undefined, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function rowHtml(r) {
  const running = r.state === "running" || r.state === "stopping";
  const btn = (act, label, name) =>
    `<button type="button" class="den-btn sm tbl-btn" data-agent-act="${act}" data-id="${esc(r.agent)}" aria-label="${esc(name)}">${esc(label)}</button>`;
  const acts =
    (running
      ? btn("stop", t("ag.stop"), t("ag.stopName", { id: r.agent }))
      : "") +
    (r.resumable
      ? btn("resume", t("ag.resume"), t("ag.resumeName", { id: r.agent }))
      : "");
  const persona =
    r.persona && r.persona !== r.agent
      ? ` <span class="tbl-muted">${esc(t("ag.personaOf", { persona: r.persona }))}</span>`
      : "";
  const model = r.model
    ? ` <span class="tbl-muted">· ${esc(r.model)}</span>`
    : "";
  return `<tr class="agent" data-agent="${esc(r.agent)}" data-state="${esc(r.state)}">
              <th scope="row"><span class="repo-name">${esc(r.agent)}</span>${persona}</th>
              <td class="tbl-mono">${esc(r.runtime ?? "—")}${model}</td>
              <td>${stateCell(r.state)}</td>
              <td class="tbl-mono tbl-muted agent-cwd" title="${esc(r.cwd ?? "")}">${esc(r.cwd ?? "—")}</td>
              <td class="tbl-muted">${esc(when(r.startedAt))}</td>
              <td><div class="tbl-acts">${acts}</div></td>
            </tr>`;
}

function paint(ws, rows) {
  const sec = document.getElementById("agents-section");
  if (!sec || sec.dataset.ws !== ws) return;
  const body = sec.querySelector("#agent-table tbody");
  body.innerHTML = rows.length
    ? rows.map(rowHtml).join("")
    : `<tr class="tbl-none"><td colspan="6">${esc(t("ag.none"))}</td></tr>`;
  const count = document.getElementById("ws-agents-count");
  if (count) {
    count.textContent = t("ag.count", { n: rows.length });
    count.hidden = false;
  }
}

/** Ask the list again, and keep asking while the section is shown. */
async function refresh(ws) {
  if (!current || current.ws !== ws) return;
  clearTimeout(current.timer);
  let rows = current.rows;
  try {
    const data = await api("GET", base(ws));
    rows = Array.isArray(data?.agents) ? data.agents : [];
  } catch (err) {
    // A failed list keeps the last one; the first failure says so.
    if (!current.failed) window.denShell?.errorToast?.(err);
    if (current) current.failed = true;
  }
  if (!current || current.ws !== ws) return;
  current.rows = rows;
  paint(ws, rows);
  if (!document.getElementById("agents-section")) return;
  const soon = rows.some((r) => r.state === "stopping");
  current.timer = setTimeout(
    () => {
      if (!document.hidden) void refresh(ws);
      else if (current)
        current.timer = setTimeout(() => refresh(ws), REFRESH_MS);
    },
    soon ? STOPPING_MS : REFRESH_MS,
  );
}

function fillForm(form, data) {
  const ps = form.querySelector('select[name="persona"]');
  ps.innerHTML = (data.personas ?? [])
    .map(
      (p) =>
        `<option value="${esc(p.id)}">${esc(p.id)}${p.role ? ` — ${esc(p.role)}` : ""}</option>`,
    )
    .join("");
  const rs = form.querySelector('select[name="runtime"]');
  rs.innerHTML =
    `<option value="">${esc(t("ag.runtime.auto"))}</option>` +
    (data.runtimes ?? [])
      .map(
        (r) =>
          `<option value="${esc(r.id)}"${r.available ? "" : " disabled"}>${esc(r.id)}${r.available ? "" : ` — ${esc(t("ag.unavailable"))}`}</option>`,
      )
      .join("");
}

async function openForm(sec) {
  const form = sec.querySelector("#agent-start-form");
  const open = sec.querySelector("#agent-start-open");
  if (!form.hidden) {
    form.hidden = true;
    open.setAttribute("aria-expanded", "false");
    return;
  }
  personasAsked ??= api("GET", "/api/personas").catch((err) => {
    personasAsked = null;
    throw err;
  });
  let data;
  try {
    data = await personasAsked;
  } catch (err) {
    window.denShell?.errorToast?.(err);
    return;
  }
  fillForm(form, data);
  form.hidden = false;
  open.setAttribute("aria-expanded", "true");
  form.querySelector('select[name="persona"]').focus();
}

async function act(ws, verb, id, button) {
  if (!requireUnlock()) return;
  button.disabled = true;
  try {
    await api("POST", `${base(ws)}/${encodeURIComponent(id)}/${verb}`);
    window.denShell?.toast?.(
      t(verb === "stop" ? "ag.stopped" : "ag.resumed", { id }),
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  await refresh(ws);
}

async function start(ws, form) {
  if (!requireUnlock()) return;
  const go = form.querySelector("#agent-start-go");
  const persona = form.querySelector('select[name="persona"]').value;
  const runtime = form.querySelector('select[name="runtime"]').value;
  if (!persona) return;
  go.disabled = true;
  go.textContent = t("ag.starting");
  try {
    const r = await api("POST", base(ws), {
      persona,
      ...(runtime ? { runtime } : {}),
    });
    window.denShell?.toast?.(t("ag.started", { id: r?.agent?.id ?? persona }));
    form.hidden = true;
    form
      .closest("section")
      ?.querySelector("#agent-start-open")
      ?.setAttribute("aria-expanded", "false");
  } catch (err) {
    window.denShell?.errorToast?.(err);
  } finally {
    go.disabled = false;
    go.textContent = t("ag.go");
  }
  await refresh(ws);
}

/** Fill the section drawn by agentsSectionHtml(ws) and wire its controls. */
export function mountAgents(ws) {
  const sec = document.getElementById("agents-section");
  if (!sec || sec.dataset.ws !== ws) return;
  if (current) clearTimeout(current.timer);
  current = { ws, rows: [], timer: null, failed: false };
  sec.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !sec.contains(b)) return;
    if (b.id === "agent-start-open") return void openForm(sec);
    if (b.hasAttribute("data-agent-cancel")) {
      sec.querySelector("#agent-start-form").hidden = true;
      sec
        .querySelector("#agent-start-open")
        .setAttribute("aria-expanded", "false");
      return;
    }
    const verb = b.dataset.agentAct;
    if (verb === "stop" || verb === "resume")
      void act(ws, verb, b.dataset.id, b);
  });
  sec.querySelector("#agent-start-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void start(ws, e.currentTarget);
  });
  void refresh(ws);
}
