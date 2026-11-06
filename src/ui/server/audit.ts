/**
 * The action audit trail: every service exec, test run and sync, with who
 * asked (a person in the UI, or an agent through `<cli> mcp`). Each action
 * becomes a lifecycle line in the server log, the stream the /logs page shows
 * as the web-server log, so agent actions sit beside the UI's own; the
 * structured entries are kept in a small in-memory ring.
 */
import * as path from "path";
import {
  actorLabel,
  WORKSPACE_NAME_RE,
  type Actor,
  type AgentActor,
} from "../../shared/agent-actor.js";

export { actorFromHeaders } from "../../shared/agent-actor.js";

export interface AuditEntry {
  ts: string;
  /** "agent" only for an agent's actor token (SEC-1c); a claim never is. */
  actor: "agent" | "user";
  /**
   * Who the request's credential proves it is: `person:<os user>` for the
   * person token or a signed-in browser, `agent:<id>` for an actor token
   * (SEC-1c). From the credential only, never from a header the caller
   * sets; absent for a call without one.
   */
  principal?: string;
  /**
   * SEC-1c: what the caller's x-den-actor headers claimed, when no actor
   * token proved it (unverified is then set). A label, never the actor.
   */
  claimed?: {
    agent?: string;
    workspace?: string;
    client: string;
    clientVersion: string;
    mcpPid: number | null;
    session: string;
  };
  unverified?: true;
  client?: string;
  clientVersion?: string;
  mcpPid?: number | null;
  session?: string;
  /** A scoped MCP server's actor, `agent:<id>` (AG-2a-core). */
  agent?: string;
  /** The workspace that scoped server is pinned to. */
  workspace?: string;
  /**
   * The other workspace a call reached under a grant (`agents.<id>.grants`,
   * AG-2a); `workspace` is the agent's own.
   */
  targetWorkspace?: string;
  /** exec | run | sync, or the MCP tool name for a refused non-lifecycle call */
  verb: string;
  detail: string;
  /** Set when the action never ran: a guard or the server refused it. */
  outcome?: "refused";
  /** Why it was refused (first line). */
  reason?: string;
  /**
   * The services (`repo/service`) or repos a refused non-lifecycle call
   * named, so each one's activity list shows it (`GET /api/activity`).
   */
  addresses?: string[];
}

type Sink = (line: string, actor: AgentActor | null) => void;

const RING_MAX = 200;
const ring: AuditEntry[] = [];
let sink: Sink | null = null;

/** Where audit lines go (the server log); null to disconnect. */
export function setAuditSink(fn: Sink | null): void {
  sink = fn;
}

/** " · by agent …" for an agent, "" for a person. */
export function actorSuffix(actor: Actor): string {
  return actor ? ` · by ${actorLabel(actor)}` : "";
}

