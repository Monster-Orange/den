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
  APPROVAL_TICKET_HEADER,
  ApprovalQueue,
  approverAllowed,
  newApprovalTicket,
  type Approval,
  type AskedBy,
  type Decision,
} from "./approvals.js";
import {
  criticalWhy,
  isCriticalWrite,
  type CriticalArea,
  type PolicyKind,
  writeTargets,
} from "../../shared/approval-policy.js";
import type { NotificationStore } from "../../shared/notifications.js";
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
      /** One per details line: its message key and words, when it has one. */
      detailKeys?: ({ key: string; vars?: Record<string, string> } | null)[];
      /**
       * Only the person's own Allow runs it: no auto-allow setting does
       * (a project_mode that loosens, Vision 11-14). Issue 160: this ask
       * widens what an agent may do, so it is critical.
       */
      personOnly?: boolean;
      /**
       * Issue 160: what this ask touches (secrets, deletes of data,
       * money): critical, whatever the write's placement says.
       */
      areas?: CriticalArea[];
      /** Issue 199: the agents that keep a mode of their own. */
      ownMode?: { agent: string; mode: string }[];
      /**
       * Issue 199: what the person may turn on as they Allow (off by
       * default). Never taken from an ask's args.
       */
      choices?: string[];
    }
  | { ok: false; error: string };

/**
 * Issue 199: the choices a decide's body turns on (`choices: { follow:
 * true }`): only ones the request offers, each true or false.
 */
export function chosenOf(
  a: Pick<Approval, "choices">,
  raw: unknown,
): { ok: true; chosen: Record<string, true> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, chosen: {} };
  if (typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "choices is an object: { <choice>: true }." };
  const chosen: Record<string, true> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!a.choices?.includes(k))
      return { ok: false, error: `This request offers no choice "${k}".` };
    if (typeof v !== "boolean")
      return { ok: false, error: `choices.${k} is true or false.` };
    if (v) chosen[k] = true;
  }
  return { ok: true, chosen };
}

/**
 * SRV-P1: who asked, as their credential proves it: an agent's id and the
 * project its token is for. A person's ask (no agent token): neither.
 */
export interface HeldAsker {
  agent?: string;
  project?: string;
}

export interface HeldAction {
  check(
    args: Record<string, unknown>,
    who?: HeldAsker,
  ): Promise<HeldCheck> | HeldCheck;
  /** Runs it from checked args; answers like the CLI's --json ({ ok, … }). */
  run(args: Record<string, unknown>, asked?: AskedBy): Promise<unknown>;
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
    run: async (action, args, asked) => {
      const a = actions[action];
      if (!a) return { ok: false, error: `no action ${action}` };
      const again = await a.check({ ...args });
      if (!again.ok) return { ok: false, error: again.error };
      return a.run(again.args, asked);
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
    ...(a.detailKeys ? { detailKeys: a.detailKeys } : {}),
    ...(a.note ? { note: a.note } : {}),
    ...(a.ownMode ? { ownMode: a.ownMode } : {}),
    ...(a.choices ? { choices: a.choices } : {}),
    ...(a.chosen ? { chosen: a.chosen } : {}),
    state: a.state,
    requestedAt: new Date(a.requestedAt).toISOString(),
    expiresAt: new Date(a.expiresAt).toISOString(),
    ...(a.decidedAt ? { decidedAt: new Date(a.decidedAt).toISOString() } : {}),
    ...(a.result !== undefined ? { result: a.result } : {}),
    ...(a.endedBecause ? { endedBecause: a.endedBecause } : {}),
  };
}

