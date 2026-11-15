/**
 * D79 (den#96): the page's side of a project's agents in the person's
 * order. The server lists them in the saved order (GET /api/sessions);
 * the page works out where a move goes and POSTs it to
 * /api/workspaces/:ws/agents/:id/order.
 *
 * A row moves inside its group only: the same project, and the same side
 * of the list (running, or the Stopped group). So Move up, Move down and
 * a drop are "before" or "after" a neighbour in that group, never a
 * place in the whole list.
 */

/** Whether a row can be moved: an agent's, outside the server agent's own folder. */
export function orderable(r, serverWs) {
  return !!r && r.kind === "agent" && !!r.agent && r.workspace !== serverWs;
}

/** The agent ids of `r`'s group, as shown (`rows` in the server's order). */
export function orderGroup(rows, r, stoppedOf) {
  if (!r || r.kind !== "agent" || !r.agent) return [];
  const side = !!stoppedOf(r);
  return rows
    .filter(
      (s) =>
        s.kind === "agent" &&
        s.agent &&
        s.workspace === r.workspace &&
        !!stoppedOf(s) === side,
    )
    .map((s) => s.agent);
}

/** The route's `to` for moving `id` up, down or to the top of `ids`; null when it can't. */
export function orderTo(ids, id, dir) {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  if (dir === "up" || dir === "top")
    return i > 0 ? { before: ids[dir === "up" ? i - 1 : 0] } : null;
  if (dir === "down") return i < ids.length - 1 ? { after: ids[i + 1] } : null;
  return null;
}

/**
 * The route's `to` for dropping `id` on `target`'s row, in its lower half
 * (`after`) or upper half; null when the drop would change nothing.
 */
export function dropTo(ids, id, target, after) {
  const i = ids.indexOf(id);
  const j = ids.indexOf(target);
  if (i < 0 || j < 0 || i === j) return null;
  if (after ? j + 1 === i : j - 1 === i) return null;
  return after ? { after: target } : { before: target };
}
