import { paintList } from "/agents-list.js";
import { refresh } from "/agents-data.js";
import { personOrdered } from "/agent-bands.js";
import { dropTo, orderTo, orderable } from "/agent-order.js";
import { SERVER_WS, agentPath, api, esc, rowOf, st, t } from "/agents-core.js";
import { displayName, groupOf, inStopped } from "/agents-rows.js";
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


/** ⋯'s Move up, Move down and Move to top, those that can move it. */
function orderItems(r, focusRow) {
  if (!orderable(r, SERVER_WS)) return [];
  const ids = groupOf(r);
  return [
    ["up", "ag.ord.up"],
    ["down", "ag.ord.down"],
    ["top", "ag.ord.top"],
  ]
    .filter(([dir]) => orderTo(ids, r.agent, dir))
    .map(([dir, key]) => ({
      label: t(key),
      onSelect: () => void moveDir(r, dir, focusRow),
    }));
}

const moveDir = (r, dir, focusRow) =>
  moveOrder(r, orderTo(groupOf(r), r.agent, dir), focusRow);

/**
 * The move, shown at once (the list is redrawn in the new order), then
 * POSTed; then the list again, "<name> moved to position N of M" for a
 * screen reader, and (from the list) focus on the moved row. Issue 1054:
 * no pop-up and no toast. The moved row shows the kit's dots and
 * aria-busy until the answer; a refusal puts it back (the list is read
 * again) and says why under the list.
 */
async function moveOrder(r, to, focusRow) {
  if (!to) return;
  showMoved(r, to);
  const row = st.root?.querySelector(
    `#agl button.agr[data-id="${CSS.escape(r.id)}"]`,
  );
  const release = window.denShell.holdRow?.(row) ?? (async () => {});
  const errEl = st.root?.querySelector("#ag-order-err");
  let out = false;
  try {
    await api("POST", agentPath(r, "order"), { to });
    out = true;
    if (errEl) errEl.hidden = true;
  } catch (e) {
    if (errEl) {
      errEl.textContent =
        `${t("busy.ordF", { id: displayName(r) })} ${e?.message || ""}`.trim();
      errEl.hidden = false;
    }
  } finally {
    await release();
  }
  await refresh();
  if (!out) return;
  const now =
    (st.data?.sessions ?? []).find(
      (s) =>
        s.kind === "agent" &&
        s.agent === r.agent &&
        s.workspace === r.workspace,
    ) ?? r;
  const ids = groupOf(now);
  announceOrder(
    t("ag.ord.moved", {
      name: displayName(now),
      n: ids.indexOf(r.agent) + 1,
      of: ids.length,
    }),
  );
  if (focusRow)
    st.root
      ?.querySelector(`#agl button.agr[data-id="${CSS.escape(now.id)}"]`)
      ?.focus();
}

/** The list in its new order before the server answers (refresh() corrects it). */
function showMoved(r, to) {
  const all = st.data?.sessions;
  if (!all) return;
  const from = all.indexOf(r);
  const other = all.find(
    (s) =>
      s.kind === "agent" &&
      s.workspace === r.workspace &&
      s.agent === (to.before ?? to.after),
  );
  if (from < 0 || !other) return;
  const rest = all.filter((s) => s !== r);
  const at = rest.indexOf(other) + (to.after ? 1 : 0);
  st.data.sessions = [...rest.slice(0, at), r, ...rest.slice(at)];
  let n = 0;
  for (const s of st.data.sessions)
    if (s.kind === "agent" && s.agent && s.workspace === r.workspace)
      s.place = n++;
  paintList();
}

/** The polite live line under the list (the list itself is redrawn). */
function announceOrder(text) {
  const el = st.root?.querySelector("#ag-order-live");
  if (!el) return;
  el.textContent = "";
  requestAnimationFrame(() => (el.textContent = text));
}

/** How far a pointer moves on a grip before it's a drag, not a click (px). */
const DRAG_SLOP = 4;

/**
 * Alt+↑ and Alt+↓ on a row, and a pointer drag by the grip with its drop
 * line. Pointer events, not HTML drag and drop, so a finger on a phone or
 * tablet drags too; Escape cancels.
 */
function wireOrder(agl) {
  agl.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const b = e.target.closest?.("button.agr[data-id]");
    const r = b ? rowOf(b.dataset.id) : null;
    if (!orderable(r, SERVER_WS)) return;
    e.preventDefault();
    void moveDir(r, e.key === "ArrowUp" ? "up" : "down", true);
  });
  const clearDrop = () => {
    for (const x of agl.querySelectorAll("[data-drop], .lift")) {
      x.removeAttribute("data-drop");
      x.classList.remove("lift");
    }
  };
  /** Where the pointer at (x, y) would drop the dragged row, or null. */
  const hit = (x, y) => {
    const r = st.drag?.r;
    const el = r ? document.elementFromPoint(x, y) : null;
    const b = el?.closest?.("#agl button.agr[data-id]");
    const over = b ? rowOf(b.dataset.id) : null;
    if (
      !over ||
      over.kind !== "agent" ||
      over.workspace !== r.workspace ||
      inStopped(over) !== inStopped(r) ||
      !groupOf(r).includes(over.agent)
    )
      return null;
    const box = b.getBoundingClientRect();
    const after = y > box.top + box.height / 2;
    const to = dropTo(groupOf(r), r.agent, over.agent, after);
    return to ? { b, after, to } : null;
  };
  const end = () => {
    const d = st.drag;
    if (!d) return null;
    st.drag = null;
    try {
      d.grip.releasePointerCapture?.(d.id);
    } catch {
      /* already released */
    }
    clearDrop();
    agl.classList.remove("agdragging");
    return d;
  };
  agl.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest?.("[data-grip]");
    if (!grip || st.drag || (e.pointerType === "mouse" && e.button !== 0))
      return;
    const b = grip.closest("button.agr[data-id]");
    const r = b ? rowOf(b.dataset.id) : null;
    if (!orderable(r, SERVER_WS)) return;
    e.preventDefault();
    st.drag = { r, b, grip, id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      grip.setPointerCapture?.(e.pointerId);
    } catch {
      /* a synthetic pointer: moves still reach the list */
    }
  });
  agl.addEventListener("pointermove", (e) => {
    const d = st.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_SLOP) return;
      d.moved = true;
      agl.classList.add("agdragging");
    }
    e.preventDefault();
    for (const x of agl.querySelectorAll("[data-drop]"))
      x.removeAttribute("data-drop");
    d.b.classList.add("lift");
    const h = hit(e.clientX, e.clientY);
    if (h) h.b.setAttribute("data-drop", h.after ? "after" : "before");
  });
  agl.addEventListener("pointerup", (e) => {
    const d = st.drag;
    if (!d || e.pointerId !== d.id) return;
    const h = d.moved ? hit(e.clientX, e.clientY) : null;
    end();
    if (!d.moved) return;
    // The click that follows a drag isn't a click on the row.
    st.dragClick = true;
    setTimeout(() => (st.dragClick = false), 0);
    paintList();
    if (h) void moveOrder(d.r, h.to, true);
  });
  agl.addEventListener("pointercancel", () => {
    if (end()) paintList();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && st.drag && end()) paintList();
  });
  agl.addEventListener(
    "click",
    (e) => {
      if (!st.dragClick) return;
      e.preventDefault();
      e.stopPropagation();
      st.dragClick = false;
    },
    true,
  );
}

export { DRAG_SLOP, announceOrder, moveDir, moveOrder, orderItems, orderRowHtml, reorderBandHtml, reorderStoppedHtml, runningMovable, showMoved, stoppedMovable, wireOrder };
