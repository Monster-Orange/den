/**
 * D71: deleting a workspace that has agents asks what happens to them,
 * so none is left running with no workspace:
 *
 *   Stop them   each running one stops; all are removed (Undo, an hour)
 *   Move them   to another workspace: a stopped one now, a running one
 *               once its turn ends, the same conversation (D72)
 *
 *   askWorkspaceAgents({ ws, agents, others })  resolves
 *     { agents: "stop" } | { agents: "move", agentsTo } | null (Cancel)
 *
 * `agents` as GET /api/workspaces/cleanup-preview lists them
 * ({id, name?, running}); `others` the workspaces it may move them to.
 */

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const CSS = `
.wsd-dlg{font-family:var(--sans);width:min(440px,calc(100vw - 32px));padding:0;border:1px solid var(--border-strong, var(--border));border-radius:10px;background:var(--raised, var(--surface, var(--bg)));color:var(--text);box-shadow:var(--shadow)}
.wsd-dlg::backdrop{background:rgba(0,0,0,.25)}
.wsd-dlg [hidden]{display:none}
.wsd-b{padding:16px 18px;display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.5}
.wsd-b h2{font-size:15px;margin:0}
.wsd-b ul{margin:0;padding-left:18px;color:var(--muted)}
.wsd-opt{display:flex;gap:8px;align-items:flex-start}
.wsd-opt select{margin-left:4px;font:13px var(--sans)}
.wsd-acts{display:flex;gap:8px;justify-content:flex-end}
`;

function ensureCss() {
  if (document.getElementById("wsd-css")) return;
  const s = document.createElement("style");
  s.id = "wsd-css";
  s.textContent = CSS;
  document.head.append(s);
}

export function askWorkspaceAgents({ ws, agents, others = [] }) {
  ensureCss();
  document.getElementById("wsd-dlg")?.remove();
  const d = document.createElement("dialog");
  d.id = "wsd-dlg";
  d.className = "wsd-dlg";
  d.setAttribute("aria-labelledby", "wsd-h");
  const running = agents.filter((a) => a.running).length;
  const canMove = others.length > 0;
  d.innerHTML =
    `<form class="wsd-b" method="dialog">` +
    `<h2 id="wsd-h">${esc(t("wsd.title", { ws, n: agents.length }))}</h2>` +
    `<ul>${agents
      .map(
        (a) =>
          `<li>${esc(a.name || a.id)}${a.running ? ` · ${esc(t("wsd.running"))}` : ""}</li>`,
      )
      .join("")}</ul>` +
    `<label class="wsd-opt"><input type="radio" name="wsd" value="move"${canMove ? " checked" : " disabled"}>` +
    `<span>${esc(t("wsd.move"))}<select id="wsd-to"${canMove ? "" : " disabled"}>${others
      .map((w) => `<option value="${esc(w)}">${esc(w)}</option>`)
      .join("")}</select>` +
    `${running ? `<br><small>${esc(t("wsd.moveRunning"))}</small>` : ""}</span></label>` +
    `<label class="wsd-opt"><input type="radio" name="wsd" value="stop"${canMove ? "" : " checked"}>` +
    `<span>${esc(t("wsd.stop"))}<br><small>${esc(t("wsd.stopHelp"))}</small></span></label>` +
    `<div class="wsd-acts"><button type="button" class="den-btn sm" data-wsd="cancel">${esc(t("wsd.cancel"))}</button>` +
    `<button type="submit" class="den-btn sm primary" data-wsd="go">${esc(t("wsd.go"))}</button></div></form>`;
  document.body.append(d);
  return new Promise((resolve) => {
    let answer = null;
    d.addEventListener("close", () => {
      d.remove();
      resolve(answer);
    });
    d.querySelector('[data-wsd="cancel"]').addEventListener("click", () =>
      d.close(),
    );
    d.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const how = d.querySelector('input[name="wsd"]:checked')?.value;
      answer =
        how === "move"
          ? { agents: "move", agentsTo: d.querySelector("#wsd-to").value }
          : how === "stop"
            ? { agents: "stop" }
            : null;
      d.close();
    });
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
    d.querySelector('[data-wsd="go"]').focus();
  });
}

if (typeof window !== "undefined")
  window.denAskWorkspaceAgents = askWorkspaceAgents;