/** Issue 334: drop a run result's `once` part (shown to the Allow only). */
export function forgetOnce(a: Pick<Approval, "result">): void {
  const r = a.result as Record<string, unknown> | undefined;
  if (r && typeof r === "object" && "once" in r) delete r.once;
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
  deps: {
    queue: ApprovalQueue;
    actions: HeldActions;
    /** `mcp.approvals` (default on); off, nothing new is held. */
    enabled?: () => boolean;
    /**
     * SRV-1a: the setting that lets this agent's `action` run without the
     * person's Allow ("server_agent.self_update: auto"), or null. Asked
     * only for an agent its token proves, never a claim.
     */
    autoAllow?: (action: string, agent: string) => string | null;
    /**
     * Issue 160: the approval policy's kind for an agent's routine write
     * in `project` (shared/approval-policy.ts policyFor). Never asked for
     * a critical one. A bad setting throws: the write is held.
     */
    policy?: (
      action: string,
      project: string | undefined,
      widens: boolean,
      /** Issue 160: the checked args (what it is on) and what it touches. */
      ask?: { args: Record<string, unknown>; areas?: CriticalArea[] },
    ) => { kind: PolicyKind; from: string };
    /** Issue 160: a write the policy ran under notify, for the person's updates. */
    notify?: (a: Approval, project: string | undefined, from: string) => void;
    /**
     * Issue 172: an agent's write held for the person's Allow (not run by
     * the policy or a setting): alert them outside the bell, when it
     * counts (alert-rules.js): `critical` (the policy calls it critical,
     * or a critical list names it), `escalated` (the agent's own ask),
     * `targets` (what it is on, for what the person watches).
     */
    held?: (
      agent: string,
      project: string | undefined,
      why?: { critical: boolean; escalated: boolean; targets: string[] },
    ) => void;
  },
): Promise<boolean> {
  if (!isApprovalPath(pathname)) return false;
  const method = (req.method ?? "GET").toUpperCase();
  res.setHeader("Cache-Control", "no-store");
  const agent = agentPrincipalOf(req);

  if (pathname === "/api/approvals" && method === "POST") {
    let on: boolean;
    try {
      on = deps.enabled ? deps.enabled() : true;
    } catch {
      on = false;
    }
    if (!on) {
      refuse(
        res,
        403,
        "approvals_off",
        "This distribution turned the held writes off (mcp.approvals: false).",
      );
      return true;
    }
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
      (k) => k !== "action" && k !== "args" && k !== "note" && k !== "ask",
    );
    if (extra.length) {
      refuse(res, 400, "unknown_field", `Unknown field: ${extra.join(", ")}.`);
      return true;
    }
    // Issue 160: an agent may ask for any write, whatever the policy says;
    // it says why.
    if (body.ask !== undefined && typeof body.ask !== "boolean") {
      refuse(res, 400, "bad_body", "ask is true or false.");
      return true;
    }
    const askAnyway = body.ask === true;
    if (
      askAnyway &&
      !(typeof body.note === "string" && body.note.trim().length > 0)
    ) {
      refuse(
        res,
        400,
        "ask_needs_note",
        "Asking anyway needs a note: one line for the person on why.",
      );
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
    const checked = await held.check(
      args,
      agent
        ? {
            agent: agent.actor.slice("agent:".length),
            project: agent.workspace,
          }
        : {},
    );
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
    // Issue 199: a choice is the person's, made as they Allow: an ask's
    // args never carry one.
    const stored = { ...checked.args };
    for (const k of checked.choices ?? []) delete stored[k];
    // An asker with no agent token proves it is the asker with a ticket.
    const ticket = agent ? null : newApprovalTicket();
    let a: Approval;
    try {
      a = deps.queue.request({
        ...(ticket ? { ticketHash: ticket.hash } : {}),
        actor: askerOf(req),
        ...(agent ? { agent: agent.actor.slice("agent:".length) } : {}),
        action,
        args: stored,
        summary: checked.summary,
        params: checked.params,
        details: checked.details,
        ...(checked.detailKeys?.length
          ? { detailKeys: checked.detailKeys }
          : {}),
        ...(checked.ownMode?.length ? { ownMode: checked.ownMode } : {}),
        ...(checked.choices?.length ? { choices: checked.choices } : {}),
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
    // Issue 160: an agent's routine write follows the approval policy;
    // a critical one (it widens what an agent may do) never does.
    // The project it changes, else the asker's (its token's).
    const project =
      typeof stored.project === "string" ? stored.project : agent?.workspace;
    let ran: { kind: PolicyKind; from: string } | null = null;
    // Issue 160: why the policy holds it (critical, watched, …), for the asker.
    let heldBy: string | undefined;
    if (
      a.agent &&
      !askAnyway &&
      deps.policy &&
      !isCriticalWrite(action, checked.personOnly === true, checked.areas)
    ) {
      try {
        const p = deps.policy(action, project, checked.personOnly === true, {
          args: stored,
          ...(checked.areas?.length ? { areas: checked.areas } : {}),
        });
        if (p.kind !== "ask") ran = p;
        else heldBy = p.from;
      } catch {
        ran = null; // a bad setting: held, as with ask
      }
    }
    let auto: string | null = null;
    if (ran) auto = `approvals policy: ${ran.kind} (${ran.from})`;
    else
      try {
        auto =
          a.agent &&
          !checked.personOnly &&
          !checked.areas?.length &&
          !heldBy &&
          !askAnyway
            ? (deps.autoAllow?.(action, a.agent) ?? null)
            : null;
      } catch {
        auto = null; // a bad setting: held, as with ask
      }
    if (auto) {
      const r = await deps.queue.decide(a.id, "allow", `auto:${auto}`);
      recordAction(
        auditActorOf(req),
        r.ok
          ? {
              verb: "approval-decide",
              detail: `auto-allow ${action}: ${a.summary} [${a.id}] (${auto})`,
            }
          : {
              verb: "approval-decide",
              detail: `auto-allow ${action} [${a.id}] (${auto})`,
              outcome: "refused",
              reason: r.code,
            },
        principalOf(req),
      );
      if (r.ok) a = r.approval;
      // A run that failed answers the agent with its error; nothing to tell.
      const failed = (a.result as { ok?: unknown } | undefined)?.ok === false;
      if (r.ok && ran?.kind === "notify" && !failed)
        try {
          deps.notify?.(a, project, ran.from);
        } catch {
          /* the bell is best effort: the trail has it */
        }
    } else if (a.agent && a.state === "pending")
      try {
        deps.held?.(a.agent, project, {
          critical:
            isCriticalWrite(
              action,
              checked.personOnly === true,
              checked.areas,
            ) || /(^|\s)approvals\.critical$/.test(heldBy ?? ""),
          escalated: askAnyway,
          targets: writeTargets(action, stored, project),
        });
      } catch {
        /* an alert is best effort: the Allow dialog still asks */
      }
    sendJson(
      res,
      {
        ok: true,
        ...approvalView(a),
        ...(a.state === "pending" && a.agent && !askAnyway
          ? {
              askedBecause:
                heldBy ??
                criticalWhy(
                  action,
                  checked.personOnly === true,
                  checked.areas,
                ) ??
                undefined,
            }
          : {}),
        ...(ticket ? { ticket: ticket.ticket } : {}),
      },
      202,
    );
    return true;
  }

  if (
    pathname === "/api/approvals" &&
    (method === "GET" || method === "HEAD")
  ) {
    // An agent: its own requests and their outcomes, never another's.
    if (agent) {
      sendJson(res, {
        ok: true,
        mine: deps.queue.ofActor(agent.actor).map(approvalView),
      });
      return true;
    }
    // `?count=1`: how many wait, and nothing else, for a page that holds no
    // approval key (it says "sign in to see it" without a refusal a poll
    // would log every 3 s).
    if (new URL(req.url ?? "/", "http://x").searchParams.get("count") === "1") {
      sendJson(res, { ok: true, waiting: deps.queue.pending().length });
      return true;
    }
    const who = approverAllowed(req, guard, "read");
    if (!who.ok) {
      // How many wait, so a signed-out page can say "sign in to see it";
      // never what they are.
      sendJson(
        res,
        {
          ok: false,
          code: who.code,
          error:
            "What waits for the person is theirs to see: a signed-in browser holding its approval key.",
          waiting: deps.queue.pending().length,
        },
        403,
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
    // An agent sees its own requests only; an anonymous asker the one it
    // holds the ticket for; the person any. Anything else is "no such request".
    const ticket = req.headers[APPROVAL_TICKET_HEADER];
    const mayRead =
      !!a &&
      (agent
        ? a.actor === agent.actor
        : deps.queue.ticketMatches(
            a.id,
            typeof ticket === "string" ? ticket : undefined,
          ) || approverAllowed(req, guard, "read").ok);
    if (!a || !mayRead) {
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
    // Issue 199: the choices the person turned on, offered ones only.
    const found = deps.queue.get(dec[1]);
    const pick = found
      ? chosenOf(found, body?.choices)
      : { ok: true as const, chosen: {} };
    if (!pick.ok) {
      refuse(res, 400, "bad_choice", pick.error);
      return true;
    }
    const r = await deps.queue.decide(
      dec[1],
      decision as Decision,
      who.session,
      pick.chosen,
    );
    // A repeat (a double-click, a retry) replays the first answer: the
    // first one's audit line stands alone.
    if (!(r.ok && r.repeat))
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
    if (r.ok) {
      sendJson(res, { ok: true, ...approvalView(r.approval) });
      // Issue 334: what a run shows once (a new app key) went to this
      // Allow's browser only: never again, to anyone.
      forgetOnce(r.approval);
    } else
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

/**
 * Issue 160: the person's updates say what an agent did under the approval
 * policy's notify, one item per write (never folded into another).
 */
export function notePolicyRun(
  store: Pick<NotificationStore, "add">,
  a: Pick<Approval, "id" | "agent" | "summary">,
  project: string | undefined,
): void {
  const name = a.agent ?? "An agent";
  store.add({
    kind: "service",
    subject: `record:approval-${a.id}`,
    scope: `workspace/${project ?? "den-server"}`,
    text: `${name} did this without your Allow: ${a.summary}`,
    msg: { key: "bell.m.policyRan", vars: { name, what: a.summary } },
    link: "/agents",
  });
}
