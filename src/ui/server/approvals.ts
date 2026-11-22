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
 * requests waiting; settled ones are dropped an hour later.
 *
 * Issue 742: a request waits held_writes.wait_minutes (24 hours by
 * default), and what waits survives a restart: the queue is written under
 * the state dir (tmp file + rename, owner-only) at each change, and read
 * back at the start. Only what may still matter is written: pending, mid-
 * run, and lost requests, never a run's result. Den's own asks (actor
 * den:...) are not written: the update check asks again. What can't be
 * read back is "lost", never dropped without a trace: a request whose
 * action no longer exists, one a restart cut off mid-run (did it take
 * effect?), and, when the file itself is unreadable, every request (an id
 * Den no longer knows reads as lost for a week, the longest window).
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
import * as fs from "fs";
import * as path from "path";
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
  | {
      ok: false;
      code: "signin_to_approve" | "fixture_cannot_approve";
      error: string;
    };

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
  // Issue 810: the fixture person (a test install's live checks) never
  // decides what waits for a person.
  if (p?.kind === "person-browser" && p.fixture)
    return {
      ok: false,
      code: "fixture_cannot_approve",
      error: "The fixture person can't approve: that is a person's.",
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
 * Routes that let another browser in (a sign-in link for an edge
 * hostname, link or unlink the GitHub owner). Approving a waiting device
 * (/api/web/approve) is stricter: a signed-in browser only (issue 819,
 * pair-routes.ts). These need more
 * than a sign-in: the person's bearer (the CLI, which
 * refuses inside an agent's session), or what may approve (a signed-in
 * browser holding its approval key).
 */
export const PERSON_GRANT_ROUTES: readonly string[] = [
  "/api/web/pair",
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
  | "expired"
  /** Issue 142: its asker took it back before anyone decided. */
  | "withdrawn"
  /** Issue 742: a restart could not bring it back (lostBecause says why). */
  | "lost";

/** A Review line as a message key and its words, for the page's t(). */
export interface DetailKeyRec {
  key: string;
  vars?: Readonly<Record<string, string>>;
}

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
  /** One per details line: its message key and words (null: the line as is). */
  detailKeys?: readonly (DetailKeyRec | null)[];
  /** What the agent said about it: shown only quoted, as "Agent says". */
  note?: string;
  /** Issue 199: the agents that keep a mode of their own (Den's, from the args). */
  ownMode?: readonly { agent: string; mode: string }[];
  /** Issue 199: choices the person may turn on as they Allow (off by default). */
  choices?: readonly string[];
  /** Issue 199: the ones the person turned on. */
  chosen?: Readonly<Record<string, true>>;
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
  /** Issue 742: why a restart lost it (state "lost"). */
  lostBecause?: string;
  /**
   * Issue 742: a stand-in for an id Den no longer knows, after an
   * unreadable queue file: it holds nothing but the id and why.
   */
  unknown?: true;
}

export type Decision = "allow" | "deny";

export type DecideResult =
  /** repeat: a second click's replay of the first answer (one audit line). */
  | { ok: true; approval: Approval; repeat?: true }
  | {
      ok: false;
      code: "not_found" | "already_decided" | "expired" | "actor_gone" | "lost";
      error: string;
    };

/** Issue 142: what the asker's withdraw got. */
export type WithdrawResult =
  | { ok: true; approval: Approval }
  | {
      ok: false;
      code: "not_found" | "not_asker" | "already_decided" | "expired";
      error: string;
    };

/** The request an allowed action runs for: its id, the agent that asked, who allowed it. */
export interface AskedBy {
  id: string;
  agent?: string;
  decidedBy?: string;
}

