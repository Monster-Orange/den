/**
 * Issue 52, Coach slice T-a (TUNE-1): every conversation an agent has had,
 * oldest first. The Coach's usage reader reads every one of them, not only
 * the current one.
 *
 * The list lives beside the record, in the agent's own files
 * (`agent-files/<id>/conversations.json`, records.ts), never in the record:
 * records are read on hot paths (the rail, the bell, delivery ticks), and
 * the list only grows. Only the Coach reads it.
 *
 * An entry is appended whenever the record's conversation id
 * (resumeToken) changes, by writeRecord, so no start path can miss it:
 *   - `start`: its first conversation;
 *   - `bring-in`: a conversation started outside Den, brought in (AG-17.1);
 *   - `rotation`: Den relaunched it from its handoff (den#4);
 *   - `fresh`: any other new conversation (Start fresh, a relaunch).
 * The entry it replaces gets its `to`.
 *
 * An agent from before this has no list: it is backfilled from its
 * record's rotations and resumeToken, each entry marked `backfilled`
 * (their times are the best the record knows).
 */
import type { AgentRecord } from "./records.js";

export type ConversationWhy = "start" | "fresh" | "rotation" | "bring-in";

export interface ConversationEntry {
  /** The runtime's conversation id (the record's resumeToken then). */
  id: string;
  /** When it became the agent's conversation (ISO 8601). */
  from: string;
  /** When another took its place; unset while it is the current one. */
  to?: string;
  why: ConversationWhy;
  /** Rebuilt from an older record: `from` and `to` are approximate. */
  backfilled?: true;
}

const WHYS: readonly ConversationWhy[] = [
  "start",
  "fresh",
  "rotation",
  "bring-in",
];

const firstWhy = (r: AgentRecord): ConversationWhy =>
  r.broughtInAt ? "bring-in" : "start";
const firstFrom = (r: AgentRecord): string => r.broughtInAt ?? r.startedAt;

/** A pre-list agent's conversations, from its rotations and resumeToken. */
export function backfillConversations(r: AgentRecord): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  const add = (id: string, from: string, why: ConversationWhy) =>
    out.push({ id, from, why, backfilled: true });
  for (const rot of r.rotations ?? []) {
    const last = out.at(-1);
    if (rot.conversation && last?.id !== rot.conversation)
      add(
        rot.conversation,
        last ? (last.to ?? last.from) : firstFrom(r),
        last ? "fresh" : firstWhy(r),
      );
    const ended = out.at(-1);
    if (ended && ended.id === rot.conversation) ended.to = rot.at;
    if (rot.next) add(rot.next, rot.at, "rotation");
  }
  const last = out.at(-1);
  if (r.resumeToken && last?.id !== r.resumeToken)
    add(
      r.resumeToken,
      last ? (last.to ?? last.from) : firstFrom(r),
      last ? "fresh" : firstWhy(r),
    );
  return out;
}

/** Whether `id` is the list's current conversation (nothing to add). */
export function isCurrent(
  list: readonly ConversationEntry[] | null,
  id: string | undefined,
): boolean {
  return !id || (!!list && list.at(-1)?.id === id);
}

/**
 * The list after `next` is written over `prev` (null: a new agent), or
 * null when it doesn't change. `stored`: the list on disk (null: none, so
 * an existing agent's is backfilled from `prev`; a new agent's starts
 * empty, whatever an earlier agent of that id left).
 */
export function nextConversations(
  stored: readonly ConversationEntry[] | null,
  prev: AgentRecord | null,
  next: AgentRecord,
  now: string,
): ConversationEntry[] | null {
  const base = !prev ? [] : (stored ?? backfillConversations(prev));
  const list = base.map((c) => ({ ...c }));
  const id = next.resumeToken;
  if (!id || list.at(-1)?.id === id) return stored && prev ? null : list;
  const last = list.at(-1);
  if (last && !last.to) last.to = now;
  const rot = next.rotations?.at(-1);
  const why: ConversationWhy =
    next.broughtInAt && next.broughtInAt !== prev?.broughtInAt
      ? "bring-in"
      : rot?.next === id
        ? "rotation"
        : list.length
          ? "fresh"
          : "start";
  list.push({ id, from: now, why });
  return list;
}

/** A stored list as read back, or null when it isn't one. */
export function parseConversations(v: unknown): ConversationEntry[] | null {
  if (!Array.isArray(v)) return null;
  const ok = v.every(
    (c) =>
      c &&
      typeof c === "object" &&
      typeof c.id === "string" &&
      typeof c.from === "string" &&
      (c.to === undefined || typeof c.to === "string") &&
      WHYS.includes(c.why),
  );
  return ok ? (v as ConversationEntry[]) : null;
}

/** Every conversation id in `list`, oldest first, each once. */
export function conversationIds(list: readonly ConversationEntry[]): string[] {
  return [...new Set(list.map((c) => c.id))];
}
