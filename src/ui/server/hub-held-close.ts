import type { NotificationStore } from "../../shared/notifications.js";
import type { Approval } from "./approvals.js";
import { heldLink, LOST_SUBJECT_PREFIX } from "./held-bell.js";

export const HUB_HELD_ACTIONS: ReadonlySet<string> = new Set([
  "hub_link",
  "hub_project_create",
]);

export interface HubHeldCloseDeps {
  pending: () => Approval[];
  end: (id: string, why: string) => Approval | null;
  store: Pick<NotificationStore, "add">;
  tell?: (agent: string, text: string) => Promise<string>;
  projectOf?: (a: Approval) => string | undefined;
  synced?: () => void;
}

export function hubClosedNotice(
  a: Pick<Approval, "id" | "action" | "summary">,
  from: string,
  to: string,
): string {
  return (
    `Den: your request ${a.id} (${a.action}: ${a.summary}) was closed: it named the Hub at ${from}, and Den has moved to ${to}. ` +
    `Nothing ran from it. If it still applies, ask again (call ${a.action} again) for the new Hub.`
  );
}

function ring(
  store: HubHeldCloseDeps["store"],
  n: Parameters<HubHeldCloseDeps["store"]["add"]>[0],
): boolean {
  try {
    store.add(n);
    return true;
  } catch {
    return false;
  }
}

export async function closeHubHeld(
  d: HubHeldCloseDeps,
  from: string,
  to: string,
): Promise<string[]> {
  const why = `It named the Hub at ${from}, and Den moved to ${to}.`;
  const closed: Approval[] = [];
  for (const p of d.pending()) {
    if (!HUB_HELD_ACTIONS.has(p.action)) continue;
    const a = d.end(p.id, why);
    if (a) closed.push(a);
  }
  for (const a of closed) {
    let project: string | undefined;
    try {
      project = d.projectOf?.(a);
    } catch {
      project = undefined;
    }
    const what = a.summary;
    ring(d.store, {
      kind: "service",
      subject: `${LOST_SUBJECT_PREFIX}${a.id}`,
      scope: `workspace/${project || "den-server"}`,
      text: `${a.agent ? `${a.agent}'s request` : "A request"} named the Hub at ${from}, so Den closed it on moving to ${to}: ${what}. Nothing ran from it.`,
      msg: a.agent
        ? {
            key: "bell.m.heldClosedHub",
            vars: { name: a.agent, what, from, to },
          }
        : { key: "bell.m.heldClosedHubAsk", vars: { what, from, to } },
      link: heldLink(a.agent, project),
    });
    if (d.tell && a.actor.startsWith("agent:"))
      await d
        .tell(a.actor.slice("agent:".length), hubClosedNotice(a, from, to))
        .catch(() => "");
  }
  if (closed.length) d.synced?.();
  return closed.map((a) => a.id);
}
