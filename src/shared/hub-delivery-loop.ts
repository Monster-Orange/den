/**
 * 0.4.40 comment delivery, the loop (MENTION-DELIVERY-API §3, §4, §4b).
 *
 * Takes deliveries from Hub (the stream, else the list), de-dups them by
 * id, and hands each to its agent:
 * - no such agent here: ack `refused`;
 * - stopped: ack `queued`; it goes in when the agent next runs;
 * - mid-turn: kept until the turn ends;
 * - issue 701: whatever holds it, Hub hears `queued` with the reason in
 *   plain words, once per reason (kept across a restart);
 * - waiting for its person: typed into its session (the same path as a
 *   keystroke from the pane), then ack `delivered` and `working`.
 * Issue 334: a web app's relayed message (EMBED_PREFIX) takes the same
 * path, never acked: typed only when the agent is idle, never mid-turn.
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
  EMBED_PREFIX,
  isOwner,
  LOCAL_PREFIX,
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
  /**
   * Issue 664: whether the last state() found the agent's turn over but
   * its input prompt not shown (so "busy"): what waits says why.
   */
  notAtPrompt?(agent: string): boolean;
  /**
   * Issue 701: why a busy agent holds its deliveries (a dialog on its
   * screen, a held Allow, a pause), or null: mid-turn.
   */
  why?(agent: string): Promise<HeldCode | null>;
}

/** Issue 664: why an agent's held text waits, when Den knows. */
export type HeldWhy = "not_at_prompt";

/** Issue 701: every reason a delivery waits. */
export const HELD_CODES = [
  "busy",
  "not_at_prompt",
  "trust",
  "permission",
  "approval",
  "paused",
  "stopped",
  "owner",
  "unread",
] as const;
export type HeldCode = (typeof HELD_CODES)[number];

/** Issue 701: Hub's words for each reason (it shows them on the comment). */
export const HELD_WORDS: Record<HeldCode, string> = {
  busy: "the agent is busy with a turn",
  not_at_prompt:
    "the agent's turn is over, but its input prompt isn't on its screen yet",
  trust: "a question about trusting its folder is on its screen",
  permission: "a permission question is on its screen",
  approval: "it waits for its person to Allow a change",
  paused: "it is paused after a compaction loop until its person goes on",
  stopped: "the agent isn't running; typed when it next runs",
  owner: "still asking Hub who its person is; typed once Hub answers",
  unread: "couldn't read the agent's state in time; trying again",
};

/** Issue 701: a time limit ran out (never a real value). */
const LATE = Symbol("late");

