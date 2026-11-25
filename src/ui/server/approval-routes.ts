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
import { actorFromHeaders } from "../../shared/agent-actor.js";
import type * as http from "http";
import { agentTokenLive } from "../../shared/actor-token.js";
import {
  APPROVAL_TICKET_HEADER,
  ApprovalQueue,
  approverAllowed,
  claimantIsPerson,
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
  type SettingCategory,
} from "../../shared/approval-policy.js";
import type { InstallMode } from "../../shared/den-config.js";
import type { NotificationStore } from "../../shared/notifications.js";
import { recordAction } from "./audit.js";
import { readBody, sendJson } from "./http-helpers.js";
import { allowLink } from "../../shared/agent-links.js";
import {
  agentPrincipalOf,
  auditActorOf,
  operatorActOf,
  principalOf,
  type GuardResult,
} from "./request-guard.js";
import {
  OPERATOR_HELD_ACTIONS,
  OPERATOR_PRINCIPAL,
} from "../../shared/test-operator.js";

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
      /** Issue 1371 Part 2: a setting_change's category, for the policy. */
      category?: SettingCategory;
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
    /** The check again before the run, at the person's Allow. */
    o?: { again?: boolean },
  ): Promise<HeldCheck> | HeldCheck;
  /** Runs it from checked args; answers like the CLI's --json ({ ok, … }). */
  run(args: Record<string, unknown>, asked?: AskedBy): Promise<unknown>;
}

export type HeldActions = Readonly<Record<string, HeldAction>>;

/** The queue, its run being the action's, with the args checked again. */
export function createApprovalQueue(
  actions: HeldActions,
  stateDir: () => string,
  o: {
    /** Issue 742: the wait, read at each ask (held_writes.wait_minutes). */
    ttlMs?: number | (() => number);
    now?: () => number;
    /** Issue 746: a request ended unanswered. */
    onExpire?: (a: Approval) => void;
    /** Issue 742: the file the queue is kept in, under the state dir. */
    file?: string;
    /** Issue 742: a restart lost a request (null: the file was unreadable). */
    onLost?: (a: Approval | null, why: string) => void;
  } = {},
): ApprovalQueue {
  return new ApprovalQueue({
    ...o,
    // Issue 742: a request read back for an action this Den lacks is lost.
    knownAction: (action) => Object.hasOwn(actions, action),
    // An agent with no live token (stopped, `web logout --all`) is gone.
    actorLive: (actor) =>
      !actor.startsWith("agent:") ||
      agentTokenLive(stateDir(), actor.slice("agent:".length)),
    run: async (action, args, asked) => {
      const a = actions[action];
      if (!a) return { ok: false, error: `no action ${action}` };
      const again = await a.check({ ...args }, undefined, { again: true });
      if (!again.ok) return { ok: false, error: again.error };
      return a.run(again.args, asked);
    },
  });
}

const ONE_PATH = /^\/api\/approvals\/([A-Za-z0-9_-]{16})$/;
const DECIDE_PATH = /^\/api\/approvals\/([A-Za-z0-9_-]{16})\/decide$/;
/** Issue 142: the asker takes back its own request. */
const WITHDRAW_PATH = /^\/api\/approvals\/([A-Za-z0-9_-]{16})\/withdraw$/;

/** Whether `pathname` is one of the routes above. */
export function isApprovalPath(pathname: string): boolean {
  return (
    pathname === "/api/approvals" ||
    ONE_PATH.test(pathname) ||
    DECIDE_PATH.test(pathname) ||
    WITHDRAW_PATH.test(pathname)
  );
}

/** Issue 142: tell the bell what waits changed; best effort. */
function changed(deps: { changed?: () => void }): void {
  try {
    deps.changed?.();
  } catch {
    /* the bell is best effort: the queue and the trail have it */
  }
}

/** Who asked: the credential's actor, else this machine's anonymous caller. */
function askerOf(req: http.IncomingMessage): string {
  return principalOf(req) ?? "loopback";
}

/**
 * The agent a request with no agent token claims to be (the
 * audit headers a person's own `mcp --actor agent:<id>` sends), kept only
 * when well-formed (actorFromHeaders drops a malformed id). Never verified.
 */
