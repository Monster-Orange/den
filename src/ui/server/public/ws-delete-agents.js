/**
 * D71: deleting a workspace that has agents asks what happens to them,
 * so none is left running with no workspace:
 *
 *   Stop them   each running one stops; all are removed (Undo, an hour)
 *   Move them   to another workspace: a stopped one now, a running one
 *               once its turn ends, the same conversation (D72)
 *
 *   askWorkspaceAgents({ ws, agents, others, onGo? })  resolves
 *     { agents: "stop" } | { agents: "move", agentsTo } | null (Cancel)
 *
 * `agents` as GET /api/workspaces/cleanup-preview lists them
 * ({id, name?, running}); `others` the workspaces it may move them to.
 */
import { dialogHtml, mountDialog } from "/dialog-den.js";

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** Issue 669: the kit's confirm frame (/dialog-den.js), no dialog of its own. */
export function askWorkspaceAgents({ ws, agents, others = [], onGo }) {
  const running = agents.filter((a) => a.running).length;
  const canMove = others.length > 0;
  const body =
    `<ul>${agents
      .map(
        (a) =>
          `<li>${esc(a.name || a.id)}${a.running ? ` · ${esc(t("wsd.running"))}` : ""}</li>`,
      )
      .join("")}</ul>` +
    `<label class="dk-opt"><input type="radio" name="wsd" value="move"${canMove ? " checked" : " disabled"}>` +
    `<span>${esc(t("wsd.move"))}<select id="wsd-to"${canMove ? "" : " disabled"}>${others
      .map((w) => `<option value="${esc(w)}">${esc(w)}</option>`)
      .join("")}</select>` +
    `${running ? `<br><small>${esc(t("wsd.moveRunning"))}</small>` : ""}</span></label>` +
    `<label class="dk-opt"><input type="radio" name="wsd" value="stop"${canMove ? "" : " checked"}>` +
    `<span>${esc(t("wsd.stop"))}<br><small>${esc(t("wsd.stopHelp"))}</small></span></label>`;
  const html = dialogHtml({
    kind: "confirm",
    id: "wsd-dlg",
    ids: { h: "wsd-h" },
    className: "wsd-dlg",
    title: t("wsd.title", { ws, n: agents.length }),
    body,
    actions: [
      {
        label: t("wsd.cancel"),
        value: "cancel",
        attrs: { "data-wsd": "cancel" },
      },
      {
        label: t("wsd.go"),
        value: "go",
        kind: "primary",
        attrs: { "data-wsd": "go" },
      },
    ],
  });
  let answer = null;
  const pick = (d) => {
    const how = d.querySelector('input[name="wsd"]:checked')?.value;
    return how === "move"
      ? { agents: "move", agentsTo: d.querySelector("#wsd-to").value }
      : how === "stop"
        ? { agents: "stop" }
        : null;
  };
  const h = mountDialog(html, {
    focus: '[data-wsd="go"]',
    // Issue 1054: onGo(answer) → Promise sends from here; Go holds until
    // the answer, then the dialog closes.
    onAction: (value, d) =>
      value === "go" && typeof onGo === "function" ? onGo(pick(d)) : undefined,
    onClose: (value, d) => {
      if (value !== "go") return;
      answer = pick(d);
    },
  });
  return h.closed.then(() => answer);
}

if (typeof window !== "undefined")
  window.denAskWorkspaceAgents = askWorkspaceAgents;
