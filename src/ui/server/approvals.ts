/**
 * Approvals (0.4.15, ON-3's writes; Ward 2026-11-07): an agent's change
 * waits for a person.
 *
 * Who may approve: approverAllowed, the one check. A signed-in browser
 * session only: its cookie, no Authorization header of any kind, a POST
 * that carried that session's own CSRF token (checkRequest checked it:
 * with a session, it accepts only the session's token), and the session's
 * approval key (X-Den-Approve-Key, web-session.ts). The key is what a
 * stolen cookie lacks: browsers send a localhost cookie to every localhost
 * port, so an agent's dev server on another port receives it, and GET
 * /api/session gives any cookie holder the CSRF token; only the signed-in
 * page holds the key. Not an anonymous
 * loopback request, though loopback lets those read and change everything
 * else (an agent with a shell can send one); not a person's or an agent's
 * bearer. Seam: a later "loopback isn't identity" mode (cloud machines)
 * changes what counts as a session in checkRequest; this check stays.
 *
 * The queue: request() holds a write with a copy of its exact args, so
 * nothing can change between Allow and the run. decide("allow") runs it
 * once, on the server, from the stored args, and keeps the result;
 * "deny" and expiry run nothing; a second decision is refused; Allow is
 * refused once the agent that asked has been stopped. An agent may have 5
 * requests waiting; settled ones are dropped an hour later. In memory: a
 * restart drops what waits (the agent asks again).
 *
 * Who may read what waits (Vision 2026-11-07): the person's list needs
 * the same proof as approving, on a GET (approverAllowed(…, "read"): the
 * cookie, the session's CSRF token sent as X-Den-CSRF, the approval key).
 * An agent's token reads its own requests only. An anonymous loopback
 * asker reads only the one it holds the ticket for: the POST's reply
 * hands it a random ticket (X-Den-Approval-Ticket), stored hashed.
 *
 * Limit: an agent running as the same OS user could, in principle, read
 * the browser's cookie store from disk. That is the strength of Den's
 * other person-only routes; only an OS boundary is stronger.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type * as http from "http";
import {
  APPROVE_KEY_HEADER,
  approveKeyMatches,
} from "../../shared/web-session.js";
import { CSRF_HEADER, type GuardResult } from "./request-guard.js";

/** The header an anonymous asker reads its own request with. */
export const APPROVAL_TICKET_HEADER = "x-den-approval-ticket";

/** A new ticket and its hash (only the hash is kept). */
export function newApprovalTicket(): { ticket: string; hash: string } {
  const ticket = randomBytes(24).toString("base64url");
  return { ticket, hash: ticketHash(ticket) };
}
function ticketHash(t: string): string {
  return createHash("sha256").update(t).digest("base64url");
}

export type ApproverCheck =
  | { ok: true; session: string }
  | { ok: false; code: "signin_to_approve"; error: string };

/**
 * Whether this request may approve or deny an agent's change ("decide",
 * a POST the guard checked CSRF on), or read what waits ("read", a GET:
 * the session's CSRF token is checked here, as the guard checks a POST's).
 */
export function approverAllowed(
  req: http.IncomingMessage,
  guard: Extract<GuardResult, { ok: true }>,
  mode: "decide" | "read" = "decide",
): ApproverCheck {
  const method = (req.method ?? "GET").toUpperCase();
  const p = guard.principal;
  const csrf = req.headers[CSRF_HEADER];
  const methodOk =
    mode === "decide"
      ? method === "POST"
      : (method === "GET" || method === "HEAD") &&
        typeof csrf === "string" &&
        !!guard.session &&
        same(csrf, guard.session.csrf);
  const signedIn =
    methodOk &&
    guard.session &&
    p?.kind === "person-browser" &&
    p.session === guard.session.key &&
    req.headers.authorization === undefined;
  if (!signedIn || !guard.session)
    return {
      ok: false,
      code: "signin_to_approve",
      error:
        "Approving an agent's change needs a signed-in browser. Sign in on this page, then approve.",
    };
  const given = req.headers[APPROVE_KEY_HEADER];
  if (
    !approveKeyMatches(
      guard.session.approveKeyHash,
      typeof given === "string" ? given : null,
    )
  )
    return {
      ok: false,
      code: "signin_to_approve",
      error:
        "This browser can't approve yet. Sign in again on this page, then approve.",
    };
  return { ok: true, session: guard.session.key };
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Routes that let another browser in (pair a device, a sign-in link for
 * an edge hostname, link or unlink the GitHub owner). On loopback an
 * anonymous request counts as the person, and an agent with a shell can
 * send one, so these need more: the person's bearer (the CLI, which
 * refuses inside an agent's session), or what may approve (a signed-in
 * browser holding its approval key).
 */