export interface ApprovalQueueDeps {
  now?: () => number;
  /**
   * How long a request waits for a person (default 24 hours); a function
   * is read at each ask (issue 742: held_writes.wait_minutes).
   */
  ttlMs?: number | (() => number);
  /** Issue 742: the file the queue is kept in (none: in memory only). */
  file?: string;
  /** Issue 742: whether an action still exists (one that doesn't: lost). */
  knownAction?: (action: string) => boolean;
  /**
   * Issue 742: a restart lost a request (`a`), or, the file being
   * unreadable, every request (`a` null). Called once each.
   */
  onLost?: (a: Approval | null, why: string) => void;
  /**
   * Issue 746: a request ended unanswered (pending past its expiry). Called
   * once per request, when the queue first sees it expired.
   */
  onExpire?: (a: Approval) => void;
  /** Whether the agent that asked still runs (its token not revoked). */
  actorLive?: (actor: string) => boolean;
  /** Runs an allowed action from its stored args; `asked`: which request, whose. */
  run: (
    action: string,
    args: Readonly<Record<string, unknown>>,
    asked: AskedBy,
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
/** Issue 742: the default wait, held_writes.wait_minutes' (24 hours). */
export const DEFAULT_HELD_WAIT_MS = 24 * 60 * 60_000;
/** Issue 742: how long an unreadable file's "lost" answers last (the longest window). */
const LOST_UNKNOWN_MS = 7 * 24 * 60 * 60_000;
/** Issue 742: the states written to the queue file. */
const KEPT_STATES: ReadonlySet<ApprovalState> = new Set<ApprovalState>([
  "pending",
  "running",
  "lost",
]);
const ID_RE = /^[A-Za-z0-9_-]{16}$/;

/** A record read back from the file, checked field by field; null: unusable. */
function revive(raw: unknown): Approval | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  const num = (k: string) =>
    typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : NaN;
  if (
    !ID_RE.test(str("id")) ||
    !str("actor") ||
    !str("action") ||
    !r.args ||
    typeof r.args !== "object" ||
    Array.isArray(r.args) ||
    Number.isNaN(num("requestedAt")) ||
    Number.isNaN(num("expiresAt")) ||
    !KEPT_STATES.has(r.state as ApprovalState)
  )
    return null;
  const rest = { ...r };
  delete rest.result;
  const a = { ...rest, summary: str("summary") } as unknown as Approval;
  a.args = frozenCopy(r.args as Record<string, unknown>);
  return a;
}

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
  /** Issue 742: an unreadable file's moment and why (ids then read as lost). */
  private lostUnknown: { at: number; why: string } | null = null;

  constructor(private readonly deps: ApprovalQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.load();
  }

  /** Issue 742: the wait for a new request, the setting's at this ask. */
  private ttlMs(): number {
    const t = this.deps.ttlMs;
    let v: unknown;
    try {
      v = typeof t === "function" ? t() : t;
    } catch {
      v = undefined;
    }
    return typeof v === "number" && Number.isFinite(v) && v > 0
      ? v
      : DEFAULT_HELD_WAIT_MS;
  }

  private markLost(a: Approval, why: string): void {
    a.state = "lost";
    a.lostBecause = why;
    a.decidedAt = this.now();
    this.tellLost(a, why);
  }

  private tellLost(a: Approval | null, why: string): void {
    try {
      this.deps.onLost?.(a ? { ...a } : null, why);
    } catch {
      /* telling is best effort: the request reads as lost either way */
    }
  }

