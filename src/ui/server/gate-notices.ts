/**
 * Issue 714: Den tells its agents about the gate slots they hold over MCP.
 *
 * An agent that asked with gate_slot_request and was put in line often
 * goes idle. When its slot is granted, Den types a line into its session
 * (the relayed-message path, hub-delivery-service relayMessage: typed only
 * at its input prompt, held with a reason otherwise), so it wakes and
 * claims the slot. When it didn't claim in time and the slot passed on, it
 * is told it is back in line. When its lease lapsed, the bell names it (the
 * agent hears it at its next tool call, mcp/tools.ts).
 *
 * The machine's slot store is shared by every install: only rows for this
 * install's agents (the entry's `install`) are told here. Each tick settles
 * the queue (so a slot passes on, or lapses, even when nobody else looks)
 * and reads the slot log's new rows.
 */
import type { NotificationStore } from "../../shared/notifications.js";
import { embedDelivery, type Delivery } from "../../shared/hub-delivery.js";
import type { GateStore, GateEventRow } from "../../shared/gates/store.js";
import { gateOverrunWaiting } from "./gate-overrun-bell.js";

export interface GateNoticeDeps {
  store: () => GateStore;
  /** This install's state dir, as its MCP servers record it. */
  install: string;
  /** An agent's project here, or null when it isn't this install's. */
  projectOf: (agent: string) => string | null;
  /** Hold a line for the agent, typed at its prompt; false when not ready. */
  relay: (dv: Delivery) => Promise<boolean>;
  bell: (n: Parameters<NotificationStore["add"]>[0]) => void;
  log?: (line: string) => void;
  /** The clock (tests); default Date.now. */
  now?: () => number;
}

/** How often the server looks, ms. */
export const GATE_NOTICE_MS = 10_000;

const agentOf = (actor: string | undefined) =>
  actor?.startsWith("agent:") ? actor.slice("agent:".length) : null;

const mins = (n: number) => `${Math.max(1, Math.round(n))} min`;

export class GateNotices {
  private from = 0;
  /** Lines the relay wasn't ready for: tried again next tick. */
  private pending: Delivery[] = [];
  /**
   * Issue 993: overrun slots whose agent was told (once per slot). Kept in
   * memory: after a server restart a still-overrun slot's agent is told
   * once more.
   */
  private toldOverrun = new Set<string>();

  constructor(private readonly d: GateNoticeDeps) {}

  /** Start reading at the log's end: rows from before are not told again. */
  start(): void {
    this.from = this.d.store().eventsEnd();
  }

  async tick(): Promise<void> {
    const store = this.d.store();
    store.list(); // settles: passes on the unclaimed, takes back the lapsed
    const { rows, next } = store.eventsFrom(this.from);
    this.from = next;
    const out = this.pending.splice(0);
    for (const r of rows) {
      if (!r.install || r.install !== this.d.install) continue;
      const agent = agentOf(r.actor);
      if (!agent) continue;
      const project = this.d.projectOf(agent);
      if (!project) continue;
      if (r.event === "taken-back-lapsed") {
        this.lapsedBell(r, agent, project);
        continue;
      }
      const text = this.textOf(store, r);
      if (text)
        out.push(
          embedDelivery({
            id: `gate-${r.id}-${r.event}-${Date.parse(r.at)}`,
            agent,
            project,
            origin: "Den gate slots",
            text,
            at: Date.parse(r.at),
          }),
        );
    }
    out.push(...this.overrunLines(store));
    for (const dv of out) {
      let held = false;
      try {
        held = await this.d.relay(dv);
      } catch {
        held = false;
      }
      if (!held) this.pending.push(dv);
    }
  }

  /**
   * Issue 993: an agent's slot held past the multiple of its estimate: one
   * line at its prompt, once per slot. A slot asked over MCP is told only
   * by the install that asked; a gate run's by the install the agent is in.
   */
  private overrunLines(store: GateStore): Delivery[] {
    // The store's own clock unless told (its tests set it).
    const now = this.d.now ? this.d.now() : store.clock();
    const entries = store.list();
    const live = new Set(entries.map((e) => e.id));
    for (const id of this.toldOverrun)
      if (!live.has(id)) this.toldOverrun.delete(id);
    const out: Delivery[] = [];
    for (const w of gateOverrunWaiting(entries, store.settings(), now)) {
      if (!w.agent || this.toldOverrun.has(w.id)) continue;
      const e = entries.find((x) => x.id === w.id);
      if (e?.mcp && e.mcp.install !== this.d.install) continue;
      const project = this.d.projectOf(w.agent);
      if (!project) continue;
      this.toldOverrun.add(w.id);
      out.push(
        embedDelivery({
          id: `gate-overrun-${w.id}`,
          agent: w.agent,
          project,
          origin: "Den gate slots",
          text: `Den: your ${w.slot} gate slot ${w.id} ("${w.label}") is ${mins(w.overMin)} past its ${mins(w.estimateMin)} estimate. Release it with gate_slot_release, or let its command finish.`,
          at: now,
        }),
      );
    }
    return out;
  }

  private textOf(store: GateStore, r: GateEventRow): string | null {
    if (r.event === "granted" && r.claimBy) {
      // Claimed already (it asked again meanwhile): nothing to tell.
      if (store.peek(r.id)?.mcp?.claimBy !== r.claimBy) return null;
      return `Den: your ${r.kind} slot is granted: ${r.id}. Call gate_slot_request with this id to start; it passes to the next in line after ${mins((Date.parse(r.claimBy) - Date.parse(r.at)) / 60_000)}.`;
    }
    if (r.event === "passed-unclaimed") {
      const place = store.place(r.id);
      const where =
        place > 0
          ? `You are back in line (place ${place}); Den tells you when it is yours again.`
          : "Ask gate_slot_request again when you are ready.";
      return `Den: your ${r.kind} slot ${r.id} passed to the next in line: it wasn't claimed within ${mins(store.settings().claimMinutes)}. ${where}`;
    }
    return null;
  }

  private lapsedBell(r: GateEventRow, agent: string, project: string): void {
    try {
      this.d.bell({
        kind: "service",
        subject: `record:gate-lapsed-${r.id}`,
        scope: `workspace/${project}`,
        text: `${agent}'s ${r.kind} gate slot "${r.label}" lapsed: not renewed, and past its estimate. The next in line started.`,
        msg: {
          key: "bell.m.gateLapsed",
          vars: { name: agent, kind: r.kind, label: r.label },
        },
        link: "/agents",
      });
    } catch (e) {
      this.d.log?.(
        `gate notices: the bell: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      );
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/** The server's loop: one GateNotices, ticked every GATE_NOTICE_MS. */
export function startGateNotices(d: GateNoticeDeps): GateNotices {
  const n = new GateNotices(d);
  n.start();
  if (timer) clearInterval(timer);
  let busy = false;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    n.tick()
      .catch((e) =>
        d.log?.(
          `gate notices: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        ),
      )
      .finally(() => (busy = false));
  }, GATE_NOTICE_MS);
  timer.unref();
  return n;
}
