/**
 * 0.4.40 comment delivery, the loop (MENTION-DELIVERY-API §3, §4, §4b).
 *
 * Takes deliveries from Hub (the stream, else the list), de-dups them by
 * id, and hands each to its agent:
 * - no such agent here: ack `refused`;
 * - stopped: ack `queued`; it goes in when the agent next runs;
 * - mid-turn: kept until the turn ends;
 * - waiting for its person: typed into its session (the same path as a
 *   keystroke from the pane), then ack `delivered` and `working`.
 * While the turn that took it runs: `working` again every heartbeat. When
 * the turn ends: `done`. When the agent stops first: `failed`.
 *
 * Hub and the agents are injected (tests use fakes); no timers of its own
 * but the ones `deps` gives.
 */
import {
  ackBody,
  deliveryRaw,
  deliveryText,
  parseDelivery,
  SseReader,
  type AckState,
  type Delivery,
  type DeliveryOwner,
  type SeenDeliveries,
} from "./hub-delivery.js";

export type AgentState = "missing" | "stopped" | "busy" | "idle";

export interface DeliveryHub {
  /** The stream's body as text chunks, from `lastId`; throws when it can't open. */
  stream(lastId: string | null, signal: AbortSignal): AsyncIterable<string>;
  list(after: string | null): Promise<unknown[]>;
  ack(id: string, body: Record<string, unknown>): Promise<void>;
}

export interface DeliveryAgents {
  /** busy: mid-turn, or Den can't tell (never typed into then). */
  state(agent: string): Promise<AgentState>;
  /** Type `text` into the agent's session, then Enter. False when it couldn't. */
  type(agent: string, text: string): Promise<boolean>;
}

export interface DeliveryLoopDeps {
  hub: DeliveryHub;
  agents: DeliveryAgents;
  owner: () => DeliveryOwner;
  seen: SeenDeliveries;
  /** hub.delivery_heartbeat_seconds (default 15), in ms. */
  heartbeatMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The stream's reconnect wait: first, and the cap. */
  retryMs?: { first: number; max: number };
  /** How often the list is read when Hub has no stream (404). */
  pollMs?: number;
  log?: (line: string) => void;
  /** NT: the agent finished its Hub comments (done, not failed). */
  finished?: (
    agent: string,
    w: { count: number; artifact?: string; url?: string },
  ) => void;
}

/** What an agent's card shows: "Working on N Hub comments · <artifact>". */
export interface AgentHubWork {
  working: number;
  queued: number;
  artifact?: string;
  url?: string;
}

interface Active {
  ids: string[];
  artifact?: string;
  url?: string;
  /** Seen mid-turn since it was typed: the next idle ends it. */
  sawBusy: boolean;
  typedAt: number;
  lastBeat: number;
}

/** A turn that never shows as started is over after this long. */
const NO_START_MS = 2 * 60_000;

export class DeliveryLoop {
  private readonly queue = new Map<string, Delivery[]>();
  private readonly active = new Map<string, Active>();
  /** The last state each delivery was acked with (a repeat is re-acked). */
  private readonly states = new Map<string, AckState>();
  /** Ids Hub answered 410 for (sent again, or withdrawn): never acked again. */
  private readonly superseded = new Set<string>();
  /**
   * A held delivery a new one repeats (the same agent, thread, author and
   * words: Hub's Try again): new id → the old ids it took the place of.
   * Their acks follow the new one's; Hub answers 410 for a superseded one.
   */
  private readonly replaced = new Map<string, string[]>();
  /**
   * Agents being typed into right now. take() and the tick both pump; one
   * typing must not let the other type the same comments again while the
   * paste is under way (the 0.4.40 gate's bug 1).
   */
  private readonly typing = new Set<string>();
  /** What persist() last wrote. */
  private persisted = "null";
  private readonly hb: number;
  private readonly now: () => number;

  constructor(private readonly d: DeliveryLoopDeps) {
    this.hb = d.heartbeatMs ?? 15_000;
    this.now = d.now ?? Date.now;
    this.restore();
  }

  /**
   * What a Den restart left: queued comments queue again; typed ones are
   * active again, so the agent's state settles them (its turn may still be
   * running: sessions outlive Den).
   */
  private restore(): void {
    this.persisted = JSON.stringify(this.d.seen.held ?? null);
    const h = this.d.seen.held as {
      queue?: Record<string, unknown[]>;
      active?: Record<string, Partial<Active>>;
    } | null;
    if (!h || typeof h !== "object") return;
    for (const [agent, list] of Object.entries(h.queue ?? {})) {
      if (!Array.isArray(list)) continue;
      const q = list
        .map((r) => parseDelivery(r))
        .filter((x): x is Delivery => !!x && x.agent === agent);
      if (q.length) this.queue.set(agent, q);
    }
    for (const [agent, a] of Object.entries(h.active ?? {})) {
      if (!a || !Array.isArray(a.ids) || !a.ids.length) continue;
      const ids = a.ids.filter((x): x is string => typeof x === "string");
      const typedAt = typeof a.typedAt === "number" ? a.typedAt : this.now();
      this.active.set(agent, {
        ids,
        ...(typeof a.artifact === "string" ? { artifact: a.artifact } : {}),
        ...(typeof a.url === "string" ? { url: a.url } : {}),
        sawBusy: a.sawBusy === true,
        typedAt,
        lastBeat: this.now(),
      });
      for (const id of ids) this.states.set(id, "working");
    }
  }