export const PERSON_GRANT_ROUTES: readonly string[] = [
  "/api/web/pair",
  "/api/web/approve",
  "/api/web/owner/link",
  "/api/web/owner/unlink",
];

export type PersonGrantCheck =
  | { ok: true }
  | { ok: false; code: "signin_to_approve"; error: string };

/** Whether this request may let another browser in (PERSON_GRANT_ROUTES). */
export function personGrantAllowed(
  req: http.IncomingMessage,
  guard: Extract<GuardResult, { ok: true }>,
  cli: string,
): PersonGrantCheck {
  if (guard.principal?.kind === "person") return { ok: true };
  if (approverAllowed(req, guard).ok) return { ok: true };
  return {
    ok: false,
    code: "signin_to_approve",
    error: `This lets another browser in, so it needs you: sign in on this page first, or run \`${cli} web\` commands in your own terminal.`,
  };
}

export type ApprovalState =
  | "pending"
  | "running"
  | "done"
  | "denied"
  | "expired";

export interface Approval {
  id: string;
  /** Who asked: `agent:<id>` (or the person's MCP server, `person:…`). */
  actor: string;
  /** The asking agent's session name, for the dialog ("server wants to …"). */
  agent?: string;
  /** The action's name (an MCP write tool's). */
  action: string;
  /** A copy of the exact args, taken when it was asked for. */
  args: Readonly<Record<string, unknown>>;
  /** One plain line for the dialog, written by Den from the action and args (never the agent's words). */
  summary: string;
  /** The same line's parts, for a page to word it in its language (Den's, from the args). */
  params?: Readonly<Record<string, string>>;
  /** Review: what it will do, line by line (Den's, from the args). */
  details?: readonly string[];
  /** What the agent said about it: shown only quoted, as "Agent says". */
  note?: string;
  requestedAt: number;
  expiresAt: number;
  state: ApprovalState;
  /** The session that decided. */
  decidedBy?: string;
  decidedAt?: number;
  /** What the run said (Allow only). */
  result?: unknown;
  /** Why it ended without running, when it wasn't the person (actor_gone). */
  endedBecause?: "actor_gone";
  /** sha256 of the anonymous asker's ticket; never in a view. */
  ticketHash?: string;
}

export type Decision = "allow" | "deny";

export type DecideResult =
  /** repeat: a second click's replay of the first answer (one audit line). */
  | { ok: true; approval: Approval; repeat?: true }
  | {
      ok: false;
      code: "not_found" | "already_decided" | "expired" | "actor_gone";
      error: string;
    };

export interface ApprovalQueueDeps {
  now?: () => number;
  /** How long a request waits for a person (default 10 minutes). */
  ttlMs?: number;
  /** Whether the agent that asked still runs (its token not revoked). */
  actorLive?: (actor: string) => boolean;
  /** Runs an allowed action from its stored args. */
  run: (
    action: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
}

/** A deep copy of plain JSON args, frozen. */
function frozenCopy(
  args: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const copy = JSON.parse(JSON.stringify(args ?? {})) as Record<
    string,
    unknown
  >;
  const freeze = (o: unknown): void => {
    if (o && typeof o === "object") {
      Object.freeze(o);
      for (const v of Object.values(o)) freeze(v);
    }
  };
  freeze(copy);
  return copy;
}

/** Requests one agent may have waiting at once. */
export const MAX_PENDING_PER_ACTOR = 5;
/** How long a settled request is kept (to show its outcome). */
const KEEP_SETTLED_MS = 60 * 60_000;

export class ApprovalQueue {
  private readonly items = new Map<string, Approval>();
  /**
   * The double-click fix: a decide in flight, by id. The same decision
   * again (a second click, a retried request) gets the first one's answer,
   * never "already decided".
   */
  private readonly deciding = new Map<
    string,
    { decision: Decision; done: Promise<DecideResult> }
  >();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly deps: ApprovalQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? 10 * 60_000;
  }

  request(r: {
    actor: string;
    agent?: string;
    action: string;
    args: Record<string, unknown>;
    summary: string;
    params?: Record<string, string>;
    details?: string[];
    note?: string;
    ticketHash?: string;
  }): Approval {
    this.prune();
    let waiting = 0;
    for (const x of this.items.values())
      if (x.actor === r.actor && x.state === "pending") waiting++;
    if (waiting >= MAX_PENDING_PER_ACTOR)
      throw new Error(
        `This agent already has ${MAX_PENDING_PER_ACTOR} requests waiting for a person. Wait for those first.`,
      );
    const t = this.now();
    const a: Approval = {
      id: randomBytes(12).toString("base64url"),
      actor: r.actor,
      action: r.action,
      args: frozenCopy(r.args),
      summary: r.summary.slice(0, 300),
      ...(r.params
        ? {
            params: Object.freeze(
              Object.fromEntries(
                Object.entries(r.params).map(([k, v]) => [k, v.slice(0, 300)]),
              ),
            ),
          }
        : {}),
      ...(r.details
        ? {
            details: Object.freeze(
              r.details.slice(0, 80).map((l) => l.slice(0, 2000)),
            ),
          }
        : {}),
      ...(r.agent ? { agent: r.agent.slice(0, 64) } : {}),
      ...(r.note?.trim()
        ? { note: r.note.replace(/\s+/g, " ").trim().slice(0, 300) }
        : {}),
      ...(r.ticketHash ? { ticketHash: r.ticketHash } : {}),
      requestedAt: t,
      expiresAt: t + this.ttlMs,
      state: "pending",
    };
    this.items.set(a.id, a);
    return { ...a };
  }