export interface DeliveryLoopDeps {
  hub: DeliveryHub;
  agents: DeliveryAgents;
  /**
   * Who the agent's person is in Hub, or null while Den doesn't know yet
   * (Hub didn't answer). Null holds deliveries: a person's edit request
   * never reaches the agent as "someone else".
   */
  owner: () => DeliveryOwner | null;
  /** Called when a delivery waits on the owner: look it up again. */
  ownerWanted?: () => void;
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
  /**
   * Issue 271: Hub pushed a held change's decision (kind "held"), once
   * per delivery: Den reads its waiting asks again (a new Hub project
   * links on its own).
   */
  held?: (dv: Delivery) => void;
  /**
   * Issue 664: `n` items have waited `waitedMs` for `agent` because it
   * isn't at its prompt (said every pump while it lasts); n 0: no longer.
   * Issue 701: for every reason it waits (`why`).
   */
  heldNote?: (
    agent: string,
    n: number,
    waitedMs: number,
    why?: HeldCode,
  ) => void;
  /**
   * Issue 701: hub.delivery_state_timeout_seconds / _type_timeout_seconds
   * (60 s, 120 s), in ms: the longest one agent's state read or paste
   * holds the pump. The others never wait on it.
   */
  stateTimeoutMs?: number;
  typeTimeoutMs?: number;
  /**
   * Issue 701: hub.delivery_answer_minutes (30), in ms: a typed comment
   * whose turn never shows as ended is "delivered, no answer yet" after
   * it, and the agent's next comments go on.
   */
  answerTimeoutMs?: number;
  /** Issue 701: typed comments that had no answer in answerTimeoutMs. */
  noAnswer?: (
    agent: string,
    w: { count: number; minutes: number; artifact?: string; url?: string },
  ) => void;
  /**
   * Issue 701: a comment from the agent's own person was typed into it:
   * a question it asked that person is answered.
   */
  answered?: (agent: string) => void;
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
  /** Issue 664: why the queued ones wait, when Den knows. */
  held?: HeldWhy;
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

/** Issue 701: the reason a restored delivery was last acked held with. */
const heldWhy = new WeakMap<Delivery, string>();

/** What Den's held file brings back: a delivery, and Den's own text for an inbox item. */
function parseHeld(r: unknown): Delivery | null {
  const dv = parseDelivery(r);
  if (!dv) return null;
  const why = (r as { held_reason?: unknown }).held_reason;
  if (typeof why === "string") heldWhy.set(dv, why.slice(0, 300));
  const text = (r as { text?: unknown }).text;
  if (dv.id.startsWith(LOCAL_PREFIX) && typeof text === "string")
    dv.text = text.slice(0, 40_000);
  return dv;
}

export class DeliveryLoop {
  private readonly queue = new Map<string, Delivery[]>();
  private readonly active = new Map<string, Active>();
  /** The last state each delivery was acked with (a repeat is re-acked). */
  private readonly states = new Map<string, AckState>();
  /** Ids Hub answered 410 for (sent again, or withdrawn): never acked again. */
  private readonly superseded = new Set<string>();
  /** Issue 701: the reason each held delivery was last acked `queued` with. */
  private readonly heldReason = new Map<string, string>();
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
  /** Thread id → the newest Hub delivery's time on it (issue 166 de-dup). */
  private readonly threadsAt = new Map<string, number>();
  /**
   * #248: agents whose queue waits while they're busy (or held for their
   * person), said once until it's typed.
   */
  private readonly waitSaid = new Set<string>();
  /** Issue 664: agents whose queue waits because they aren't at their prompt, since when. */
  private readonly notAtPrompt = new Map<string, number>();
  /** Issue 701: why each agent's queue waits now, and since when. */
  private readonly heldCode = new Map<string, HeldCode>();
  private readonly heldSince = new Map<string, number>();
  /** Issue 701: agents being pumped now (the next tick leaves them be). */
  private readonly inflight = new Set<string>();
  /** Issue 701: agents whose last state read ran out of time. */
  private readonly unread = new Set<string>();
  /** What persist() last wrote. */
  private persisted = "null";
  private readonly hb: number;
  private readonly stateMs: number;
  private readonly typeMs: number;
  private readonly answerMs: number;
  private readonly now: () => number;

  constructor(private readonly d: DeliveryLoopDeps) {
    this.hb = d.heartbeatMs ?? 15_000;
    this.stateMs = d.stateTimeoutMs ?? 60_000;
    this.typeMs = d.typeTimeoutMs ?? 120_000;
    this.answerMs = d.answerTimeoutMs ?? 30 * 60_000;
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
        .map((r) => parseHeld(r))
        .filter((x): x is Delivery => !!x && x.agent === agent);
      for (const dv of q) {
        const why = heldWhy.get(dv);
        if (why) this.heldReason.set(dv.id, why);
      }
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
    // #248: say what a restart brought back, so a later typing of it
    // isn't a mystery.
    for (const [agent, q] of this.queue)
      this.d.log?.(
        `hub delivery: restored ${q.length} held Hub item${q.length === 1 ? "" : "s"} for ${agent}; typed when it's idle`,
      );
    for (const [agent, a] of this.active)
      this.d.log?.(
        `hub delivery: restored ${a.ids.length} typed Hub item${a.ids.length === 1 ? "" : "s"} for ${agent}; done when its turn ends`,
      );
  }

