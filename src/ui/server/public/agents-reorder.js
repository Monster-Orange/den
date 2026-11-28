import { personOrdered } from "/agent-bands.js";
import { orderTo, orderable } from "/agent-order.js";
import { SERVER_WS, esc, st, t } from "/agents-core.js";
import { displayName, groupOf } from "/agents-rows.js";
import { phone } from "/agents-url.js";

const runningMovable = (r) => orderable(r, SERVER_WS) && groupOf(r).length >= 2;

function reorderBandHtml(b) {
  if (!phone() || !personOrdered(b.state) || !b.rows.some(runningMovable))
    return "";
  const on = st.reorderBand === b.state;
  const band = t(`ag.band.${b.state}`);
  return `<div class="agord-sb"><button type="button" class="den-btn sm agord-t" data-act="reorder" data-band="${esc(b.state)}" aria-pressed="${on}" aria-label="${esc(on ? t("ag.ord.done") : t("ag.ord.reorderBand", { band }))}">${esc(on ? t("ag.ord.done") : t("ag.ord.reorder"))}</button></div>`;
}

/**
 * Issue 226: a phone's Reorder (or Done) for the Stopped group, when one
 * of its projects has two stopped agents to order.
 */
function reorderStoppedHtml(rows) {
  if (!phone() || !rows.some(stoppedMovable)) return "";
  const on = st.reorderStopped;
  return `<div class="agord-sb"><button type="button" class="den-btn sm agord-t" data-act="reorder" data-stopped="" aria-pressed="${on}" aria-label="${esc(on ? t("ag.ord.done") : t("ag.ord.reorderStopped"))}">${esc(on ? t("ag.ord.done") : t("ag.ord.reorder"))}</button></div>`;
}

/** Issue 226: a stopped row that can move: its group has two or more. */
const stoppedMovable = (r) => orderable(r, SERVER_WS) && groupOf(r).length >= 2;

/** `html`, the row of `r`; with its Up and Down beside it when `on`. */
function orderRowHtml(html, r, on) {
  if (!on) return html;
  const ids = groupOf(r);
  const btn = (dir, key, sign) =>
    `<button type="button" class="den-btn sm" data-act="ord-${dir}" aria-label="${esc(t(key, { id: displayName(r) }))}"${orderTo(ids, r.agent, dir) ? "" : ' aria-disabled="true"'}>${sign}</button>`;
  return (
    `<div class="agord" data-agent="${esc(r.agent)}" data-ws="${esc(r.workspace)}"><div class="agord-r">${html}</div>` +
    `<span class="agord-b">${btn("up", "ag.ord.upOne", "↑")}${btn("down", "ag.ord.downOne", "↓")}</span></div>`
  );
}

export { orderRowHtml, reorderBandHtml, reorderStoppedHtml, runningMovable, stoppedMovable };
