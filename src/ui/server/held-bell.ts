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
import type { Approval } from "./approvals.js";

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
  if (!agent) return "/agents";
  const q = new URLSearchParams();
  if (project) q.set("project", project);
  q.set("agent", agent);
  return `/agents?${q.toString()}`;
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
    const n = store.add({
      kind: "decision",
      subject,
      scope: `workspace/${project || "den-server"}`,
      text: a.agent
        ? `${a.agent} waits for your Allow: ${what}`
        : `Waiting for your Allow: ${what}`,
      msg: a.agent
        ? { key: "bell.m.heldAllow", vars: { name: a.agent, what } }
        : { key: "bell.m.heldAllowAsk", vars: { what } },
      link: heldLink(a.agent, project),
    });
    if (n) added++;
  }
  return { added, removed };
}
