/**
 * Issue 142, clause 4: a held write that waits on the person's Allow
 * counts in the bell. Every pending request in the approval queue is one
 * "decision" item (decisions need the person, so the badge counts them),
 * whoever asked: an agent, the person's own MCP client. Den's own update
 * ask already has its item (index.ts, "bell.m.updateOut"), so it never
 * gets a second.
 *
 * The bell follows the queue: syncHeldBell adds the item a pending request
 * lacks and removes the item of one that no longer waits (Allow, Deny,
 * expiry, withdrawn by its asker, or a restart: the queue lives in memory,
 * the bell on disk). One item per request, keyed by its id, however often
 * it runs; one the person marked read is not raised again.
 */
import type {
  Notification,
  NotificationStore,
} from "../../shared/notifications.js";
import { claimantIsPerson, type Approval } from "./approvals.js";
import { allowPath } from "../../shared/agent-links.js";

/** A held write's bell item: `record:held-<request id>`. */
export const HELD_SUBJECT_PREFIX = "record:held-";

/** Den's own "update to X" ask: its bell item is the update ask's. */
export function isUpdateAskRequest(
  a: Pick<Approval, "actor" | "action">,
): boolean {
  return a.actor === "den:update-check" && a.action === "den_update";
}

/** Where the person decides it: the asking agent's row, else any page (the Allow opens on each). */
export function heldLink(
  agent: string | undefined,
  project: string | undefined,
): string {
  // Issue 1016: the same page an agent's held write links its person to.
  return allowPath(agent, project);
}

const isHeld = (n: Notification) =>
  n.kind === "decision" && n.subject.startsWith(HELD_SUBJECT_PREFIX);

/**
 * The bell's held-write items made to match `pending` (the queue's
 * pending requests). `projectOf` names the project a request is in, when
 * known. How many items were added and removed.
 */
export function syncHeldBell(
  store: Pick<NotificationStore, "list" | "add" | "remove">,
  pending: readonly Approval[],
  o: { projectOf?: (a: Approval) => string | undefined } = {},
): { added: number; removed: number } {
  const want = new Map<string, Approval>();
  for (const a of pending)
    if (a.state === "pending" && !isUpdateAskRequest(a))
      want.set(`${HELD_SUBJECT_PREFIX}${a.id}`, a);
  const have = new Set(
    store
      .list()
      .filter(isHeld)
      .map((n) => n.subject),
  );
  const removed = store.remove((n) => isHeld(n) && !want.has(n.subject));
  let added = 0;
  for (const [subject, a] of want) {
    if (have.has(subject)) continue;
    let project: string | undefined;
    try {
      project = o.projectOf?.(a);
    } catch {
      project = undefined;
    }
    const what = a.summary;
    const claimed = claimantIsPerson(a.actor) ? a.claimedAs : undefined;
    const n = store.add({
      kind: "decision",
      subject,
      scope: `workspace/${project || "den-server"}`,
      // Issue 1293: a person's own ask under an unverified agent claim
      // says so, never as though that agent asked.
      text: a.agent
        ? `${a.agent} waits for your Allow: ${what}`
        : claimed
          ? `Waiting for your Allow: ${what}. You asked, as ${claimed} (not verified).`
          : `Waiting for your Allow: ${what}`,
      msg: a.agent
        ? { key: "bell.m.heldAllow", vars: { name: a.agent, what } }
        : claimed
          ? {
              key: "bell.m.heldAllowClaimed",
              vars: { name: claimed, what },
            }
          : { key: "bell.m.heldAllowAsk", vars: { what } },
      link: heldLink(a.agent, project),
    });
    if (n) added++;
  }
  return { added, removed };
}

/**
 * Issue 746: one held write waiting on the person, as GET
 * /api/notifications' `waiting` lists it (first, above agents' questions):
 * what it is, who asked, since when and until when.
 */
export interface HeldWaiting {
  kind: "allow";
  id: string;
  action: string;
  what: string;
  agent?: string;
  /** Issue 1293: the person asked, under this unverified agent claim. */
  claimedAs?: string;
  since: string;
  expiresAt: string;
  /**
   * Issue 746: the summary's parts, so the page words it in its language
   * as the Allow dialog does (shell.js apWhat); `what` is the fallback.
   */
  params?: Approval["params"];
  /** Its Allow card's details lines, for the row's Review (as the dialog). */
  details?: readonly string[];
  /** One per details line: its message key and words (null: as is). */
  detailKeys?: Approval["detailKeys"];
  /** Issue 110: the Coach finding it came from, for the bell's card. */
  coach?: Approval["coach"];
}

/**
 * Issue 746: the queue's pending requests as Needs you entries, oldest
 * first. Den's own update ask has its own item (isUpdateAskRequest).
 */
export function heldWaiting(pending: readonly Approval[]): HeldWaiting[] {
  return pending
    .filter((a) => a.state === "pending" && !isUpdateAskRequest(a))
    .sort((x, y) => x.requestedAt - y.requestedAt)
    .map((a) => ({
      kind: "allow" as const,
      id: a.id,
      action: a.action,
      what: a.summary,
      ...(a.agent ? { agent: a.agent } : {}),
      ...(a.claimedAs && !a.agent && claimantIsPerson(a.actor)
        ? { claimedAs: a.claimedAs }
        : {}),
      since: new Date(a.requestedAt).toISOString(),
      expiresAt: new Date(a.expiresAt).toISOString(),
      ...(a.params ? { params: a.params } : {}),
      ...(a.details?.length ? { details: a.details } : {}),
      ...(a.details?.length && a.detailKeys?.length
        ? { detailKeys: a.detailKeys }
        : {}),
      ...(a.coach ? { coach: a.coach } : {}),
    }));
}

