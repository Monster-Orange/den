import { isServerScope } from "../../shared/agents/server-agent.js";
import type * as http from "http";
import { agentSeenSubject, type SeenMarks } from "../../shared/seen-mark.js";
import { principalOf } from "./request-guard.js";
import { FIXTURE_PRINCIPAL } from "../../shared/fixture-person.js";
import { osUser } from "../../shared/web-secret.js";

export type AgentAttn = "needs" | "done" | "working" | "idle";

export interface AgentStateDeps {
  seen: SeenMarks;
  working: () => ReadonlyMap<string, number>;
  waitingSince?: (agent: string) => string | undefined;
  waitingWhat?: (agent: string) => string | undefined;
}

export const agentSubject = agentSeenSubject;

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
  activity?: string;
}

export function agentStateOf(
  row: RowLike,
  person: string,
  d: AgentStateDeps,
): { attn: AgentAttn; attnSince?: string; attnWhat?: string } | null {
  if (row.kind !== "agent" || !row.agent || row.state !== "running")
    return null;
  const id = row.agent;
  const needs = !!row.waiting && row.waitingWhy !== "input";
  const workingAt = row.activity === "idle" ? undefined : d.working().get(id);
  const latest = d.seen.latest(agentSubject(id));
  const done =
    !!latest && !d.seen.isSeen({ subject: agentSubject(id), person });
  const attn: AgentAttn = needs
    ? "needs"
    : workingAt !== undefined || row.activity === "working"
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
  project: string;
  server?: true;
  at: string;
  link: string;
}

type AgentRecordLike = {
  id: string;
  workspace: string;
  displayName?: string;
  stoppedAt?: string;
};

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

export const SEEN_DONE_MAX = 5;

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
