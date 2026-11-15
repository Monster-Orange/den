/**
 * D79 (den#96): the person's order for a project's agents, stored in
 * the project setup as `<ws>.agents.order: [agent id, …]` in
 * config/local/workspaces.yml (this install's own). Every list of a
 * project's agents follows it: GET /api/sessions (the Agents page, the
 * rail, the service flyout) and `agents list`. An agent keeps its id
 * through every restart path, so the order survives them.
 *
 * Agents not in the list (new ones) go after it, oldest first, so a new
 * agent lands at the bottom; ids of removed agents are skipped, so they
 * leave no gap. With no saved order: by start time (the project's lead
 * first, when AGENT-ORG gives one).
 */
import {
  readWorkspacesFile,
  writeWorkspacesFile,
} from "../environment-manager/workspaces.js";
import type { WorkspacesFile } from "../types/index.js";

/** An agent id as Den writes them. */
const AGENT_ID_RE = /^[A-Za-z0-9][\w.-]{0,127}$/;
/** More than any project has; a hand-edited list is cut here. */
export const AGENT_ORDER_MAX = 500;

/** A stored order, checked: agent ids only, each once. */
export function parseAgentOrder(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string" || !AGENT_ID_RE.test(x) || seen.has(x)) continue;
    seen.add(x);
    if (seen.size >= AGENT_ORDER_MAX) break;
  }
  return [...seen];
}

/** Project `ws`'s stored order ([] when none or unreadable). */
export function agentOrderOf(
  ws: string,
  read: () => WorkspacesFile = readWorkspacesFile,
): string[] {
  try {
    return parseAgentOrder(read().workspaces[ws]?.agents?.order);
  } catch {
    return [];
  }
}

/** Store project `ws`'s order; [] clears it. Returns what was stored. */
export function setAgentOrder(ws: string, ids: readonly unknown[]): string[] {
  const file = readWorkspacesFile();
  const cfg = file.workspaces[ws];
  if (!cfg) throw new Error(`project "${ws}" does not exist`);
  const order = parseAgentOrder(ids);
  const agents = { ...(cfg.agents ?? {}) };
  if (order.length) agents.order = order;
  else delete agents.order;
  const next = { ...cfg };
  if (Object.keys(agents).length) next.agents = agents;
  else delete next.agents;
  file.workspaces[ws] = next;
  writeWorkspacesFile(file);
  return order;
}

/**
 * `items` in the stored order of their project: the listed ones by their
 * place, then the rest oldest first (by `startedAt`), then as they came.
 * Items of different projects keep their projects' relative order: only
 * positions held by one project's agents are reordered among themselves.
 */
export function inAgentOrder<T>(
  items: readonly T[],
  key: (x: T) => { ws?: string; id?: string; startedAt?: string } | null,
  orderOf: (ws: string) => readonly string[],
): T[] {
  const out = [...items];
  const byWs = new Map<string, number[]>();
  items.forEach((x, i) => {
    const k = key(x);
    if (!k?.ws || !k.id) return;
    const at = byWs.get(k.ws) ?? [];
    at.push(i);
    byWs.set(k.ws, at);
  });
  for (const [ws, slots] of byWs) {
    const place = new Map(orderOf(ws).map((id, i) => [id, i]));
    const sorted = slots
      .map((i) => ({ i, k: key(items[i])! }))
      .sort((a, b) => {
        const pa = place.get(a.k.id!);
        const pb = place.get(b.k.id!);
        if (pa !== undefined || pb !== undefined)
          return (pa ?? Infinity) - (pb ?? Infinity) || a.i - b.i;
        const sa = a.k.startedAt ?? "";
        const sb = b.k.startedAt ?? "";
        return sa === sb ? a.i - b.i : sa < sb ? -1 : 1;
      });
    slots.forEach((slot, n) => (out[slot] = items[sorted[n].i]));
  }
  return out;
}

/**
 * Where a moved agent goes: up or down one, to the top or bottom, to a
 * place, or next to another agent (a drop on the page, and the page's
 * Move up and down, which stay inside the row's group).
 */
export type AgentMove =
  | "up"
  | "down"
  | "top"
  | "bottom"
  | number
  | { before: string }
  | { after: string };

/**
 * The order after moving `id` among `shown` (the project's agents as they
 * are listed now, saved order applied). Returns the whole list, which is
 * what is stored, so the order is the same everywhere afterwards. A place
 * is 1-based and clamped; next to an agent it must be another of `shown`.
 */
export function moveInOrder(
  shown: readonly string[],
  id: string,
  to: AgentMove,
): string[] {
  const from = shown.indexOf(id);
  if (from < 0) throw new Error(`no agent "${id}" in this project`);
  const rest = shown.filter((x) => x !== id);
  let at: number;
  if (to === "up") at = Math.max(0, from - 1);
  else if (to === "down") at = Math.min(rest.length, from + 1);
  else if (to === "top") at = 0;
  else if (to === "bottom") at = rest.length;
  else if (typeof to === "object") {
    const other = "before" in to ? to.before : to.after;
    if (other === id) throw new Error("an agent can't move next to itself");
    const i = rest.indexOf(other);
    if (i < 0) throw new Error(`no agent "${other}" in this project`);
    at = "before" in to ? i : i + 1;
  } else at = Math.min(rest.length, Math.max(0, Math.floor(to) - 1));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