function claimedAgentOf(req: http.IncomingMessage): { claimedAs?: string } {
  // Only on a verified person's own ask (a person's token or the OS user's
  // browser). Anonymous asks ("loopback": any local program with no
  // credential), the fixture person, the test operator and an agent's view
  // send the headers too, but their claim would read as "You asked".
  if (!claimantIsPerson(principalOf(req))) return {};
  const c = actorFromHeaders(req.headers);
  return c?.kind === "agent" && c.agent ? { claimedAs: c.agent } : {};
}

/**
 * Issue 621: a run result's part for its asker only (a new runner token),
 * `forAsker`. Every view leaves it out; the asker's own read of the
 * request has it once, merged into the result (forgetForAsker after).
 */
function resultFor(a: Approval, asker: boolean): unknown {
  const r = a.result as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || !("forAsker" in r)) return a.result;
  const { forAsker, ...rest } = r;
  return asker && forAsker && typeof forAsker === "object"
    ? { ...rest, ...(forAsker as Record<string, unknown>) }
    : rest;
}

/** Issue 621: drop a run result's `forAsker` part, once its asker has it. */
export function forgetForAsker(a: Pick<Approval, "result">): void {
  const r = a.result as Record<string, unknown> | undefined;
  if (r && typeof r === "object" && "forAsker" in r) delete r.forAsker;
}

/**
 * What a page or the asking agent sees of one request. `asker`: the
 * asker's own read (issue 621: it holds the run's forAsker part).
 */
export function approvalView(
  a: Approval,
  o: { asker?: boolean } = {},
): Record<string, unknown> {
  return {
    id: a.id,
    action: a.action,
    ...(a.agent ? { agent: a.agent } : {}),
    ...(a.claimedAs && claimantIsPerson(a.actor)
      ? { claimedAs: a.claimedAs }
      : {}),
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
    ...(a.result !== undefined
      ? { result: resultFor(a, o.asker === true) }
      : {}),
    ...(a.endedBecause ? { endedBecause: a.endedBecause } : {}),
    // Issue 746: why it ended, and what the asker can do.
    ...(a.state === "expired"
      ? {
          reason:
            "Lapsed unanswered: the person did not answer before it expired. Nothing ran. Ask again if it is still needed.",
        }
      : {}),
    // A finished one read from its small record: how it ended, and when.
    ...(a.ended &&
    (a.state === "done" || a.state === "denied" || a.state === "withdrawn")
      ? {
          reason: `${a.state === "done" ? "Done" : a.state === "denied" ? "Denied" : "Withdrawn"} at ${new Date(a.decidedAt ?? a.expiresAt).toISOString()}. Den keeps how it ended and whether it worked, not what it returned.`,
        }
      : {}),
    // Issue 742: a restart could not bring it back; never silently gone.
    ...(a.state === "lost"
      ? {
          reason: `Lost at a restart: ${a.lostBecause ?? "Den could not bring it back."} Nothing ran from here. Ask again if it is still needed.`,
        }
      : {}),
  };
}

/**
 * Issue 1016: an agent's pending request's full Allow link, on web.url
 * (`{ allowLink }`), or nothing when it isn't set or can't be read.
 */