  /** Save what's held, for restore(). */
  private persist(): void {
    const queue: Record<string, unknown[]> = {};
    for (const [a, q] of this.queue)
      if (q.length) queue[a] = q.map(deliveryRaw);
    const active: Record<string, Active> = {};
    for (const [a, v] of this.active) active[a] = v;
    const empty = !Object.keys(queue).length && !Object.keys(active).length;
    const next = empty ? null : { queue, active };
    // The tick calls this every 2 s: write only what changed.
    const key = JSON.stringify(next);
    if (key === this.persisted) return;
    this.persisted = key;
    this.d.seen.setHeld(next);
  }

  /** The card line's numbers for `agent`, or null when there's nothing. */
  work(agent: string): AgentHubWork | null {
    const a = this.active.get(agent);
    const q = this.queue.get(agent)?.length ?? 0;
    if (!a && !q) return null;
    const first = a ?? undefined;
    const next = this.queue.get(agent)?.[0];
    return {
      working: a?.ids.length ?? 0,
      queued: q,
      ...((first?.artifact ?? next?.thread.artifact)
        ? { artifact: first?.artifact ?? next?.thread.artifact }
        : {}),
      ...((first?.url ?? next?.thread.url)
        ? { url: first?.url ?? next?.thread.url }
        : {}),
    };
  }

