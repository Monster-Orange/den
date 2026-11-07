/**
 * Approvals (0.4.12, ON-3's writes; Ward 2026-11-07): an agent's change
 * waits for a person.
 *
 * Who may approve: approverAllowed, the one check. A signed-in browser
 * session only: its cookie, no bearer of any kind, on a mutation that
 * carried that session's own CSRF token (checkRequest checked it: with a
 * session, it accepts only the session's token). Not an anonymous
 * loopback request, though loopback lets those read and change everything
 * else (an agent with a shell can send one); not a person's or an agent's
 * bearer. Seam: a later "loopback isn't identity" mode (cloud machines)
 * changes what counts as a session in checkRequest; this check stays.
 *
 * The queue: request() holds a write with a copy of its exact args, so
 * nothing can change between Allow and the run. decide("allow") runs it
 * once, on the server, from the stored args, and keeps the result;
 * "deny" and expiry run nothing; a second decision is refused. In memory:
 * a restart drops what waits (the agent asks again).
 *
 * Limit: an agent running as the same OS user could, in principle, read
 * the browser's cookie store from disk. That is the strength of Den's
 * other person-only routes; only an OS boundary is stronger.
 */
import { randomBytes } from "crypto";
import type * as http from "http";
import type { GuardResult } from "./request-guard.js";

export type ApproverCheck =
  | { ok: true; session: string }
  | { ok: false; code: "signin_to_approve"; error: string };

/** Whether this request may approve or deny an agent's change. */
export function approverAllowed(
  req: http.IncomingMessage,
  guard: Extract<GuardResult, { ok: true }>,
): ApproverCheck {
  const method = (req.method ?? "GET").toUpperCase();
  const p = guard.principal;
  if (
    method === "POST" &&
    guard.session &&
    p?.kind === "person-browser" &&
    p.session === guard.session.key &&
    !req.headers.authorization
  )
    return { ok: true, session: guard.session.key };
  return {
    ok: false,
    code: "signin_to_approve",
    error:
      "Approving an agent's change needs a signed-in browser. Sign in on this page, then approve.",
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
  /** Who asked: `agent:<id>`. */
  actor: string;
  /** The action's name (an MCP write tool's). */
  action: string;
  /** A copy of the exact args, taken when it was asked for. */
  args: Readonly<Record<string, unknown>>;
  /** One plain line for the dialog. */
  summary: string;
  requestedAt: number;
  expiresAt: number;
  state: ApprovalState;
  /** The session that decided. */
  decidedBy?: string;
  decidedAt?: number;
  /** What the run said (Allow only). */
  result?: unknown;
}

export type Decision = "allow" | "deny";

export type DecideResult =
  | { ok: true; approval: Approval }
  | {
      ok: false;
      code: "not_found" | "already_decided" | "expired";
      error: string;
    };

export interface ApprovalQueueDeps {
  now?: () => number;
  /** How long a request waits for a person (default 10 minutes). */
  ttlMs?: number;
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

export class ApprovalQueue {
  private readonly items = new Map<string, Approval>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly deps: ApprovalQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? 10 * 60_000;
  }

  request(r: {
    actor: string;
    action: string;
    args: Record<string, unknown>;
    summary: string;
  }): Approval {
    const t = this.now();
    const a: Approval = {
      id: randomBytes(12).toString("base64url"),
      actor: r.actor,
      action: r.action,
      args: frozenCopy(r.args),
      summary: r.summary.slice(0, 300),
      requestedAt: t,
      expiresAt: t + this.ttlMs,
      state: "pending",
    };
    this.items.set(a.id, a);
    return { ...a };
  }

  private settle(a: Approval): void {
    if (a.state === "pending" && this.now() >= a.expiresAt) a.state = "expired";
  }

  get(id: string): Approval | null {
    const a = this.items.get(id);
    if (!a) return null;
    this.settle(a);
    return { ...a };
  }

  /** What waits for a person, oldest first. */
  pending(): Approval[] {
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
