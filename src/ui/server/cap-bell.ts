import { readRecord } from "../../shared/agents/records.js";
import type { NotificationStore } from "../../shared/notifications.js";

export type CapHeld = {
  n: number;
  limit: number;
  key: string;
  project?: string;
};

const PROJECT_CAP =
  /^(\d+) agents? (?:is|are) running in project (\S+) and its cap is (\d+) \((\S+)\)$/;
const MACHINE_CAP =
  /^(\d+) agents? (?:is|are) running and (agents\.max_concurrent) is (\d+)$/;

export function capHeldOf(why: string): CapHeld | null {
  const p = PROJECT_CAP.exec(why);
  if (p)
    return { n: Number(p[1]), limit: Number(p[3]), key: p[4], project: p[2] };
  const m = MACHINE_CAP.exec(why);
  if (m) return { n: Number(m[1]), limit: Number(m[3]), key: m[2] };
  return null;
}

export function noteCapHeld(
  store: Pick<NotificationStore, "add">,
  who: { agent: string; name: string; project: string; why: string },
): boolean {
  const cap = capHeldOf(who.why);
  if (!cap) return false;
  store.add({
    kind: "service",
    subject: `record:cap-held:${who.agent}`,
    scope: `workspace/${who.project}`,
    text: `${who.name} didn't start: ${who.why}`,
    msg: {
      key: "bell.m.capHeld",
      vars: { name: who.name, n: cap.n, limit: cap.limit, key: cap.key },
    },
    link: `/agents?project=${encodeURIComponent(who.project)}&agent=${encodeURIComponent(who.agent)}`,
  });
  return true;
}

export async function noteCapsHeld(
  stateDir: string,
  failed: readonly { agent: string; why: string }[],
  store?: Pick<NotificationStore, "add">,
): Promise<number> {
  let bell = store;
  let n = 0;
  for (const x of failed) {
    if (!capHeldOf(x.why)) continue;
    const rec = readRecord(stateDir, x.agent);
    if (!rec) continue;
    bell ??= (await import("./notification-service.js")).notificationDeps()
      .store;
    if (
      noteCapHeld(bell, {
        agent: rec.id,
        name: rec.displayName ?? rec.id,
        project: rec.workspace,
        why: x.why,
      })
    )
      n++;
  }
  return n;
}