  /** Save what's held, for restore(). */
  private persist(): void {
    const queue: Record<string, unknown[]> = {};
    for (const [a, q] of this.queue)
      if (q.length)
        queue[a] = q.map((dv) => {
          const why = this.heldReason.get(dv.id);
          return why
            ? { ...deliveryRaw(dv), held_reason: why }
            : deliveryRaw(dv);
        });
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
      ...(q && this.notAtPrompt.has(agent)
        ? { held: "not_at_prompt" as const }
        : {}),
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
    // Made from Hub's inbox (issue 166): Hub has no ack for it.
    if (id.startsWith(LOCAL_PREFIX)) {
      this.states.set(id, state);
      return;
    }
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
      // Issue 701: Hub has no such delivery: nothing to type it for.
      if ((e as { status?: number })?.status === 404) {
        this.drop(id);
        this.d.log?.(`hub delivery ${id}: not on Hub (404): dropped`);
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
    this.heldReason.delete(id);
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
      const why = this.heldReason.get(dv.id);
      if (st)
        await this.ack(
          dv.id,
          st,
          st === "queued" && why ? { reason: why } : {},
        );
      return;
    }
    if (dv.kind === "held") {
      try {
        this.d.held?.(dv);
      } catch {
        /* the hook's own trouble never stops a delivery */
      }
    }
    const at = Date.parse(dv.createdAt);
    if (dv.thread.id && Number.isFinite(at))
      this.threadsAt.set(
        dv.thread.id,
        Math.max(at, this.threadsAt.get(dv.thread.id) ?? 0),
      );
    await this.hold(dv);
  }

  /**
   * 0.4.51 (issue 166): an item Den made from Hub's inbox (its id starts
   * LOCAL_PREFIX, its text is Den's). Held and typed like a delivery; never
   * acked. False when it was seen before (a restart never repeats it).
   */
  async takeLocal(dv: Delivery): Promise<boolean> {
    if (!dv.id.startsWith(LOCAL_PREFIX)) return false;
    if (this.d.seen.has(dv.id) || this.states.has(dv.id)) return false;
    await this.hold(dv);
    return true;
  }

  /** Whether an inbox item was seen (taken, or passed over). */
  seenLocal(id: string): boolean {
    return this.d.seen.has(id);
  }

  /** Mark an inbox item seen without typing it (older, or a delivery had it). */
  passLocal(id: string): void {
    if (id.startsWith(LOCAL_PREFIX)) this.d.seen.add(id);
  }

  /**
   * Whether Hub's own delivery already brought this thread's comment at
   * `at` or later (a mention is both a delivery and an inbox item).
   */
  coveredThread(thread: string, at: number): boolean {
    const t = this.threadsAt.get(thread);
    return t !== undefined && t >= at;
  }

  private async hold(dv: Delivery): Promise<void> {
    this.d.seen.add(dv.id);
    const s = await this.stateOf(dv.agent);
    if (s === "missing") {
      await this.ack(dv.id, "refused", {
        reason: "This install has no agent with that id.",
      });
      return;
    }
    // Hub's Try again on one still held here: the new copy takes its
    // place, so the comment is typed once.
    const same = (a: Delivery) =>
      !dv.id.startsWith(LOCAL_PREFIX) &&
      !a.id.startsWith(LOCAL_PREFIX) &&
      a.thread.id === dv.thread.id &&
      a.kind === dv.kind &&
      a.version === dv.version &&
      a.author.id === dv.author.id &&
      a.body === dv.body &&
      (a.forwarded?.body ?? "") === (dv.forwarded?.body ?? "");
    const q = (this.queue.get(dv.agent) ?? []).filter((a) => {
      if (!same(a)) return true;
      this.replaced.set(dv.id, [...(this.replaced.get(dv.id) ?? []), a.id]);
      this.d.log?.(
        `hub delivery ${dv.id}: repeats held ${a.id} for ${dv.agent} (Hub's Try again): typed once`,
      );
      return false;
    });
    q.push(dv);
    this.queue.set(dv.agent, q);
    this.persist();
    if (s === "stopped") await this.ackHeld([dv], "stopped");
    await this.pumpAgent(dv.agent, s);
  }

  /** Every agent with work: hand over, beat, finish. Run on a tick. */
  async pump(): Promise<void> {
    const agents = new Set([...this.queue.keys(), ...this.active.keys()]);
    // Issue 701: each on its own; one that hangs never holds the others.
    await Promise.all([...agents].map((a) => this.pumpAgent(a)));
  }