  private async ack(
    id: string,
    state: AckState,
    o: { reason?: string; version?: number } = {},
  ): Promise<void> {
    if (this.superseded.has(id)) return;
    for (const old of this.replaced.get(id) ?? [])
      await this.ack(old, state, o);
    this.states.set(id, state);
    try {
      await this.d.hub.ack(id, ackBody(state, o));
    } catch (e) {
      // Hub sent it again under a new id (Try again), or withdrew it: this
      // id is done with. Dropped from what's held, so a held one isn't
      // typed as well as its new copy; never acked again.
      const sup = (e as { status?: number; body?: Record<string, unknown> })
        ?.body?.superseded_by;
      if (
        (e as { status?: number })?.status === 410 &&
        typeof sup === "string"
      ) {
        this.drop(id);
        this.d.log?.(
          `hub delivery ${id}: ${sup === "withdrawn" ? "withdrawn on Hub" : `sent again as ${sup.slice(0, 64)}`}: dropped`,
        );
        return;
      }
      // Unacked: Hub sends it again, and the repeat is re-acked.
      this.d.log?.(
        `hub delivery ${id}: ack ${state} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      );
    }
  }

  /** Forget a delivery Hub superseded: out of every queue and turn. */
  private drop(id: string): void {
    this.superseded.add(id);
    for (const [agent, q] of this.queue) {
      const left = q.filter((dv) => dv.id !== id);
      if (left.length === q.length) continue;
      if (left.length) this.queue.set(agent, left);
      else this.queue.delete(agent);
    }
    for (const [agent, act] of this.active) {
      if (!act.ids.includes(id)) continue;
      // A new array: a loop acking the old one goes on undisturbed.
      act.ids = act.ids.filter((x) => x !== id);
      if (!act.ids.length) this.active.delete(agent);
    }
    this.persist();
  }

  /** One delivery from Hub (the stream or the list). */
  async take(raw: unknown): Promise<void> {
    const dv = parseDelivery(raw);
    if (!dv) return;
    if (this.d.seen.has(dv.id) || this.states.has(dv.id)) {
      const st = this.states.get(dv.id);
      // A repeat: Hub didn't get the ack; say it again (never twice to the agent).
      if (st) await this.ack(dv.id, st);
      return;
    }
    this.d.seen.add(dv.id);
    const s = await this.d.agents.state(dv.agent);
    if (s === "missing") {
      await this.ack(dv.id, "refused", {
        reason: "This install has no agent with that id.",
      });
      return;
    }
    // Hub's Try again on one still held here: the new copy takes its
    // place, so the comment is typed once.
    const same = (a: Delivery) =>
      a.thread.id === dv.thread.id &&
      a.author.id === dv.author.id &&
      a.body === dv.body &&
      (a.forwarded?.body ?? "") === (dv.forwarded?.body ?? "");
    const q = (this.queue.get(dv.agent) ?? []).filter((a) => {
      if (!same(a)) return true;
      this.replaced.set(dv.id, [...(this.replaced.get(dv.id) ?? []), a.id]);
      return false;
    });
    q.push(dv);
    this.queue.set(dv.agent, q);
    this.persist();
    if (s === "stopped") await this.ack(dv.id, "queued");
    await this.pumpOne(dv.agent, s);
  }

  /** Every agent with work: hand over, beat, finish. Run on a tick. */
  async pump(): Promise<void> {
    const agents = new Set([...this.queue.keys(), ...this.active.keys()]);
    for (const a of agents) await this.pumpOne(a, await this.d.agents.state(a));
  }

  private async pumpOne(agent: string, s: AgentState): Promise<void> {
    // Another pump is typing into this agent: it settles the rest.
    if (this.typing.has(agent)) return;
    try {
      await this.pumpOneNow(agent, s);
    } finally {
      this.persist();
    }
  }

  private async pumpOneNow(agent: string, s: AgentState): Promise<void> {
    const now = this.now();
    const act = this.active.get(agent);
    if (act) {
      if (s === "busy") {
        act.sawBusy = true;
        if (now - act.lastBeat >= this.hb) {
          act.lastBeat = now;
          for (const id of act.ids) await this.ack(id, "working");
        }
        return;
      }
      if (s === "idle" && (act.sawBusy || now - act.typedAt >= NO_START_MS)) {
        this.active.delete(agent);
        for (const id of act.ids) await this.ack(id, "done");
        try {
          this.d.finished?.(agent, {
            count: act.ids.length,
            ...(act.artifact ? { artifact: act.artifact } : {}),
            ...(act.url ? { url: act.url } : {}),
          });
        } catch {
          // The bell's trouble never stops delivery.
        }
      } else if (s === "stopped" || s === "missing") {
        this.active.delete(agent);
        for (const id of act.ids)
          await this.ack(id, "failed", {
            reason: "The agent stopped before it finished.",
          });
        return;
      } else return;
    }
    const q = this.queue.get(agent);
    if (!q?.length) {
      this.queue.delete(agent);
      return;
    }
    if (s === "stopped") {
      for (const dv of q)
        if (this.states.get(dv.id) !== "queued")
          await this.ack(dv.id, "queued");
      return;
    }
    if (s !== "idle") return;
    const o = this.d.owner();
    const texts = q.map((dv) => deliveryText(dv, o));
    const text =
      q.length === 1
        ? texts[0]
        : [`${q.length} Hub comments:`, ...texts].join("\n\n---\n\n");
    // Claim them before the paste: the queue keeps only what comes after.
    this.queue.delete(agent);
    this.typing.add(agent);
    let typed = false;
    try {
      typed = await this.d.agents.type(agent, text);
    } finally {
      this.typing.delete(agent);
      if (!typed)
        this.queue.set(agent, [...q, ...(this.queue.get(agent) ?? [])]);
    }
    if (!typed) return;
    this.active.set(agent, {
      ids: q.map((dv) => dv.id),
      artifact: q[0].thread.artifact,
      url: q[0].thread.url || undefined,
      sawBusy: false,
      typedAt: now,
      lastBeat: now,
    });
    for (const dv of q) {
      await this.ack(dv.id, "delivered");
      await this.ack(dv.id, "working");
    }
  }

  /**
   * Read Hub until `signal` aborts: the stream, reconnecting from the last
   * id with backoff; when Hub has no stream (a 4xx refusal), the list
   * every pollMs.
   */
  async run(signal: AbortSignal): Promise<void> {
    const sleep =
      this.d.sleep ??
      ((ms: number, sig: AbortSignal) =>
        new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          t.unref?.();
          sig.addEventListener("abort", () => (clearTimeout(t), r()), {
            once: true,
          });
        }));
    const first = this.d.retryMs?.first ?? 1000;
    const max = this.d.retryMs?.max ?? 60_000;
    let wait = first;
    while (!signal.aborted) {
      let refused = false;
      try {
        const reader = new SseReader();
        for await (const chunk of this.d.hub.stream(this.d.seen.last, signal)) {
          wait = first;
          for (const ev of reader.feed(chunk)) {
            if (ev.event !== "delivery") continue;
            let v: unknown;
            try {
              v = JSON.parse(ev.data);
            } catch {
              continue;
            }
            await this.take(v);
            const id = ev.id ?? parseDelivery(v)?.id;
            if (id) this.d.seen.setLast(id);
          }
          if (signal.aborted) return;
        }
      } catch (e) {
        if (signal.aborted) return;
        refused = (e as { kind?: string })?.kind === "refused";
        if (!refused)
          this.d.log?.(
            `hub deliveries: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
          );
      }
      if (refused) {
        await this.poll();
        await sleep(this.d.pollMs ?? 30_000, signal);
        continue;
      }
      await sleep(wait, signal);
      wait = Math.min(max, wait * 2);
    }
  }

  /** The list after the last id, oldest first (Hub has no stream). */
  async poll(): Promise<void> {
    let list: unknown[];
    try {
      list = await this.d.hub.list(this.d.seen.last);
    } catch {
      return;
    }
    for (const v of list) {
      await this.take(v);
      const id = parseDelivery(v)?.id;
      if (id) this.d.seen.setLast(id);
    }
  }
}