export function recordAction(
  actor: Actor,
  action: {
    verb: string;
    detail: string;
    outcome?: "refused";
    reason?: string;
    addresses?: string[];
    targetWorkspace?: string;
  },
  /** The credential's actor (request-guard principalOf). */
  principal?: string,
): AuditEntry {
  const claim = actor?.unverified ? actor : null;
  const verified = actor && !actor.unverified ? actor : null;
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    actor: verified ? "agent" : "user",
    ...(principal ? { principal } : {}),
    ...(claim
      ? {
          claimed: {
            ...(claim.agent ? { agent: claim.agent } : {}),
            ...(claim.workspace ? { workspace: claim.workspace } : {}),
            client: claim.client,
            clientVersion: claim.clientVersion,
            mcpPid: claim.mcpPid,
            session: claim.session,
          },
          unverified: true as const,
        }
      : {}),
    ...(verified
      ? {
          client: verified.client,
          clientVersion: verified.clientVersion,
          mcpPid: verified.mcpPid,
          session: verified.session,
          ...(verified.agent ? { agent: verified.agent } : {}),
          ...(verified.workspace ? { workspace: verified.workspace } : {}),
        }
      : {}),
    ...(action.targetWorkspace
      ? { targetWorkspace: action.targetWorkspace }
      : {}),
    verb: action.verb,
    detail: action.detail,
    ...(action.outcome ? { outcome: action.outcome } : {}),
    ...(action.reason ? { reason: clean(action.reason, 300) } : {}),
    ...(action.addresses?.length ? { addresses: action.addresses } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  const mark = entry.outcome === "refused" ? "✗" : "▶";
  const why = entry.reason ? ` — refused: ${entry.reason}` : "";
  // A refusal whose detail is its reason names what it touched instead.
  const what = entry.addresses
    ? entry.addresses.join(", ")
    : entry.reason && action.detail === entry.reason
      ? ""
      : action.detail;
  sink?.(
    `${mark} ${action.verb}${what ? ` ${what}` : ""}${why}${actorSuffix(actor)}` +
      (principal && !verified ? ` · as ${principal}` : ""),
    actor,
  );
  return entry;
}

/** One line, printable characters only, at most `max` long. */
function clean(v: unknown, max: number): string {
  const line = String(v ?? "").split(/[\r\n]/)[0];
  return [...line]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join("")
    .slice(0, max);
}

const SAFE_PART = /^[A-Za-z0-9._-]{1,128}$/;
const LIFECYCLE_TOOL = /^service_(up|down|restart)$/;
/** At most this many targets of one refused call are recorded. */
const MAX_ADDRESSES = 40;

/** `repo/service` (or `repo`) when every part is a safe name, else "". */
function safeAddress(repo: string, service = ""): string {
  if (!SAFE_PART.test(repo)) return "";
  return service && SAFE_PART.test(service) ? `${repo}/${service}` : repo;
}

/**
 * What a refused call named: its `repo` (with `service`), else each of its
 * `targets` (`repo/service`, as logs_search takes them), deduplicated.
 */
function refusedAddresses(report: {
  repo?: unknown;
  service?: unknown;
  targets?: unknown;
}): string[] {
  const out: string[] = [];
  if (typeof report.repo === "string") {
    const a = safeAddress(
      report.repo,
      typeof report.service === "string" ? report.service : "",
    );
    if (a) out.push(a);
  }
  if (Array.isArray(report.targets))
    for (const t of report.targets.slice(0, MAX_ADDRESSES)) {
      if (typeof t !== "string") continue;
      const slash = t.lastIndexOf("/");
      const a =
        slash > 0
          ? safeAddress(t.slice(0, slash), t.slice(slash + 1))
          : safeAddress(t);
      if (a && !out.includes(a)) out.push(a);
    }
  return out;
}

/**
 * An MCP guard refused an agent's call before it reached an action route.
 * The agent's own report, so every field is sanitised: a lifecycle tool with
 * a valid repo becomes an "exec" entry for that service (what the panel's
 * activity list shows); anything else is recorded under the tool's name,
 * with the refusal as its detail and the services it named as `addresses`.
 */
export function recordAgentRefusal(
  actor: Actor,
  report: {
    tool?: unknown;
    repo?: unknown;
    service?: unknown;
    targets?: unknown;
    reason?: unknown;
  },
  principal?: string,
): AuditEntry {
  const tool = clean(report.tool, 64).replace(/[^A-Za-z0-9_]/g, "") || "tool";
  const repo = typeof report.repo === "string" ? report.repo : "";
  const service = typeof report.service === "string" ? report.service : "";
  const lifecycle = LIFECYCLE_TOOL.exec(tool);
  const reason = clean(report.reason, 300) || "refused";
  if (lifecycle && SAFE_PART.test(repo)) {
    const address =
      service && SAFE_PART.test(service) ? `${repo}/${service}` : repo;
    return recordAction(
      actor,
      {
        verb: "exec",
        detail: `${address} ${lifecycle[1]} (local)`,
        outcome: "refused",
        reason,
      },
      principal,
    );
  }
  // Any other tool: the refusal is the detail, under every service or repo
  // the call named (all of a logs_search's targets, in one entry).
  return recordAction(
    actor,
    {
      verb: tool,
      detail: reason,
      outcome: "refused",
      reason,
      addresses: refusedAddresses(report),
    },
    principal,
  );
}

/**
 * A scoped agent's call into a workspace it holds a grant for (AG-2a, AG
 * spec §5b), reported by its MCP server before the call runs. Recorded
 * with both workspaces: the agent's own (from its headers) and the target.
 * Null, and nothing recorded, unless the actor is a scoped agent and the
 * target is a well-formed workspace other than its own. `GET /api/activity
 * ?address=workspace:<ws>` lists it under either workspace.
 */
export function recordCrossWorkspace(
  actor: Actor,
  report: { tool?: unknown; crossWorkspace?: unknown },
  principal?: string,
): AuditEntry | null {
  if (!actor?.agent || !actor.workspace) return null;
  const target =
    typeof report.crossWorkspace === "string" ? report.crossWorkspace : "";
  if (!WORKSPACE_NAME_RE.test(target) || target === actor.workspace)
    return null;
  const tool = clean(report.tool, 64).replace(/[^A-Za-z0-9_]/g, "") || "tool";
  return recordAction(
    actor,
    {
      verb: tool,
      detail: `in workspace ${target}, under a grant to ${actor.agent} of workspace ${actor.workspace}`,
      targetWorkspace: target,
    },
    principal,
  );
}

/**
 * The catalog repo a refused call's `path` is inside (manifest_validate), so
 * the refusal shows in that repo's activity: the repo whose checkout is the
 * path or holds it, the deepest when checkouts nest. Null for a relative
 * path or one inside no repo. The path itself is never recorded.
 */
export function repoAtPath(
  p: unknown,
  repos: readonly { repoName: string; repoPath: string }[],
): string | null {
  if (typeof p !== "string" || p.length > 4096 || !path.isAbsolute(p))
    return null;
  const target = path.resolve(p);
  let best: { repoName: string; depth: number } | null = null;
  for (const r of repos) {
    if (!r.repoPath || !path.isAbsolute(r.repoPath)) continue;
    const root = path.resolve(r.repoPath);
    if (target !== root && !target.startsWith(root + path.sep)) continue;
    if (!best || root.length > best.depth)
      best = { repoName: r.repoName, depth: root.length };
  }
  return best && SAFE_PART.test(best.repoName) ? best.repoName : null;
}

/** The most recent actions, oldest first. */
export function recentActions(): AuditEntry[] {
  return ring.slice();
}