  private settle(a: Approval): void {
    if (a.state === "pending" && this.now() >= a.expiresAt) {
      a.state = "expired";
      a.decidedAt = a.expiresAt;
    }
  }

  /** Drop what settled more than an hour ago. */
  private prune(): void {
    const now = this.now();
    for (const [id, a] of this.items) {
      this.settle(a);
      if (
        a.state !== "pending" &&
        a.state !== "running" &&
        a.decidedAt !== undefined &&
        now - a.decidedAt > KEEP_SETTLED_MS
      )
        this.items.delete(id);
    }
  }

  get(id: string): Approval | null {
    const a = this.items.get(id);
    if (!a) return null;
    this.settle(a);
    return { ...a };
  }

  /** One actor's requests, every state, oldest first (an agent's own list). */
  ofActor(actor: string): Approval[] {
    this.prune();
    const out: Approval[] = [];
    for (const a of this.items.values()) {
      this.settle(a);
      if (a.actor === actor) out.push({ ...a });
    }
    return out;
  }

  /** Whether `ticket` is the one this request's anonymous asker was given. */
  ticketMatches(id: string, ticket: string | undefined): boolean {
    const h = this.items.get(id)?.ticketHash;
    return !!h && typeof ticket === "string" && same(ticketHash(ticket), h);
  }

  /** The actors with a request waiting (AG-6a: their agents are "waiting"). */
  waitingActors(): Set<string> {
    const out = new Set<string>();
    for (const a of this.pending()) out.add(a.actor);
    return out;
  }

  /** What waits for a person, oldest first. */
  pending(): Approval[] {
    this.prune();
    const out: Approval[] = [];
    for (const a of this.items.values()) {
      this.settle(a);
      if (a.state === "pending") out.push({ ...a });
    }
    return out;
  }

  async decide(
    id: string,
    decision: Decision,
    by: string,
  ): Promise<DecideResult> {
    const inFlight = this.deciding.get(id);
    if (inFlight && inFlight.decision === decision)
      return inFlight.done.then((r) => (r.ok ? { ...r, repeat: true } : r));
    const a0 = this.items.get(id);
    // Decided already, the same way: its answer again.
    if (
      a0 &&
      !inFlight &&
      ((a0.state === "done" && decision === "allow") ||
        (a0.state === "denied" && decision === "deny")) &&
      a0.endedBecause === undefined
    )
      return { ok: true, approval: { ...a0 }, repeat: true };
    const done = this.decideOnce(id, decision, by);
    this.deciding.set(id, { decision, done });
    try {
      return await done;
    } finally {
      this.deciding.delete(id);
    }
  }

  private async decideOnce(
    id: string,
    decision: Decision,
    by: string,
  ): Promise<DecideResult> {
    const a = this.items.get(id);
    if (!a)
      return {
        ok: false,
        code: "not_found",
        error: "No such request (it may have ended at a restart).",
      };
    this.settle(a);
    if (a.state === "expired")
      return {
        ok: false,
        code: "expired",
        error: "This request waited too long. Ask the agent to try again.",
      };
    if (a.state !== "pending")
      return {
        ok: false,
        code: "already_decided",
        error: "This request was already decided.",
      };
    // Claimed before anything awaits: a second decide sees "running".
    a.decidedBy = by;
    a.decidedAt = this.now();
    if (decision === "deny") {
      a.state = "denied";
      return { ok: true, approval: { ...a } };
    }
    if (this.deps.actorLive && !this.deps.actorLive(a.actor)) {
      a.state = "denied";
      a.endedBecause = "actor_gone";
      return {
        ok: false,
        code: "actor_gone",
        error:
          "The agent that asked has been stopped since, so this won't run.",
      };
    }
    a.state = "running";
    try {
      a.result = await this.deps.run(a.action, a.args);
    } catch (e) {
      a.result = { ok: false, error: String((e as Error)?.message ?? e) };
    }
    a.state = "done";
    return { ok: true, approval: { ...a } };
  }
}
