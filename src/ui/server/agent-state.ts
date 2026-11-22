/**
 * Issue 773: each running agent's state for one person, one of four (the
 * kit's attention table, packages/den-ui/src/attention.js):
 *   needs    stopped on a permission, a question, an Allow (or its folder
 *            trust): its row's `waiting`, but not an idle notice ("input")
 *   working  in a turn (attention.ts: a turn began, none ended since)
 *   done     a turn ended after this person last opened it (the seen mark,
 *            src/shared/seen-mark.ts: subject "agent:<id>", version the
 *            turn's end)
 *   idle     none of these
 * A stopped agent and a plain shell have none: the Stopped group and the
 * Terminals keep them. `attnSince`: since when it waits (needs), when it
 * finished (done), since when it works, or its last finish (idle).
 */
import { isServerScope } from "../../shared/agents/server-agent.js";
import type * as http from "http";
import { agentSeenSubject, type SeenMarks } from "../../shared/seen-mark.js";
import { principalOf } from "./request-guard.js";
import { FIXTURE_PRINCIPAL } from "../../shared/fixture-person.js";
import { osUser } from "../../shared/web-secret.js";

export type AgentAttn = "needs" | "done" | "working" | "idle";

export interface AgentStateDeps {
  seen: SeenMarks;
  /** The agents in a turn now, and since when (ms). */
  working: () => ReadonlyMap<string, number>;
  /** Since when `agent` waits (an ISO time), when known. */
  waitingSince?: (agent: string) => string | undefined;
  /** What `agent` waits to do (a permission's tool, e.g. "Bash"), when known. */
  waitingWhat?: (agent: string) => string | undefined;
}

/** The seen mark's subject for agent `id`. */
export const agentSubject = agentSeenSubject;

/**
 * Whose seen marks a request reads and writes: the person it proved
 * ("person:<user>"; a signed-in browser is its OS user's, so a phone and
 * a desktop are one person). A loopback page with no session, or no
 * credential, is that same person. The test install's fixture person
 * (issue 810) and an agent keep their own key: never the person's marks.
 */
export function personKey(req: http.IncomingMessage): string {
  const p = principalOf(req);
  if (p && (p.startsWith("person:") || p.startsWith("agent:"))) return p;
  if (p === FIXTURE_PRINCIPAL) return p;
  return `person:${osUser()}`;
}

interface RowLike {
  id?: string;
  workspace?: string;
  kind?: string;
  agent?: string;
  state?: string;
  waiting?: boolean;
  waitingWhy?: string;
}

/** `row`'s state for `person`, or null (not a running agent). */
export function agentStateOf(
  row: RowLike,
  person: string,
  d: AgentStateDeps,
): { attn: AgentAttn; attnSince?: string; attnWhat?: string } | null {
  if (row.kind !== "agent" || !row.agent || row.state !== "running")
    return null;
  const id = row.agent;
  const needs = !!row.waiting && row.waitingWhy !== "input";
  const workingAt = d.working().get(id);
  const latest = d.seen.latest(agentSubject(id));
  const done =
    !!latest && !d.seen.isSeen({ subject: agentSubject(id), person });
  // The kit's attentionState (packages/den-ui/src/attention.js), the same
  // rule: a need first, then a turn under way, then unseen work.
  const attn: AgentAttn = needs
    ? "needs"
    : workingAt !== undefined
      ? "working"
      : done
        ? "done"
        : "idle";
  const since =
    attn === "needs"
      ? d.waitingSince?.(id)
      : attn === "done"
        ? latest?.at
        : attn === "working" && workingAt !== undefined
          ? new Date(workingAt).toISOString()
          : latest?.at;
  const what = attn === "needs" ? d.waitingWhat?.(id) : undefined;
  return {
    attn,
    ...(since ? { attnSince: since } : {}),
    ...(what ? { attnWhat: what } : {}),
  };
}

/** The list's rows, each running agent with its state for `person`. */
export function withAgentStates<T extends RowLike>(
  rows: readonly T[],
  person: string,
  d: AgentStateDeps,
): (T & { attn?: AgentAttn; attnSince?: string; attnWhat?: string })[] {
  return rows.map((r) => {
    const s = agentStateOf(r, person, d);
    return s ? { ...r, ...s } : r;
  });
}

export interface DoneAgent {
  agent: string;
  name: string;
  workspace: string;
  /** Its project's name as the person sees it (Hub's, its own, the slug). */
  project: string;
  /** The server agent (its tag is "Server"). */
  server?: true;
  /** When its turn ended (ISO). */
  at: string;
  link: string;
}

type AgentRecordLike = {
  id: string;
  workspace: string;
  displayName?: string;
  stoppedAt?: string;
};

/** Each agent's finished work and whether `person` has seen it. */
function finished(
  records: readonly AgentRecordLike[],
  person: string,
  d: AgentStateDeps,
  busy: ReadonlySet<string>,
  projectName: (ws: string) => string,
): { row: DoneAgent; seen: boolean }[] {
  const working = d.working();
  const out: { row: DoneAgent; seen: boolean }[] = [];
  for (const r of records) {
    if (working.has(r.id) || busy.has(r.id)) continue;
    const subject = agentSubject(r.id);
    const latest = d.seen.latest(subject);
    if (!latest) continue;
    if (r.stoppedAt && r.stoppedAt >= latest.at) continue;
    out.push({
      seen: d.seen.isSeen({ subject, person }),
      row: {
        agent: r.id,
        name: r.displayName || r.id,
        workspace: r.workspace,
        project: projectName(r.workspace),
        ...(isServerScope(r.workspace) ? { server: true as const } : {}),
        at: latest.at,
        link: `/agents?project=${encodeURIComponent(r.workspace)}&agent=${encodeURIComponent(r.id)}`,
      },
    });
  }
  return out;
}

/**
 * The bell's Done, not seen (issue 773): the agents whose last turn ended
 * after `person` last opened them, oldest first. An agent stopped after it
 * finished is left out (it is in Stopped), and so is one working or
 * waiting again (Working, Needs you).
 */
export function doneAgents(
  records: readonly AgentRecordLike[],
  person: string,
  d: AgentStateDeps,
  busy: ReadonlySet<string> = new Set(),
  projectName: (ws: string) => string = (ws) => ws,
): DoneAgent[] {
  return finished(records, person, d, busy, projectName)
    .filter((f) => !f.seen)
    .map((f) => f.row)
    .sort((a, b) => a.at.localeCompare(b.at) || a.agent.localeCompare(b.agent));
}

/** How many seen Done rows the bell's Earlier shows. */
export const SEEN_DONE_MAX = 5;

/**
 * Mock v3's Earlier: the agents whose last finished turn `person` has
 * seen ("scribe finished · acme · seen · yesterday"), newest first, at
 * most SEEN_DONE_MAX; the same ones left out as doneAgents.
 */
export function seenDoneAgents(
  records: readonly AgentRecordLike[],
  person: string,
  d: AgentStateDeps,
  busy: ReadonlySet<string> = new Set(),
  projectName: (ws: string) => string = (ws) => ws,
): DoneAgent[] {
  return finished(records, person, d, busy, projectName)
    .filter((f) => f.seen)
    .map((f) => f.row)
    .sort((a, b) => b.at.localeCompare(a.at) || a.agent.localeCompare(b.agent))
    .slice(0, SEEN_DONE_MAX);
}
