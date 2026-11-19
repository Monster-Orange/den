/**
 * Idle flag, as this server shows it: a gate slot held by one of this
 * install's agents, whose run sat idle well past its estimate (the store's
 * idle flag, gates/store.ts), rings that agent's project bell once, under
 * Needs you. The flag only says so; nothing here stops a run. Its owner or
 * a person cancels it (`gate cancel`, Stop on the Agents page), or a
 * waiting release run may after the grace, naming who and why.
 */
import { listRecords } from "../../shared/agents/records.js";
import { minutesPast } from "../../shared/gates/rules.js";
import { GateStore } from "../../shared/gates/store.js";
import type { NotificationStore } from "../../shared/notifications.js";
import { getStateDir } from "../../shared/paths.js";

/** How often the slots are looked at: a beat, not a limit. */
const CHECK_MS = 60_000;

export interface GateIdleBellDeps {
  store: Pick<GateStore, "list">;
  bell: Pick<NotificationStore, "add">;
  /** This install's agents. */
  records: () => { id: string; workspace: string }[];
  /** The flags already rung (slot id and when it was flagged). */
  rung: Set<string>;
  now: () => number;
}

/** Rings once for each newly flagged slot an agent here holds. */
export function ringIdleGates(d: GateIdleBellDeps): string[] {
  const mine = new Map(d.records().map((r) => [`agent:${r.id}`, r]));
  const rang: string[] = [];
  for (const e of d.store.list()) {
    if (!e.grantedAt || !e.idleAt || !e.actor) continue;
    const rec = mine.get(e.actor);
    const key = `${e.id}@${e.idleAt}`;
    if (!rec || d.rung.has(key)) continue;
    d.rung.add(key);
    const n = minutesPast(e, d.now());
    try {
      d.bell.add({
        kind: "decision",
        subject: `gate:${e.id}`,
        scope: `workspace/${rec.workspace}`,
        text: `Test run ${e.label} is idle ${n} min past its estimate and holds its gate slot`,
        msg: { key: "bell.m.gateIdle", vars: { label: e.label, n } },
        link: `/agents?project=${encodeURIComponent(rec.workspace)}`,
      });
      rang.push(e.id);
    } catch {
      /* the bell is best effort: gate status still says it */
    }
  }
  return rang;
}

let timer: NodeJS.Timeout | undefined;

export function startGateIdleBell(): void {
  if (timer) return;
  let deps: GateIdleBellDeps | null = null;
  const beat = async () => {
    try {
      if (!deps) {
        const { notificationDeps } = await import("./notification-service.js");
        deps = {
          store: new GateStore(),
          bell: notificationDeps().store,
          records: () => listRecords(getStateDir()),
          rung: new Set(),
          now: Date.now,
        };
      }
      ringIdleGates(deps);
    } catch {
      /* the next beat tries again */
    }
  };
  timer = setInterval(() => void beat(), CHECK_MS);
  timer.unref();
}