function allowLinkOf(
  a: Pick<Approval, "agent" | "state">,
  project: string | undefined,
  webUrl: (() => string | null) | undefined,
): { allowLink?: string } {
  if (!a.agent || a.state !== "pending" || !webUrl) return {};
  let url: string | null;
  try {
    url = webUrl();
  } catch {
    return {};
  }
  const link = allowLink(url, a.agent, project);
  return link ? { allowLink: link } : {};
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

/**
 * Issue 110: ask for a held write, as POST /api/approvals does, and say
 * what to answer. The route answers with it; the Coach's Apply asks
 * through it too, so a held write has one path: the same checks, queue,
 * audit and policy.
 */
export async function askHeld(
  req: http.IncomingMessage,
  deps: ApprovalRouteDeps,
  body: Record<string, unknown> | null,
  /** Issue 110: Den's own callers only (never from a request's body). */
  opts: { coach?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const agent = agentPrincipalOf(req);
  const refused = (status: number, code: string, error: string) => ({
    status,
    body: { ok: false, code, error } as Record<string, unknown>,
  });
  let on: boolean;
  try {
    on = deps.enabled ? deps.enabled() : true;
  } catch {
    on = false;
  }
  if (!on) {
    return refused(
      403,
      "approvals_off",
      "This distribution turned the held writes off (mcp.approvals: false).",
    );
  }
  if (!body) {
    return refused(
      400,
      "bad_body",
      "The body must be JSON: { action, args, note? }.",
    );
  }
  const extra = Object.keys(body).filter(
    (k) => k !== "action" && k !== "args" && k !== "note" && k !== "ask",
  );
  if (extra.length) {
    return refused(400, "unknown_field", `Unknown field: ${extra.join(", ")}.`);
  }
  // Issue 160: an agent may ask for any write, whatever the policy says;
  // it says why.
  if (body.ask !== undefined && typeof body.ask !== "boolean") {
    return refused(400, "bad_body", "ask is true or false.");
  }
  const askAnyway = body.ask === true;
  if (
    askAnyway &&
    !(typeof body.note === "string" && body.note.trim().length > 0)
  ) {
    return refused(
      400,
      "ask_needs_note",
      "Asking anyway needs a note: one line for the person on why.",
    );
  }
  const action = typeof body.action === "string" ? body.action : "";
  const held = Object.hasOwn(deps.actions, action)
    ? deps.actions[action]
    : undefined;
  if (!held) {
    return refused(
      400,
      "unknown_action",
      `Den holds ${Object.keys(deps.actions).join(", ")} for the person; not "${action}".`,
    );
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
    return refused(400, "invalid_args", checked.error);
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
      // A person's own scoped server's --actor, unverified.
      ...(agent ? {} : claimedAgentOf(req)),
      action,
      args: stored,
      summary: checked.summary,
      params: checked.params,
      details: checked.details,
      ...(checked.detailKeys?.length ? { detailKeys: checked.detailKeys } : {}),
      ...(checked.ownMode?.length ? { ownMode: checked.ownMode } : {}),
      ...(checked.choices?.length ? { choices: checked.choices } : {}),
      note: typeof body.note === "string" ? body.note : undefined,
      ...(opts.coach ? { coach: opts.coach } : {}),
    });
  } catch (e) {
    return refused(429, "too_many_waiting", (e as Error).message);
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
  let mode: InstallMode = "strict";
  try {
    mode = deps.installMode?.() ?? "strict";
  } catch {
    mode = "strict"; // a bad setting: today's asks
  }
  if (
    a.agent &&
    !askAnyway &&
    deps.policy &&
    !isCriticalWrite(action, checked.personOnly === true, checked.areas, mode)
  ) {
    try {
      const p = deps.policy(action, project, checked.personOnly === true, {
        args: stored,
        ...(checked.areas?.length ? { areas: checked.areas } : {}),
        ...(checked.category ? { category: checked.category } : {}),
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
          ? (deps.autoAllow?.(action, a.agent, agent?.workspace) ?? null)
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
      deps.held?.(a.agent, project);
    } catch {
      /* an alert is best effort: the Allow dialog still asks */
    }
  changed(deps);
  return {
    status: 202,
    body: {
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
                mode,
              ) ??
              undefined,
          }
        : {}),
      ...(ticket ? { ticket: ticket.ticket } : {}),
      ...allowLinkOf(a, agent?.workspace, deps.webUrl),
    },
  };
}

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
    /** The asker's agent id and its token's scope (workspace). */
    autoAllow?: (
      action: string,
      agent: string,
      workspace: string | undefined,
    ) => string | null;
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
      ask?: {
        args: Record<string, unknown>;
        areas?: CriticalArea[];
        category?: SettingCategory;
      },
    ) => { kind: PolicyKind; from: string };
    /**
     * Issue 1391: the install's mode (user.yml install_mode), read per ask.
     * Not given, or a bad value: strict, today's asks.
     */
    installMode?: () => InstallMode;
    /** Issue 160: a write the policy ran under notify, for the person's updates. */
    notify?: (a: Approval, project: string | undefined, from: string) => void;
    /**
     * Issue 172: an agent's write held for the person's Allow (not run by
     * the policy or a setting): alert them outside the bell.
     */
    held?: (agent: string, project: string | undefined) => void;
    /**
     * Issue 142: what waits changed (asked, decided, withdrawn): the bell's
     * held-write items follow the queue (held-bell.ts).
     */
    changed?: () => void;
    /**
     * Issue 1016: the install's address for people (web.url), or null
     * when it isn't set: an agent's pending ask carries its full Allow
     * link on it, never a guessed one.
     */
    webUrl?: () => string | null;
    /**
     * Issue 1414: whether a held write's asker (`agent:<id>`) is one of a
     * test bed's own agents (test-operator.ts testBedAsker). Only then may
     * the test operator Allow it. Not given: the operator Allows nothing.
     */
    testBedAsker?: (actor: string) => boolean;
  },
): Promise<boolean> {
  if (!isApprovalPath(pathname)) return false;
  const method = (req.method ?? "GET").toUpperCase();
  res.setHeader("Cache-Control", "no-store");
  const agent = agentPrincipalOf(req);

  if (pathname === "/api/approvals" && method === "POST") {
    const r = await askHeld(req, deps, await jsonBody(req));
    sendJson(res, r.body, r.status);
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
        mine: deps.queue.ofActor(agent.actor).map((x) => approvalView(x)),
      });
      return true;
    }
    // `?mine=1`, a person's own requests by its bearer or
    // session (`<cli> approvals list --mine`), never another's. Nobody
    // signed in falls through to the refusal below.
    const mineOf = principalOf(req);
    if (
      new URL(req.url ?? "/", "http://x").searchParams.get("mine") === "1" &&
      mineOf
    ) {
      sendJson(res, {
        ok: true,
        mine: deps.queue.ofActor(mineOf).map((x) => approvalView(x)),
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
      pending: deps.queue.pending().map((x) => approvalView(x)),
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
      // Issue 742: a stand-in for a lost id holds nothing but that it was lost.
      (a.unknown === true ||
        (agent
          ? a.actor === agent.actor
          : deps.queue.ticketMatches(
              a.id,
              typeof ticket === "string" ? ticket : undefined,
            ) || approverAllowed(req, guard, "read").ok));
    if (!a || !mayRead) {
      refuse(
        res,
        404,
        "not_found",
        "No such request (it may have ended at a restart).",
      );
      return true;
    }
    // Issue 621: the asker's own read (its agent token, or its ticket)
    // carries what the run left for it, once; nobody else ever sees it.
    const asker = agent
      ? a.actor === agent.actor
      : deps.queue.ticketMatches(
          a.id,
          typeof ticket === "string" ? ticket : undefined,
        );
    sendJson(res, {
      ok: true,
      ...approvalView(a, { asker }),
      ...(agent ? allowLinkOf(a, agent.workspace, deps.webUrl) : {}),
    });
    if (asker && a.state === "done" && method === "GET") forgetForAsker(a);
    return true;
  }

  /**
   * Issue 1414: whether the test operator's Allow may run held write `a`:
   * its check, run again now (as the run does), passes, says nothing
   * person-only, and is not critical on this install's mode. Anything that
   * throws: no.
   */
  async function operatorMayRun(a: Approval): Promise<boolean> {
    try {
      const act = Object.hasOwn(deps.actions, a.action)
        ? deps.actions[a.action]
        : undefined;
      if (!act) return false;
      const again = await act.check({ ...a.args }, undefined, { again: true });
      if (!again.ok || again.personOnly === true) return false;
      const mode = deps.installMode?.() ?? "strict";
      return !isCriticalWrite(a.action, false, again.areas, mode);
    } catch {
      return false;
    }
  }

  const dec = DECIDE_PATH.exec(pathname);
  if (dec && method === "POST") {
    // Issue 1414: the test operator's Allow (the request gate let this
    // fixture request through as the act: an operator install, loopback,
    // unforwarded). Allow only, and only a held write one of the bed's own
    // agents asked for. Anything else: refused, as the fixture person is.
    const opAllow = operatorActOf(req) === "approval-allow";
    const who: ReturnType<typeof approverAllowed> = opAllow
      ? { ok: true, session: OPERATOR_PRINCIPAL }
      : approverAllowed(req, guard);
    let opBody: Awaited<ReturnType<typeof jsonBody>> = null;
    if (opAllow) {
      opBody = await jsonBody(req);
      const body = opBody;
      const held = deps.queue.get(dec[1]);
      let bed = false;
      try {
        bed = !!held && deps.testBedAsker?.(held.actor) === true;
      } catch {
        bed = false;
      }
      let refusal: string | null =
        body?.decision !== "allow"
          ? "operator_allow_only"
          : !bed
            ? "operator_not_test_bed"
            : !OPERATOR_HELD_ACTIONS.includes(held!.action)
              ? "operator_action_not_allowed"
              : null;
      // Builder 2, Reviewer C: never a person-only or critical one, judged
      // now from the held record (the ask's answer may be stale).
      if (!refusal && !(await operatorMayRun(held!))) {
        refusal = "operator_action_not_allowed";
      }
      if (refusal) {
        recordAction(
          auditActorOf(req),
          {
            verb: "approval-decide",
            detail: dec[1],
            outcome: "refused",
            reason: refusal,
          },
          principalOf(req),
        );
        refuse(
          res,
          403,
          refusal,
          refusal === "operator_allow_only"
            ? "The test operator may only Allow."
            : refusal === "operator_action_not_allowed"
              ? "The test operator may Allow only a routine setting change: this one is the person's."
              : "The test operator may Allow only what a test bed's own agent asked for.",
        );
        return true;
      }
    }
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
    const body = opAllow ? opBody : await jsonBody(req);
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
    changed(deps);
    if (r.ok) {
      sendJson(res, { ok: true, ...approvalView(r.approval) });
      // Issue 334: what a run shows once (a new app key) went to this
      // Allow's browser only: never again, to anyone.
      forgetOnce(r.approval);
    } else
      refuse(
        res,
        r.code === "not_found"
          ? 404
          : r.code === "expired" || r.code === "lost"
            ? 410
            : 409,
        r.code,
        r.error,
      );
    return true;
  }

  // Issue 142: the asker withdraws its own request: the same agent token,
  // or the same person's bearer or session. Never a decision: nothing
  // runs, and the trail says who withdrew it.
  const wd = WITHDRAW_PATH.exec(pathname);
  if (wd && method === "POST") {
    const asker = agent ? agent.actor : principalOf(req);
    const refused = (status: number, code: string, error: string) => {
      recordAction(
        auditActorOf(req),
        {
          verb: "approval-withdraw",
          detail: wd[1],
          outcome: "refused",
          reason: code,
        },
        principalOf(req),
      );
      refuse(res, status, code, error);
      return true;
    };
    if (!asker)
      return refused(
        403,
        "not_asker",
        "Only the one that asked may withdraw a request: sign in, or use the asking agent's token.",
      );
    const r = deps.queue.withdraw(wd[1], asker);
    if (!r.ok)
      return refused(
        r.code === "not_found"
          ? 404
          : r.code === "not_asker"
            ? 403
            : r.code === "expired" || r.code === "lost"
              ? 410
              : 409,
        r.code,
        r.error,
      );
    recordAction(
      auditActorOf(req),
      {
        verb: "approval-withdraw",
        detail: `withdrawn by ${asker}: ${r.approval.action}: ${r.approval.summary} [${wd[1]}]`,
      },
      principalOf(req),
    );
    changed(deps);
    sendJson(res, { ok: true, ...approvalView(r.approval) });
    return true;
  }

  res.writeHead(405, { Allow: "GET, POST" });
  res.end();
  return true;
}

/** Issue 1371 Part 2, issue 1480: held writes whose bell row has Undo. */
export const UNDOABLE_ACTIONS: ReadonlySet<string> = new Set([
  "setting_change",
  "project_event_feed_add",
  "project_event_feed_remove",
]);

/**
 * Issue 160: the person's updates say what an agent did under the approval
 * policy's notify, one item per write (never folded into another).
 */
export function notePolicyRun(
  store: Pick<NotificationStore, "add">,
  a: Pick<Approval, "id" | "agent" | "summary"> &
    Partial<Pick<Approval, "action" | "result">>,
  project: string | undefined,
): void {
  const name = a.agent ?? "An agent";
  // Issue 1371 Part 2: a setting changed without asking can be undone.
  // Issue 1480: and so can an event feed added or removed.
  const undoable =
    UNDOABLE_ACTIONS.has(a.action ?? "") &&
    (a.result as { ok?: unknown } | undefined)?.ok === true;
  store.add({
    ...(undoable ? { undo: { approval: a.id } } : {}),
    kind: "service",
    subject: `record:approval-${a.id}`,
    scope: `workspace/${project ?? "den-server"}`,
    text: `${name} did this without your Allow: ${a.summary}`,
    msg: { key: "bell.m.policyRan", vars: { name, what: a.summary } },
    link: "/agents",
  });
}
export type ApprovalRouteDeps = Parameters<typeof handleApprovalRoutes>[4];