  /** Issue 742: what waited before the restart, read back. */
  private load(): void {
    const file = this.deps.file;
    if (!file) return;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
      return this.loadFailed(
        file,
        `the file can't be read (${String((e as Error)?.message ?? e)})`,
      );
    }
    let doc: { items?: unknown; lostAt?: unknown; lostWhy?: unknown };
    try {
      doc = JSON.parse(text) as typeof doc;
      if (!doc || typeof doc !== "object" || !Array.isArray(doc.items))
        throw new Error("no items list");
    } catch (e) {
      return this.loadFailed(
        file,
        `the file is broken (${String((e as Error)?.message ?? e)})`,
      );
    }
    if (
      typeof doc.lostAt === "number" &&
      this.now() - doc.lostAt < LOST_UNKNOWN_MS
    )
      this.lostUnknown = {
        at: doc.lostAt,
        why:
          typeof doc.lostWhy === "string" ? doc.lostWhy : "lost at a restart",
      };
    let unusable = 0;
    for (const raw of doc.items as unknown[]) {
      const a = revive(raw);
      if (!a) {
        unusable++;
        continue;
      }
      this.items.set(a.id, a);
      if (a.state === "running")
        this.markLost(
          a,
          "Den restarted while it ran: check whether it took effect before asking again.",
        );
      else if (
        a.state === "pending" &&
        this.deps.knownAction &&
        !this.deps.knownAction(a.action)
      )
        this.markLost(a, `this Den no longer has the action ${a.action}.`);
    }
    if (unusable) {
      const why = `${unusable} waiting request${unusable === 1 ? "" : "s"} in the queue file could not be read back after a restart. Ask again.`;
      this.lostUnknown = { at: this.now(), why };
      this.tellLost(null, why);
    }
    this.persist();
  }

  private loadFailed(file: string, detail: string): void {
    const why = `the held-write queue could not be read back after a restart: ${detail}. Requests that waited are lost; ask again.`;
    try {
      fs.renameSync(file, `${file}.corrupt-${this.now()}`);
    } catch {
      /* kept where it is; the next write replaces it */
    }
    this.lostUnknown = { at: this.now(), why };
    this.tellLost(null, why);
    this.persist();
  }

  /** Issue 742: the queue to its file, atomically (tmp + rename), owner-only. */
  private persist(): void {
    const file = this.deps.file;
    if (!file) return;
    const items: Record<string, unknown>[] = [];
    for (const a of this.items.values()) {
      if (a.actor.startsWith("den:") || !KEPT_STATES.has(a.state)) continue;
      const rest: Record<string, unknown> = { ...a };
      delete rest.result;
      items.push(rest);
    }
    const doc = {
      version: 1,
      items,
      ...(this.lostUnknown
        ? { lostAt: this.lostUnknown.at, lostWhy: this.lostUnknown.why }
        : {}),
    };
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // Best effort: the queue in memory still holds it.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing more to do */
      }
    }
  }

  request(r: {
    actor: string;
    agent?: string;
    action: string;
    args: Record<string, unknown>;
    summary: string;
    params?: Record<string, string>;
    details?: string[];
    detailKeys?: (DetailKeyRec | null)[];
    note?: string;
    ownMode?: { agent: string; mode: string }[];
    choices?: string[];
    ticketHash?: string;
    /**
     * SRV-P6 (0.4.48): how long this one waits for the person (default
     * the queue's): Den's own "update to X" waits longer than an agent's.
     */
    ttlMs?: number;
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
      ...(r.details && r.detailKeys?.length
        ? {
            detailKeys: Object.freeze(
              r.detailKeys.slice(0, 80).map((k) =>
                k && /^[a-z][a-zA-Z0-9_.]{0,63}$/.test(k.key)
                  ? Object.freeze({
                      key: k.key,
                      ...(k.vars
                        ? {
                            vars: Object.freeze(
                              Object.fromEntries(
                                Object.entries(k.vars)
                                  .slice(0, 8)
                                  .map(([n, v]) => [
                                    n.slice(0, 32),
                                    String(v).slice(0, 2000),
                                  ]),
                              ),
                            ),
                          }
                        : {}),
                    })
                  : null,
              ),
            ),
          }
        : {}),
      ...(r.agent ? { agent: r.agent.slice(0, 64) } : {}),
      ...(r.note?.trim()
        ? { note: r.note.replace(/\s+/g, " ").trim().slice(0, 300) }
        : {}),
      ...(r.ownMode?.length
        ? {
            ownMode: Object.freeze(
              r.ownMode.slice(0, 200).map((o) =>
                Object.freeze({
                  agent: o.agent.slice(0, 64),
                  mode: o.mode.slice(0, 16),
                }),
              ),
            ),
          }
        : {}),
      ...(r.choices?.length
        ? { choices: Object.freeze(r.choices.slice(0, 8)) }
        : {}),
      ...(r.ticketHash ? { ticketHash: r.ticketHash } : {}),
      requestedAt: t,
      expiresAt: t + (r.ttlMs ?? this.ttlMs()),
      state: "pending",
    };
    this.items.set(a.id, a);
    this.persist();
    return { ...a };
  }

  private settle(a: Approval): void {
    if (a.state === "pending" && this.now() >= a.expiresAt) {
      a.state = "expired";
      a.decidedAt = a.expiresAt;
      try {
        this.deps.onExpire?.({ ...a });
      } catch {
        /* telling is best effort: the request has ended either way */
      }
      this.persist();
    }
  }

  /** Drop what settled more than an hour ago. */
  private prune(): void {
    const now = this.now();
    let dropped = false;
    for (const [id, a] of this.items) {
      this.settle(a);
      if (
        a.state !== "pending" &&
        a.state !== "running" &&
        a.decidedAt !== undefined &&
        now - a.decidedAt > KEEP_SETTLED_MS
      ) {
        this.items.delete(id);
        dropped = dropped || a.state === "lost";
      }
    }
    if (this.lostUnknown && now - this.lostUnknown.at >= LOST_UNKNOWN_MS) {
      this.lostUnknown = null;
      dropped = true;
    }
    if (dropped) this.persist();
  }

  get(id: string): Approval | null {
    const a = this.items.get(id);
    if (!a) {
      // Issue 742: after an unreadable queue file, an id Den doesn't know
      // may be one it lost: say so, never "no such request".
      const l = this.lostUnknown;
      if (!l || !ID_RE.test(id) || this.now() - l.at >= LOST_UNKNOWN_MS)
        return null;
      return {
        id,
        actor: "",
        action: "",
        args: {},
        summary: "",
        requestedAt: l.at,
        expiresAt: l.at,
        decidedAt: l.at,
        state: "lost",
        lostBecause: l.why,
        unknown: true,
      };
    }
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

  /**
   * Issue 142: `actor` (the credential's, never a claim) takes back its
   * own pending request. Not a decision: nothing runs, nobody decided.
   */
  withdraw(id: string, actor: string): WithdrawResult {
    const a = this.items.get(id);
    if (!a)
      return {
        ok: false,
        code: "not_found",
        error: "No such request (it may have ended at a restart).",
      };
    if (a.actor !== actor)
      return {
        ok: false,
        code: "not_asker",
        error: "Only the one that asked may withdraw a request.",
      };
    this.settle(a);
    if (a.state === "expired")
      return {
        ok: false,
        code: "expired",
        error: "This request already waited too long; it has ended.",
      };
    if (a.state !== "pending" || this.deciding.has(id))
      return {
        ok: false,
        code: "already_decided",
        error: "This request was already decided.",
      };
    a.state = "withdrawn";
    a.decidedAt = this.now();
    this.persist();
    return { ok: true, approval: { ...a } };
  }

  async decide(
    id: string,
    decision: Decision,
    by: string,
    /** Issue 199: the choices the person turned on (offered ones only). */
    chosen: Record<string, true> = {},
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
    const done = this.decideOnce(id, decision, by, chosen);
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
    chosen: Record<string, true>,
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
    if (a.state === "lost")
      return {
        ok: false,
        code: "lost",
        error: `This request was lost at a restart (${a.lostBecause ?? "Den could not bring it back"}). Nothing ran. Ask the agent to try again.`,
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
      this.persist();
      return { ok: true, approval: { ...a } };
    }
    if (this.deps.actorLive && !this.deps.actorLive(a.actor)) {
      a.state = "denied";
      a.endedBecause = "actor_gone";
      this.persist();
      return {
        ok: false,
        code: "actor_gone",
        error:
          "The agent that asked has been stopped since, so this won't run.",
      };
    }
    a.state = "running";
    // Issue 742: written as running, so a restart mid-run says lost.
    this.persist();
    // Issue 199: only a choice the request offered reaches the run.
    const on = Object.fromEntries(
      Object.keys(chosen)
        .filter((k) => a.choices?.includes(k))
        .map((k) => [k, true as const]),
    );
    if (Object.keys(on).length) a.chosen = Object.freeze(on);
    try {
      a.result = await this.deps.run(
        a.action,
        { ...a.args, ...on },
        {
          id: a.id,
          ...(a.agent ? { agent: a.agent } : {}),
          decidedBy: by,
        },
      );
    } catch (e) {
      a.result = { ok: false, error: String((e as Error)?.message ?? e) };
    }
    a.state = "done";
    this.persist();
    return { ok: true, approval: { ...a } };
  }
}
