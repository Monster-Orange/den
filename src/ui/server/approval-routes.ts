/**
 * ON-3's held writes (0.4.15; ON-SPEC ON-3 and the 2026-11-07 decisions):
 * an agent's change waits for the person, and runs only on their Allow.
 *
 *   POST /api/approvals               { action, args, note? }: hold one
 *                                     (anyone who may reach the server; an
 *                                     agent's own MCP tools call it)
 *   GET  /api/approvals               what waits, for the person's dialog
 *                                     (never an agent's token)
 *   GET  /api/approvals/<id>          one request: the asker's own, or the
 *                                     person's
 *   POST /api/approvals/<id>/decide   { decision: allow | deny }: the
 *                                     person's signed-in browser only
 *                                     (approvals.ts approverAllowed)
 *
 * The dialog's words are Den's: each action's check() turns the args into
 * a line, its parts and the Review lines, and refuses bad args before
 * anything waits. The agent's note is only ever shown quoted. Allow runs
 * the action from the args stored when it was asked, after checking them
 * again (the world may have changed while it waited). Every ask and every
 * decision is in the activity trail.
 */
import type * as http from "http";
import { agentTokenLive } from "../../shared/actor-token.js";
import {
  ApprovalQueue,
  approverAllowed,
  type Approval,
  type Decision,
} from "./approvals.js";
import { recordAction } from "./audit.js";
import { readBody, sendJson } from "./http-helpers.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
  type GuardResult,
} from "./request-guard.js";

export type HeldCheck =
  | {
      ok: true;
      /** The args as they will run (normalized). */
      args: Record<string, unknown>;
      /** One plain line: what it will do ("create the workspace \"web\""). */
      summary: string;
      /** The line's parts, for a page to word it in its own language. */
      params: Record<string, string>;
      /** Review: what it will do, line by line. */
      details: string[];
    }
  | { ok: false; error: string };

export interface HeldAction {
  check(args: Record<string, unknown>): Promise<HeldCheck> | HeldCheck;
  /** Runs it from checked args; answers like the CLI's --json ({ ok, … }). */
  run(args: Record<string, unknown>): Promise<unknown>;
}

export type HeldActions = Readonly<Record<string, HeldAction>>;

/** The queue, its run being the action's, with the args checked again. */
export function createApprovalQueue(
  actions: HeldActions,
  stateDir: () => string,
  o: { ttlMs?: number; now?: () => number } = {},
): ApprovalQueue {
  return new ApprovalQueue({
    ...o,
    // An agent with no live token (stopped, `web logout --all`) is gone.
    actorLive: (actor) =>
      !actor.startsWith("agent:") ||
      agentTokenLive(stateDir(), actor.slice("agent:".length)),
    run: async (action, args) => {
      const a = actions[action];
      if (!a) return { ok: false, error: `no action ${action}` };
      const again = await a.check({ ...args });
      if (!again.ok) return { ok: false, error: again.error };
      return a.run(again.args);
    },
  });
}

const ONE_PATH = /^\/api\/approvals\/([A-Za-z0-9_-]{16})$/;
const DECIDE_PATH = /^\/api\/approvals\/([A-Za-z0-9_-]{16})\/decide$/;

/** Whether `pathname` is one of the routes above. */
export function isApprovalPath(pathname: string): boolean {
  return (
    pathname === "/api/approvals" ||
    ONE_PATH.test(pathname) ||
    DECIDE_PATH.test(pathname)
  );
}

/** Who asked: the credential's actor, else this machine's anonymous caller. */
function askerOf(req: http.IncomingMessage): string {
  return principalOf(req) ?? "loopback";
}

/** What a page or the asking agent sees of one request. */
export function approvalView(a: Approval): Record<string, unknown> {
  return {
    id: a.id,
    action: a.action,
    ...(a.agent ? { agent: a.agent } : {}),
    summary: a.summary,
    ...(a.params ? { params: a.params } : {}),
    ...(a.details ? { details: a.details } : {}),
    ...(a.note ? { note: a.note } : {}),
    state: a.state,
    requestedAt: new Date(a.requestedAt).toISOString(),
    expiresAt: new Date(a.expiresAt).toISOString(),
    ...(a.decidedAt ? { decidedAt: new Date(a.decidedAt).toISOString() } : {}),
    ...(a.result !== undefined ? { result: a.result } : {}),
    ...(a.endedBecause ? { endedBecause: a.endedBecause } : {}),
  };
}

async function jsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBody(req);
    if (raw.length > 32 * 1024) return null;
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const refuse = (
  res: http.ServerResponse,
  status: number,
  code: string,
  error: string,
): void => sendJson(res, { ok: false, code, error }, status);