/** Issue 746: a lapsed request's bell item: `record:held-lapsed-<id>`. */
export const LAPSED_SUBJECT_PREFIX = "record:held-lapsed-";

/** Issue 746: what the asking agent is told when its request lapsed. */
export function lapsedNotice(
  a: Pick<Approval, "id" | "action" | "summary">,
): string {
  return (
    `Den: your request ${a.id} (${a.action}: ${a.summary}) lapsed: ` +
    `the person did not answer before it expired. Nothing ran. ` +
    `If it is still needed, ask again (call ${a.action} again).`
  );
}

export interface LapsedDeps {
  store: Pick<NotificationStore, "add">;
  /** The project the request is in, when known. */
  projectOf?: (a: Approval) => string | undefined;
  /**
   * Tells agent `agent` (its id) `text` in its session; resolves to what
   * happened ("told", "missing", ...). Absent: nobody is told.
   */
  tell?: (agent: string, text: string) => Promise<string>;
}

/**
 * Issue 746: a held write expired unanswered. The bell says it lapsed (an
 * update, not a decision: nothing waits on the person now), and the agent
 * that asked is told directly, with the reason and a hint to ask again.
 * Den's own update ask is left to its own item. Resolves to what telling
 * the agent did, or why nobody was told.
 */
export async function heldLapsed(a: Approval, d: LapsedDeps): Promise<string> {
  if (isUpdateAskRequest(a)) return "update ask";
  let project: string | undefined;
  try {
    project = d.projectOf?.(a);
  } catch {
    project = undefined;
  }
  const what = a.summary;
  try {
    d.store.add({
      kind: "service",
      subject: `${LAPSED_SUBJECT_PREFIX}${a.id}`,
      scope: `workspace/${project || "den-server"}`,
      text: a.agent
        ? `${a.agent}'s request lapsed unanswered: ${what}. Nothing ran; the agent was told to ask again.`
        : `A request lapsed unanswered: ${what}. Nothing ran.`,
      // The action and params let the page word `what` in its language
      // (shell.js apWhat); `what` stays, the English fallback.
      msg: {
        key: a.agent ? "bell.m.heldLapsed" : "bell.m.heldLapsedAsk",
        vars: {
          ...(a.agent ? { name: a.agent } : {}),
          what,
          action: a.action,
          ...(a.params ? { params: JSON.stringify(a.params) } : {}),
        },
      },
      link: heldLink(a.agent, project),
    });
  } catch {
    /* the bell is best effort */
  }
  if (!a.actor.startsWith("agent:")) return "not an agent";
  if (!d.tell) return "nobody to tell";
  try {
    return await d.tell(a.actor.slice("agent:".length), lapsedNotice(a));
  } catch (e) {
    return `not told: ${(e as Error)?.message ?? String(e)}`;
  }
}

/** Issue 742: a lost request's bell item: `record:held-lost-<id>`. */
export const LOST_SUBJECT_PREFIX = "record:held-lost-";

/** Issue 742: what the asking agent is told when a restart lost its request. */
export function lostNotice(
  a: Pick<Approval, "id" | "action" | "summary">,
  why: string,
): string {
  return (
    `Den: your request ${a.id} (${a.action}: ${a.summary}) was lost at a restart: ${why} ` +
    `Nothing ran from it. If it is still needed, ask again (call ${a.action} again).`
  );
}

/**
 * Issue 742: a restart could not bring back a held write (`a`), or, the
 * queue file being unreadable, any of them (`a` null). The bell says so,
 * and the agent that asked, when known, is told directly. Never silent.
 */
export async function heldLost(
  a: Approval | null,
  why: string,
  d: LapsedDeps & { now?: () => number },
): Promise<string> {
  if (!a) {
    try {
      d.store.add({
        kind: "service",
        subject: `${LOST_SUBJECT_PREFIX}all-${(d.now ?? Date.now)()}`,
        scope: "workspace/den-server",
        text: `Requests waiting for your Allow could not be read back after a restart (${why}). They are lost; agents that ask again are shown here.`,
        msg: { key: "bell.m.heldLostAll", vars: {} },
        link: heldLink(undefined, undefined),
      });
    } catch {
      /* the bell is best effort */
    }
    return "nobody to tell (unreadable queue)";
  }
  if (isUpdateAskRequest(a)) return "update ask";
  let project: string | undefined;
  try {
    project = d.projectOf?.(a);
  } catch {
    project = undefined;
  }
  const what = a.summary;
  try {
    d.store.add({
      kind: "service",
      subject: `${LOST_SUBJECT_PREFIX}${a.id}`,
      scope: `workspace/${project || "den-server"}`,
      text: a.agent
        ? `${a.agent}'s request was lost at a restart: ${what}. Nothing ran from it; the agent was told to ask again.`
        : `A request was lost at a restart: ${what}. Nothing ran from it.`,
      msg: a.agent
        ? { key: "bell.m.heldLost", vars: { name: a.agent, what } }
        : { key: "bell.m.heldLostAsk", vars: { what } },
      link: heldLink(a.agent, project),
    });
  } catch {
    /* the bell is best effort */
  }
  if (!a.actor.startsWith("agent:")) return "not an agent";
  if (!d.tell) return "nobody to tell";
  try {
    return await d.tell(a.actor.slice("agent:".length), lostNotice(a, why));
  } catch (e) {
    return `not told: ${(e as Error)?.message ?? String(e)}`;
  }
}
