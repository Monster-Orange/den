/**
 * Issue 796: an agent's read-only view of its own Den's pages.
 *
 * An agent running in this Den (its actor token, never a person's
 * credential) asks its MCP tool `page_view` for a view. The server mints a
 * one-time link on this machine's loopback address (AgentViewCodes, kept in
 * the server's memory only), and the agent's browser opens it:
 * `/auth?agent_view=<code>&next=<page>`. That makes a browser session
 * whose `via` is "agent-view", bound to the agent's name:
 *
 *  - It reads pages and the API's read-only routes, nothing else
 *    (agentViewScopeRefusal): every write (Allow or Deny, settings, an
 *    agent's start or stop, a terminal's input) and every GET that starts
 *    or streams something is refused by route class, and logged as the
 *    agent.
 *  - It is never the person: every page view and refusal is logged and
 *    audited with the agent's name (request-guard principalOf and
 *    auditActorOf), it never approves, it never counts as an owner or a
 *    person's device, and it never reaches Hub.
 *  - It works on loopback only (never from another machine), and ends
 *    after `web.agent_view_minutes` (AGENT_VIEW_MINUTES) or as soon as the
 *    install turns it off (`web.agent_view: false`, Settings › Access), or
 *    the agent's token stops being live.
 */
import { createHash, randomBytes } from "crypto";
import { FIXTURE_READ_DENY } from "./fixture-person.js";
import { AGENT_VIEW_MINUTES, AGENT_VIEW_RANGE } from "./web-session.js";

export { AGENT_VIEW_MINUTES, AGENT_VIEW_RANGE };

/** The sign-in link's query parameter. */
export const AGENT_VIEW_LINK_PARAM = "agent_view";
/** A session's `via` for an agent's view. */
export const AGENT_VIEW_VIA = "agent-view";
/** How long the one-time link waits to be opened. */
export const AGENT_VIEW_LINK_TTL_MS = 60_000;
/** The most unopened links kept at once (the oldest go first). */
const MAX_PENDING = 64;

const CODE_RE = /^v1\.[A-Za-z0-9_-]{43}$/;

/** Who a view is for: the agent's actor and its project. */
export interface AgentViewFor {
  agent: string;
  workspace: string;
}

/**
 * The one-time links not yet opened, in the server's memory only (a
 * restart forgets them, and a file never holds one).
 */
export class AgentViewCodes {
  private readonly pending = new Map<
    string,
    AgentViewFor & { expiresAt: number }
  >();
  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.pending)
      if (v.expiresAt <= t) this.pending.delete(k);
    while (this.pending.size >= MAX_PENDING) {
      const first = this.pending.keys().next().value;
      if (first === undefined) break;
      this.pending.delete(first);
    }
  }

  /** A new one-time code for `who`, and when it stops working. */
  mint(
    who: AgentViewFor,
    ttlMs: number = AGENT_VIEW_LINK_TTL_MS,
  ): { code: string; expiresAt: number } {
    this.prune();
    const code = `v1.${randomBytes(32).toString("base64url")}`;
    const expiresAt = this.now() + ttlMs;
    this.pending.set(hash(code), { ...who, expiresAt });
    return { code, expiresAt };
  }

  /** Who `code` was minted for, once, while it is in time; else null. */
  redeem(code: string): AgentViewFor | null {
    if (!CODE_RE.test(code)) return null;
    const k = hash(code);
    const hit = this.pending.get(k);
    this.pending.delete(k);
    if (!hit || hit.expiresAt <= this.now()) return null;
    return { agent: hit.agent, workspace: hit.workspace };
  }
}

function hash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Whether a view made at `createdAt` has outlived its minutes. */
export function agentViewExpired(
  createdAt: number,
  now: number,
  minutes: number,
): boolean {
  return now - createdAt >= minutes * 60_000;
}

/** What a refused request says (the page and the agent read it). */
export function agentViewRefusedText(agent: string): string {
  return `${agent}'s view of this Den is read-only: it opens pages and reads, and changes nothing.`;
}

/** What the tool says when the install turned views off. */
export function agentViewOffText(cli: string): string {
  return `Agents' read-only page views are off on this install (Settings › Access, or \`${cli} config web.agent_view=true\` to turn them on). Ask your person to look at the page, or to turn views on.`;
}

/**
 * Why an agent's view may not make this request, or null when it may. An
 * allow-list: a page or asset (a GET off /api/ that isn't `mutating` or
 * `shell-grade`), an /api/ GET the route table classes `readonly` and the
 * fixture person's deny list (Hub, the sign-in records) doesn't name, and
 * its own sign-out. Everything else (every other write, every GET that
 * starts or streams something, unclassified routes) is refused. `cls` is
 * the route's class (route-classes.ts routeClass), null when unclassified.
 */
export function agentViewScopeRefusal(
  method: string,
  pathname: string,
  cls: string | null,
  agent: string,
): string | null {
  const m = method.toUpperCase();
  const refused = agentViewRefusedText(agent);
  if (m === "GET" || m === "HEAD") {
    if (FIXTURE_READ_DENY.some((re) => re.test(pathname))) return refused;
    if (!pathname.startsWith("/api/"))
      return cls === "mutating" || cls === "shell-grade" ? refused : null;
    return cls === "readonly" ? null : refused;
  }
  return m === "POST" && pathname === "/api/session/logout" ? null : refused;
}