  /** Issue 701: `p`, or LATE once `ms` passed (p goes on unheard). */
  private within<T>(p: Promise<T>, ms: number): Promise<T | typeof LATE> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(LATE), ms);
      (t as { unref?: () => void }).unref?.();
      p.then(
        (v) => (clearTimeout(t), resolve(v)),
        () => (clearTimeout(t), resolve(LATE)),
      );
    });
  }

  /** Issue 701: the agent's state, "busy" when it can't be read in time. */
  private async stateOf(agent: string): Promise<AgentState> {
    const s = await this.within(this.d.agents.state(agent), this.stateMs);
    if (s !== LATE) {
      this.unread.delete(agent);
      return s;
    }
    if (!this.unread.has(agent))
      this.d.log?.(
        `hub delivery: couldn't read ${agent}'s state in ${Math.round(this.stateMs / 1000)}s; held, tried again`,
      );
    this.unread.add(agent);
    return "busy";
  }

  /**
   * Issue 701: pump one agent, unless it is still being pumped. Waits at
   * most its time limits; a paste still under way goes on, and the agent
   * waits for it (never typed twice).
   */
  private async pumpAgent(agent: string, known?: AgentState): Promise<void> {
    if (this.inflight.has(agent)) return;
    this.inflight.add(agent);
    const run = (async () => {
      const s = known ?? (await this.stateOf(agent));
      await this.pumpOne(agent, s);
    })()
      .catch((e) =>
        this.d.log?.(
          `hub delivery: ${agent}: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        ),
      )
      .finally(() => this.inflight.delete(agent));
    await this.within(run, this.stateMs * 2 + this.typeMs);
  }

  private async pumpOne(agent: string, s: AgentState): Promise<void> {
    // Another pump is typing into this agent: it settles the rest.
    if (this.typing.has(agent)) return;
    try {
      await this.pumpOneNow(agent, s);
    } finally {
      this.noteHeld(agent, s);
      this.persist();
    }
  }

  /**
   * Issue 664: an agent's queue waits because its turn is over but its
   * input prompt doesn't show: its row and the bell say so, for as long
   * as it lasts.
   */
  private noteHeld(agent: string, s: AgentState): void {
    const q = this.queue.get(agent)?.length ?? 0;
    // Issue 701: whatever holds it, said with its reason.
    const code = q > 0 ? this.heldCode.get(agent) : undefined;
    const away =
      q > 0 &&
      s === "busy" &&
      !this.active.has(agent) &&
      this.d.agents.notAtPrompt?.(agent) === true;
    const since = this.notAtPrompt.get(agent);
    if (away) {
      if (since === undefined) {
        this.notAtPrompt.set(agent, this.now());
        this.d.log?.(
          `hub delivery: holding ${q} item${q === 1 ? "" : "s"} for ${agent}: it isn't at its prompt`,
        );
      }
    } else if (since !== undefined) this.notAtPrompt.delete(agent);
    const heldAt = this.heldSince.get(agent);
    try {
      if (code && !this.active.has(agent)) {
        const at = heldAt ?? this.now();
        if (heldAt === undefined) this.heldSince.set(agent, at);
        this.d.heldNote?.(agent, q, this.now() - at, code);
      } else if (heldAt !== undefined) {
        this.heldSince.delete(agent);
        this.heldCode.delete(agent);
        this.d.heldNote?.(agent, 0, 0);
      }
    } catch {
      // The bell's trouble never stops delivery.
    }
  }

  private async pumpOneNow(agent: string, s: AgentState): Promise<void> {
    const now = this.now();
    const act = this.active.get(agent);
    if (act && now - act.typedAt >= this.answerMs && s !== "idle") {
      // Issue 701: a turn that never shows as ended stops holding the
      // agent's next comments: Hub and the bell hear "no answer yet".
      this.active.delete(agent);
      const minutes = Math.round((now - act.typedAt) / 60_000);
      for (const id of act.ids)
        await this.ack(id, "delivered", {
          reason: "typed in; no answer yet",
        });
      this.d.log?.(
        `hub delivery: ${act.ids.length} Hub item${act.ids.length === 1 ? "" : "s"} typed into ${agent} ${minutes} min ago, no answer yet: its next ones go on`,
      );
      const hubIds = act.ids.filter((id) => !id.startsWith(LOCAL_PREFIX));
      try {
        if (hubIds.length)
          this.d.noAnswer?.(agent, {
            count: hubIds.length,
            minutes,
            ...(act.artifact ? { artifact: act.artifact } : {}),
            ...(act.url ? { url: act.url } : {}),
          });
      } catch {
        // The bell's trouble never stops delivery.
      }
    } else if (act) {
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
        // Issue 334: a relayed message is no Hub comment for the bell.
        const hubIds = act.ids.filter((id) => !id.startsWith(EMBED_PREFIX));
        try {
          if (hubIds.length)
            this.d.finished?.(agent, {
              count: hubIds.length,
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
      await this.ackHeld(q, "stopped");
      return;
    }
    if (s !== "idle") {
      let why: HeldCode | null = null;
      if (this.unread.has(agent)) why = "unread";
      else {
        const w = this.d.agents.why
          ? await this.within(this.d.agents.why(agent), this.stateMs)
          : null;
        why = w === LATE ? null : w;
      }
      await this.ackHeld(
        q,
        why ??
          (this.d.agents.notAtPrompt?.(agent) === true
            ? "not_at_prompt"
            : "busy"),
      );
      // #248: say once that it waits, and on what.
      if (!this.waitSaid.has(agent)) {
        this.waitSaid.add(agent);
        this.d.log?.(
          `hub delivery: holding ${q.length} Hub item${q.length === 1 ? "" : "s"} for ${agent}: it is busy or waiting on its person`,
        );
      }
      return;
    }
    // Den's own items (an inbox item, issue 334's relayed message) carry
    // their text: only Hub's need to know who the person is.
    const o = this.d.owner();
    if (!o && q.some((dv) => dv.text === undefined)) {
      this.d.ownerWanted?.();
      await this.ackHeld(q, "owner");
      return;
    }
    const texts = q.map((dv) => dv.text ?? deliveryText(dv, o!));
    const relayed = q.some((dv) => dv.id.startsWith(EMBED_PREFIX));
    const text =
      q.length === 1
        ? texts[0]
        : [
            `${q.length} ${relayed ? "messages" : "Hub comments"}:`,
            ...texts,
          ].join("\n\n---\n\n");
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
    if (!typed) {
      this.d.log?.(
        `hub delivery: couldn't type ${q.length} Hub item${q.length === 1 ? "" : "s"} into ${agent}; kept for the next try`,
      );
      return;
    }
    this.waitSaid.delete(agent);
    this.heldCode.delete(agent);
    const oldest = Math.min(
      ...q.map((dv) => {
        const t = Date.parse(dv.createdAt);
        return Number.isFinite(t) ? t : now;
      }),
    );
    const waited = Math.max(0, Math.round((now - oldest) / 1000));
    this.d.log?.(
      `hub delivery: typed ${q.length} Hub item${q.length === 1 ? "" : "s"} into ${agent} (oldest waited ${waited}s)`,
    );
    this.active.set(agent, {
      ids: q.map((dv) => dv.id),
      artifact: q[0].thread.artifact,
      url: q[0].thread.url || undefined,
      sawBusy: false,
      typedAt: now,
      lastBeat: now,
    });
    for (const dv of q) {
      this.heldReason.delete(dv.id);
      await this.ack(dv.id, "delivered");
      await this.ack(dv.id, "working");
    }
    // Issue 701: the person's own comment answers a question the agent
    // asked them (its waiting mark goes).
    if (
      o &&
      q.some((dv) => !dv.id.startsWith(LOCAL_PREFIX) && isOwner(dv.author, o))
    ) {
      try {
        this.d.answered?.(agent);
      } catch {
        // The bell's trouble never stops delivery.
      }
    }
  }

  /**
   * Issue 701: tell Hub why these wait (`queued`, with the reason in
   * plain words), once per reason. Den's own items have no ack.
   */
  private async ackHeld(q: Delivery[], code: HeldCode): Promise<void> {
    if (q[0]) this.heldCode.set(q[0].agent, code);
    const reason = HELD_WORDS[code];
    for (const dv of [...q]) {
      if (dv.id.startsWith(LOCAL_PREFIX)) continue;
      if (this.heldReason.get(dv.id) === reason) continue;
      this.heldReason.set(dv.id, reason);
      await this.ack(dv.id, "queued", { reason });
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