/** Handles the routes above; false when `pathname` is not one of them. */
export async function handleApprovalRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  guard: Extract<GuardResult, { ok: true }>,
  deps: { queue: ApprovalQueue; actions: HeldActions },
): Promise<boolean> {
  if (!isApprovalPath(pathname)) return false;
  const method = (req.method ?? "GET").toUpperCase();
  res.setHeader("Cache-Control", "no-store");
  const agent = agentPrincipalOf(req);

  if (pathname === "/api/approvals" && method === "POST") {
    const body = await jsonBody(req);
    if (!body) {
      refuse(
        res,
        400,
        "bad_body",
        "The body must be JSON: { action, args, note? }.",
      );
      return true;
    }
    const extra = Object.keys(body).filter(
      (k) => k !== "action" && k !== "args" && k !== "note",
    );
    if (extra.length) {
      refuse(res, 400, "unknown_field", `Unknown field: ${extra.join(", ")}.`);
      return true;
    }
    const action = typeof body.action === "string" ? body.action : "";
    const held = Object.hasOwn(deps.actions, action)
      ? deps.actions[action]
      : undefined;
    if (!held) {
      refuse(
        res,
        400,
        "unknown_action",
        `Den holds ${Object.keys(deps.actions).join(", ")} for the person; not "${action}".`,
      );
      return true;
    }
    const args =
      body.args && typeof body.args === "object" && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {};
    const checked = await held.check(args);
    if (!checked.ok) {
      recordAction(
        auditActorOf(req),
        {
          verb: "approval-ask",
          detail: action,
          outcome: "refused",
          reason: checked.error,
        },
        principalOf(req),
      );
      refuse(res, 400, "invalid_args", checked.error);
      return true;
    }
    let a: Approval;
    try {
      a = deps.queue.request({
        actor: askerOf(req),
        ...(agent ? { agent: agent.actor.slice("agent:".length) } : {}),
        action,
        args: checked.args,
        summary: checked.summary,
        params: checked.params,
        details: checked.details,
        note: typeof body.note === "string" ? body.note : undefined,
      });
    } catch (e) {
      refuse(res, 429, "too_many_waiting", (e as Error).message);
      return true;
    }
    recordAction(
      auditActorOf(req),
      { verb: "approval-ask", detail: `${action}: ${a.summary} [${a.id}]` },
      principalOf(req),
    );
    sendJson(res, { ok: true, ...approvalView(a) }, 202);
    return true;
  }

  if (
    pathname === "/api/approvals" &&
    (method === "GET" || method === "HEAD")
  ) {
    if (agent) {
      refuse(
        res,
        403,
        "person_only",
        "What waits for the person is theirs to see; an agent checks its own request with approval_check.",
      );
      return true;
    }
    sendJson(res, {
      ok: true,
      pending: deps.queue.pending().map(approvalView),
    });
    return true;
  }

  const one = ONE_PATH.exec(pathname);
  if (one && (method === "GET" || method === "HEAD")) {
    const a = deps.queue.get(one[1]);
    // An agent sees its own requests only; another's is "no such request".
    if (!a || (agent && a.actor !== agent.actor)) {
      refuse(
        res,
        404,
        "not_found",
        "No such request (it may have ended at a restart).",
      );
      return true;
    }
    sendJson(res, { ok: true, ...approvalView(a) });
    return true;
  }

  const dec = DECIDE_PATH.exec(pathname);
  if (dec && method === "POST") {
    const who = approverAllowed(req, guard);
    if (!who.ok) {
      recordAction(
        auditActorOf(req),
        {
          verb: "approval-decide",
          detail: dec[1],
          outcome: "refused",
          reason: who.code,
        },
        principalOf(req),
      );
      refuse(res, 403, who.code, who.error);
      return true;
    }
    const body = await jsonBody(req);
    const decision = body?.decision;
    if (decision !== "allow" && decision !== "deny") {
      refuse(res, 400, "bad_decision", 'decision is "allow" or "deny".');
      return true;
    }
    const r = await deps.queue.decide(
      dec[1],
      decision as Decision,
      who.session,
    );
    recordAction(
      auditActorOf(req),
      r.ok
        ? {
            verb: "approval-decide",
            detail: `${decision} ${r.approval.action}: ${r.approval.summary} [${dec[1]}]`,
          }
        : {
            verb: "approval-decide",
            detail: `${decision} [${dec[1]}]`,
            outcome: "refused",
            reason: r.code,
          },
      principalOf(req),
    );
    if (r.ok) sendJson(res, { ok: true, ...approvalView(r.approval) });
    else
      refuse(
        res,
        r.code === "not_found" ? 404 : r.code === "expired" ? 410 : 409,
        r.code,
        r.error,
      );
    return true;
  }

  res.writeHead(405, { Allow: "GET, POST" });
  res.end();
  return true;
}
