/**
 * Issue 96: a person's order for a project's agents. It is the
 * person's view, so it lives in their user config (config/local/user.yml,
 * like the rail's order and the Agents page's layout) as
 * `agents.order: { <project>: [agent id, …] }`, never in an agent's record
 * or the project setup. Every list of a project's agents follows it:
 * GET /api/sessions (the Agents page's list, the service flyout) and
 * GET /api/workspaces/:ws/agents (the Projects page, `agents list`). An
 * agent keeps its id through every restart path, so the order survives
 * them, and a Den restart reads the file again.
 *
 * Agents not in the list (new ones) go after it, oldest first, so a new
 * agent lands at the end; ids of removed agents, and any id no agent has,
 * are skipped, so they leave no gap. With no saved order: by start time.
 */
import { WORKSPACE_NAME_RE } from "../agent-actor.js";
import {
  readUserConfig,
  writeUserConfig,
  type UserConfig,
} from "../den-config.js";

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

/**
 * The ids of `present` (a project's agents now, as listed) in the stored
 * order: the stored ones first, by their place, then the rest as they
 * came. An id stored for an agent that's gone, or never was, is dropped.
 */
export function mergeAgentOrder(
  stored: unknown,
  present: readonly string[],
): string[] {
  const here = new Set(present);
  const first = parseAgentOrder(stored).filter((id) => here.has(id));
  const placed = new Set(first);
  return [...first, ...present.filter((id) => !placed.has(id))];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Project `ws`'s order in this person's config `user` ([] when none). */
export function agentOrderIn(user: UserConfig, ws: string): string[] {
  const all = (user.agents as { order?: unknown } | undefined)?.order;
  return isObject(all) ? parseAgentOrder(all[ws]) : [];
}

/**
 * `user` with project `ws`'s order set to `ids` ([] clears it); the input
 * isn't changed. Other projects' orders and other agents.* keys stay.
 */
export function withAgentOrder(
  user: UserConfig,
  ws: string,
  ids: readonly unknown[],
): UserConfig {
  if (!WORKSPACE_NAME_RE.test(ws))
    throw new Error(`"${ws}" is not a project name`);
  const agents = { ...((user.agents ?? {}) as Record<string, unknown>) };
  const all = isObject(agents.order) ? { ...agents.order } : {};
  const order = parseAgentOrder(ids);
  if (order.length) all[ws] = order;
  else delete all[ws];
  if (Object.keys(all).length) agents.order = all;
  else delete agents.order;
  const next: UserConfig = { ...user };
  if (Object.keys(agents).length) next.agents = agents as UserConfig["agents"];
  else delete next.agents;
  return next;
}

/** Project `ws`'s stored order for the person at this install ([] when none or unreadable). */
export function agentOrderOf(
  ws: string,
  read: () => UserConfig = readUserConfig,
): string[] {
  try {
    return agentOrderIn(read(), ws);
  } catch {
    return [];
  }
}

/** Store project `ws`'s order in the person's user config; [] clears it. Returns what was stored. */
export function setAgentOrder(ws: string, ids: readonly unknown[]): string[] {
  const next = withAgentOrder(readUserConfig(), ws, ids);
  writeUserConfig(next);
  return agentOrderIn(next, ws);
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

/**
 * Agent `id`'s place (0 first) in project `ws`'s saved order,
 * or undefined when the person set none for it. The Agents page keeps that
 * order inside each band (the kit's inPersonOrder).
 */
export function placeInOrder(
  orderOf: (ws: string) => readonly string[],
  ws: string,
  id: string,
): number | undefined {
  const i = orderOf(ws).indexOf(id);
  return i >= 0 ? i : undefined;
}
