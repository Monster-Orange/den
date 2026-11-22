/**
 * Issue 52, Coach slice T-a (TUNE-1): every conversation an agent has had,
 * on its record as `conversations`, oldest first. The Coach's usage reader
 * reads every one of them, not only the current one.
 *
 * An entry is appended whenever the record's conversation id
 * (resumeToken) changes, by writeRecord, so no start path can miss it:
 *   - `start`: its first conversation;
 *   - `bring-in`: a conversation started outside Den, brought in (AG-17.1);
 *   - `rotation`: Den relaunched it from its handoff (den#4);
 *   - `fresh`: any other new conversation (Start fresh, a relaunch).
 * The entry it replaces gets its `to`.
 *
 * A record from before this has no list: it is backfilled from its
 * rotations and its resumeToken, each entry marked `backfilled` (their
 * times are the best the record knows).
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

const firstWhy = (r: AgentRecord): ConversationWhy =>
  r.broughtInAt ? "bring-in" : "start";
const firstFrom = (r: AgentRecord): string => r.broughtInAt ?? r.startedAt;

/** A pre-list record's conversations, from its rotations and resumeToken. */
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

/** The record's list, or its backfill when it has none. */
function listOf(r: AgentRecord): ConversationEntry[] {
  return r.conversations ?? backfillConversations(r);
}

/**
 * `next` with its conversations kept: `prev`'s list (the stored one wins
 * over a caller's copy, so a write from a stale copy loses nothing), plus
 * an entry when `next`'s conversation id differs from the last one.
 */
export function withConversations(
  prev: AgentRecord | null,
  next: AgentRecord,
  now: string,
): AgentRecord {
  const list = (prev ? listOf(prev) : (next.conversations ?? [])).map((c) => ({
    ...c,
  }));
  const id = next.resumeToken;
  const last = list.at(-1);
  if (id && last?.id !== id) {
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
  }
  return { ...next, conversations: list };
}

/** Every conversation id the agent has had, oldest first, each once. */
export function conversationIds(r: AgentRecord): string[] {
  return [...new Set(listOf(r).map((c) => c.id))];
}
