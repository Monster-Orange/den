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
import type { JournalEntry } from "./hub-delivery-journal.js";
import {
  ackBody,
  deliveryRaw,
  deliveryText,
  EMBED_PREFIX,
  FEED_PREFIX,
  heldIdsIn,
  isApproval,
  isOwner,
  mayBeApproval,
  LOCAL_PREFIX,
  parseDelivery,
  SseReader,
  toolsHeldAck,
  ACK_HELD_FEATURE,
  TROUBLE_TEXT,
  troubleOf,
  type AckState,
  type Delivery,
  type DeliveryHealth,
  type DeliveryOwner,
  type DeliveryTrouble,
  type SeenDeliveries,
} from "./hub-delivery.js";

/** P0-D2: the most early approvals kept while Den learns its person. */
const EARLY_MAX = 500;

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
  /**
   * Issue 750: whether the agent's Hub tools loaded at its last start:
   * false when its Hub MCP connect failed since (it can't answer in Hub);
   * null when Den doesn't know. Hub's deliveries wait for it while false.
   */
  hubTools?(agent: string): boolean | null;
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
  // Issue 1311: its person's unsent draft is on its input line.
  "draft",
  // Issue 750: its Hub tools failed to load; Hub hears hub_tools_unavailable.
  "hub_tools",
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
  draft:
    "its person is typing a message to it; typed once they send or clear it",
  hub_tools: "its Hub tools didn't load; typed once it restarts",
};

/**
 * Issue 701: the reasons on Den's other acks. Hub frames every reason
 * itself ("Waiting at <install>: …", "Picked up by <install>: …"): plain
 * lowercase words, no status word in front.
 */
export const ACK_WORDS = {
  missing: "this install has no agent with that id",
  stopped: "the agent stopped before it finished",
  noAnswer: "typed in; no answer yet",
} as const;

/** Issue 701: a time limit ran out (never a real value). */
const LATE = Symbol("late");

export interface DeliveryLoopDeps {
  hub: DeliveryHub;
  agents: DeliveryAgents;
  /**
   * Issue 750: whether Hub lists `deliveries.ack_held` (whoami features):
   * a delivery held for an agent without Hub tools is acked `held`, else
   * `queued`, with reason hub_tools_unavailable.
   */
  ackHeld?: () => boolean;
  /**
   * Who the agent's person is in Hub, or null while Den doesn't know yet
   * (Hub didn't answer). Null holds deliveries: a person's edit request
   * never reaches the agent as "someone else".
   */
  owner: () => DeliveryOwner | null;
  /** Called when a delivery waits on the owner: look it up again. */
  ownerWanted?: () => void;
  seen: SeenDeliveries;
  /**
   * Issue 459: the seen store for app feed notices (FEED_PREFIX), apart
   * from `seen`; `seen` when unset.
   */
  feedSeen?: SeenDeliveries;
  /**
   * Issue 459: the most characters one paste types (read at each paste).
   * Items past it wait for the next one; the first item always goes.
   * Unset: no cap.
   */
  pasteMaxChars?: () => number;
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
  /**
   * P0-D2: the owner's approval (isApproval) arrived, once per delivery,
   * typed or not yet: Den clears the questions that name it.
   */
  approved?: (dv: Delivery) => void;
  /**
   * P0-D4: what happened to each delivery (ids, kind, link, outcome; never
   * a body or a name), for the file doctor reads.
   */
  journal?: (e: JournalEntry) => void;
  /** NT: the agent finished its Hub comments (done, not failed). */
  finished?: (
    agent: string,
    w: { count: number; artifact?: string; url?: string },
  ) => void;
  /**
   * Issue 702: the path's health changed (stream open or not, trouble, a
   * delivery), or its last good read moved a minute on. Never per byte.
   */
  onHealth?: (h: DeliveryHealth) => void;
  /**
   * Issue 702: what a restart keeps (the last delivery's time); issue 248:
   * the cursor's last move.
   */
  health0?: { lastDeliveryAt?: number | null; cursorAt?: number | null };
  /**
   * Issue 248 hub.delivery_stale_hours: the stream open but the cursor
   * still this long, and Hub's list read (once a poll interval) to see
   * whether comments wait after it. 0 or none: never. Read each check.
   */
  staleMs?: () => number;
  /**
   * Issue 703: no bytes on an open stream for this long (Hub sends a
   * keep-alive every 25 s): closed, the list read once, reopened. 0: never.
   * Read each time a stream opens. Default 75 s.
   */
  silenceMs?: () => number;
}

/** Issue 703: a stream that lived this long ended cleanly: Hub's own end. */
const SHORT_LIFE_MS = 5_000;
/** Issue 702: onHealth again when only the last good read moved this far. */
const HEALTH_EVERY_MS = 60_000;

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
  /** P0-D4: each delivery's journal fields, until it is done with. */
  private readonly jmeta = new Map<
    string,
    Omit<JournalEntry, "at" | "id" | "outcome">
  >();
  /** P0-D4: the held reason last logged for each delivery. */
  private readonly heldLogged = new Map<string, string>();

  /** P0-D4: one journal line; the hook's trouble never stops a delivery. */
  private note(
    id: string,
    outcome: JournalEntry["outcome"],
    dv?: Delivery,
    why?: string,
  ): void {
    if (!this.d.journal) return;
    if (dv && !this.jmeta.has(id))
      this.jmeta.set(id, {
        agent: dv.agent,
        ...(dv.kind ? { kind: dv.kind } : {}),
        ...(dv.version !== undefined ? { version: dv.version } : {}),
        ...(dv.thread.id ? { thread: dv.thread.id } : {}),
        ...(dv.thread.url ? { url: dv.thread.url } : {}),
        ...(heldIdsIn(dv.body).length ? { held: heldIdsIn(dv.body) } : {}),
      });
    const m = this.jmeta.get(id) ?? { agent: dv?.agent ?? "" };
    try {
      this.d.journal({
        at: new Date(this.now()).toISOString(),
        id,
        outcome,
        ...m,
        ...(why ? { why } : {}),
      });
    } catch {
      /* never stops a delivery */
    }
    if (
      outcome === "done" ||
      outcome === "failed" ||
      outcome === "no-answer" ||
      outcome === "refused" ||
      outcome === "passed"
    ) {
      this.jmeta.delete(id);
      this.heldLogged.delete(id);
    }
  }

  /** P0-D2: deliveries taken before Den knew its person, to check then. */
  private approvalLater: Delivery[] = [];
  private earlyDropSaid = false;
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

  /** Issue 702: the delivery path's health. */
  private readonly h: DeliveryHealth;
  /** What onHealth last got (its key) and the good read it carried. */
  private healthSaid = "";
  private healthOkSaid = 0;
  /**
   * The troubles logged: each is said once until a good read (a list
   * answer keeps "refused": Hub without a stream reads the list each time).
   */
  private readonly troubleSaid = new Set<DeliveryTrouble>();
  /** Issue 248: the last list result logged (its key), and the last stale check. */
  private pollSaid = "";
  private staleCheckedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly d: DeliveryLoopDeps) {
    this.hb = d.heartbeatMs ?? 15_000;
    this.stateMs = d.stateTimeoutMs ?? 60_000;
    this.typeMs = d.typeTimeoutMs ?? 120_000;
    this.answerMs = d.answerTimeoutMs ?? 30 * 60_000;
    this.now = d.now ?? Date.now;
    this.h = {
      since: this.now(),
      streamOpen: false,
      lastOkAt: null,
      lastDeliveryAt: d.health0?.lastDeliveryAt ?? null,
      trouble: null,
      troubleAt: null,
      streamSince: null,
      lastPoll: null,
      cursorAt: d.health0?.cursorAt ?? this.now(),
      stale: null,
    };
    this.restore();
  }

  /** Issue 702: the delivery path's health now (a copy). */
  health(): DeliveryHealth {
    return { ...this.h };
  }

  private healthChanged(): void {
    const key = JSON.stringify([
      this.h.since,
      this.h.streamOpen,
      this.h.trouble,
      this.h.lastDeliveryAt,
      this.h.cursorAt,
      this.h.stale?.waiting ?? null,
      this.h.lastPoll ? [this.h.lastPoll.ok, this.h.lastPoll.count] : null,
    ]);
    const ok = this.h.lastOkAt ?? 0;
    if (key === this.healthSaid && ok - this.healthOkSaid < HEALTH_EVERY_MS)
      return;
    this.healthSaid = key;
    this.healthOkSaid = ok;
    try {
      this.d.onHealth?.(this.health());
    } catch {
      /* its trouble never stops delivery */
    }
  }

  /**
   * A good read: the list answered ("list"), the stream opened ("open"),
   * or bytes came after that ("bytes"). What is said again later: a list
   * answer keeps what was said about the stream ("refused": Hub without
   * a stream reads the list each time); an open alone keeps "closed" and
   * "silent" (a stream that ends or goes quiet at once is said once, not
   * at every reopen).
   */
  private readOk(how: "list" | "open" | "bytes"): void {
    this.h.lastOkAt = this.now();
    this.h.trouble = null;
    this.h.troubleAt = null;
    const keep: DeliveryTrouble[] =
      how === "list"
        ? ["refused", "closed", "silent"]
        : how === "open"
          ? ["closed", "silent"]
          : [];
    for (const t of [...this.troubleSaid])
      if (!keep.includes(t)) this.troubleSaid.delete(t);
    this.healthChanged();
  }

  /** Something went wrong: kept, and logged once per kind until a good read. */
  private troubled(t: DeliveryTrouble, why: string): void {
    this.h.trouble = t;
    this.h.troubleAt = this.now();
    if (!this.troubleSaid.has(t)) {
      this.troubleSaid.add(t);
      this.d.log?.(`hub deliveries: ${why.slice(0, 200)}`);
    }
    this.healthChanged();
  }

  /** Issue 248: each open and close logged, one line each. */
  private streamIs(open: boolean): void {
    if (this.h.streamOpen === open) return;
    this.h.streamOpen = open;
    if (open) {
      this.h.streamSince = this.now();
      this.d.log?.("hub deliveries: the comment stream opened");
    } else {
      const lived = this.now() - (this.h.streamSince ?? this.now());
      this.h.streamSince = null;
      this.d.log?.(
        `hub deliveries: the comment stream closed after ${Math.round(lived / 1000)}s`,
      );
    }
    this.healthChanged();
  }

  /** Issue 248: the cursor moved (a delivery came): any stall is over. */
  private cursorTo(id: string): void {
    this.d.seen.setLast(id);
    this.h.cursorAt = this.now();
    if (this.h.stale) {
      this.h.stale = null;
      this.d.log?.("hub deliveries: the comment cursor moved again");
    }
    this.healthChanged();
  }

  /**
   * Issue 248: a list read's result, kept for doctor and logged when it
   * changes: its count and last id, or its error (logged by troubled()).
   * Ids and counts only, never a comment's text.
   */
  private notePoll(r: { list: unknown[] } | { error: string }): void {
    const at = this.now();
    if ("error" in r) {
      this.h.lastPoll = { at, ok: false, error: r.error.slice(0, 200) };
      this.pollSaid = "error";
      this.healthChanged();
      return;
    }
    const n = r.list.length;
    const lastId =
      (n ? parseDelivery(r.list[n - 1])?.id : null) ?? this.d.seen.last ?? null;
    this.h.lastPoll = { at, ok: true, count: n, lastId };
    const key = n ? `${n}:${lastId}` : "none";
    if (key !== this.pollSaid) {
      this.pollSaid = key;
      this.d.log?.(
        n
          ? `hub deliveries: the comment list answered: ${n}, last ${lastId}`
          : "hub deliveries: the comment list answered: none waiting",
      );
    }
    this.healthChanged();
  }

  /**
   * Issue 248: the stream is open but the cursor hasn't moved for
   * hub.delivery_stale_hours: read Hub's list (at most once a poll
   * interval). Comments waiting after the cursor: stale, said once.
   * Nothing waiting: a quiet Hub, never stale. Only a delivery that moves
   * the cursor clears it (cursorTo), or an empty list.
   */
  private async checkStale(): Promise<void> {
    const ms = this.d.staleMs?.() ?? 0;
    const now = this.now();
    if (!(ms > 0) || now - (this.h.cursorAt ?? now) < ms) return;
    if (now - this.staleCheckedAt < (this.d.pollMs ?? 30_000)) return;
    this.staleCheckedAt = now;
    let list: unknown[];
    try {
      list = await this.d.hub.list(this.d.seen.last);
    } catch (e) {
      this.notePoll({ error: String((e as Error)?.message ?? e) });
      return;
    }
    this.notePoll({ list });
    if (!list.length) {
      if (this.h.stale) ((this.h.stale = null), this.healthChanged());
      return;
    }
    if (!this.h.stale) {
      this.h.stale = { since: now, waiting: list.length };
      const hours = Math.round((now - (this.h.cursorAt ?? now)) / 3_600_000);
      this.d.log?.(
        `hub deliveries: the comment cursor hasn't moved for ${hours}h with the stream open; ${list.length} waiting in Hub's list`,
      );
    } else this.h.stale.waiting = list.length;
    this.healthChanged();
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
      // Issue 962: or why() found a list or a question on its screen.
      ...(q &&
      (this.notAtPrompt.has(agent) ||
        this.heldCode.get(agent) === "not_at_prompt")
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
      this.note(dv.id, "repeat", dv);
      const st = this.states.get(dv.id);
      // A repeat: Hub didn't get the ack; say it again (never twice to the agent).
      const why = this.heldReason.get(dv.id);
      if (st)
        await this.ack(
          dv.id,
          st,
          (st === "queued" || st === "held") && why ? { reason: why } : {},
        );
      return;
    }
    this.h.lastDeliveryAt = this.now();
    this.healthChanged();
    this.note(dv.id, "received", dv);
    if (dv.kind === "held") {
      try {
        this.d.held?.(dv);
      } catch {
        /* the hook's own trouble never stops a delivery */
      }
    }
    this.checkApproval(dv);
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
    if (this.seenOf(dv.id).has(dv.id) || this.states.has(dv.id)) return false;
    this.note(dv.id, "received", dv);
    await this.hold(dv);
    return true;
  }

  /** Whether an inbox item was seen (taken, or passed over). */
  seenLocal(id: string): boolean {
    return this.seenOf(id).has(id);
  }

  /** Mark an inbox item seen without typing it (older, or a delivery had it). */
  passLocal(id: string): void {
    if (!id.startsWith(LOCAL_PREFIX)) return;
    this.seenOf(id).add(id);
    this.note(id, "passed");
  }

  /**
   * Whether Hub's own delivery already brought this thread's comment at
   * `at` or later (a mention is both a delivery and an inbox item).
   */
  coveredThread(thread: string, at: number): boolean {
    const t = this.threadsAt.get(thread);
    return t !== undefined && t >= at;
  }

  /** Issue 459: the seen store an id belongs in. */
  private seenOf(id: string): SeenDeliveries {
    return id.startsWith(FEED_PREFIX) && this.d.feedSeen
      ? this.d.feedSeen
      : this.d.seen;
  }

  /** Issue 459: whether `id` waits in a queue or is in a running turn. */
  holds(id: string): boolean {
    for (const q of this.queue.values())
      if (q.some((dv) => dv.id === id)) return true;
    for (const a of this.active.values()) if (a.ids.includes(id)) return true;
    return false;
  }

  private async hold(dv: Delivery): Promise<void> {
    this.seenOf(dv.id).add(dv.id);
    const s = await this.stateOf(dv.agent);
    if (s === "missing") {
      this.note(dv.id, "refused", dv);
      await this.ack(dv.id, "refused", {
        reason: ACK_WORDS.missing,
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
      this.note(a.id, "replaced", a);
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
  /**
   * P0-D2: tell Den of an owner's approval. Before Den knows its person
   * (Hub's whoami), a delivery is kept and checked at the next pump that
   * does, so an approval that came early still counts, once.
   */
  private checkApproval(dv: Delivery): void {
    const o = this.d.owner();
    if (!o) {
      if (!mayBeApproval(dv)) return;
      if (this.approvalLater.length < EARLY_MAX) this.approvalLater.push(dv);
      else if (!this.earlyDropSaid) {
        this.earlyDropSaid = true;
        this.d.log?.(
          `hub delivery: early approval ${dv.id} dropped: ${EARLY_MAX} already wait for Den to learn its person`,
        );
      }
      return;
    }
    if (!isApproval(dv, o)) return;
    try {
      this.d.approved?.(dv);
    } catch {
      /* the bell's trouble never stops a delivery */
    }
  }

  /**
   * P0-D2: Den's person may have changed (a new connection): approvals
   * kept for the old one are forgotten.
   */
  ownerReset(): void {
    this.approvalLater = [];
    this.earlyDropSaid = false;
  }

  async pump(): Promise<void> {
    if (this.approvalLater.length) {
      if (this.d.owner()) {
        const later = this.approvalLater;
        this.approvalLater = [];
        for (const dv of later) this.checkApproval(dv);
      } else this.d.ownerWanted?.(); // the agent may be busy for hours
    }
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
      (this.d.agents.notAtPrompt?.(agent) === true || code === "not_at_prompt");
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
      for (const id of act.ids) this.note(id, "no-answer");
      const minutes = Math.round((now - act.typedAt) / 60_000);
      for (const id of act.ids)
        await this.ack(id, "delivered", {
          reason: ACK_WORDS.noAnswer,
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
        for (const id of act.ids) this.note(id, "done");
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
        for (const id of act.ids) this.note(id, "failed");
        for (const id of act.ids)
          await this.ack(id, "failed", {
            reason: ACK_WORDS.stopped,
          });
        return;
      } else return;
    }
    const waiting = this.queue.get(agent);
    if (!waiting?.length) {
      this.queue.delete(agent);
      return;
    }
    if (s === "stopped") {
      await this.ackHeld(waiting, "stopped");
      return;
    }
    // Issue 750: its Hub tools didn't load: Hub's deliveries wait (it
    // couldn't answer them in Hub) and Hub hears why; Den's own items go on.
    let q = waiting;
    let toolsHeld: Delivery[] = [];
    if (this.d.agents.hubTools?.(agent) === false) {
      toolsHeld = waiting.filter((dv) => !dv.id.startsWith(LOCAL_PREFIX));
      if (toolsHeld.length) {
        await this.ackHeld(toolsHeld, "hub_tools");
        q = waiting.filter((dv) => dv.id.startsWith(LOCAL_PREFIX));
        if (!q.length) return;
      }
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
    const all = q.map((dv) => dv.text ?? deliveryText(dv, o!));
    // Issue 459: one paste holds at most pasteMaxChars (the first item
    // always goes); the rest wait for the next paste.
    let n = q.length;
    const cap = this.d.pasteMaxChars?.() ?? 0;
    if (cap > 0) {
      let total = 0;
      n = 0;
      while (n < q.length && (n === 0 || total + all[n].length <= cap))
        total += all[n++].length;
    }
    const batch = q.slice(0, n);
    const rest = q.slice(n);
    const texts = all.slice(0, n);
    const relayed = batch.some((dv) => dv.id.startsWith(EMBED_PREFIX));
    const text =
      batch.length === 1
        ? texts[0]
        : [
            `${batch.length} ${relayed ? "messages" : "Hub comments"}:`,
            ...texts,
          ].join("\n\n---\n\n");
    // Claim them before the paste: the queue keeps only what comes after
    // (issue 750: and what waits for its Hub tools).
    const keep = [...toolsHeld, ...rest];
    if (keep.length) this.queue.set(agent, keep);
    else this.queue.delete(agent);
    this.typing.add(agent);
    let typed = false;
    try {
      typed = await this.d.agents.type(agent, text);
    } finally {
      this.typing.delete(agent);
      if (!typed)
        this.queue.set(agent, [...batch, ...(this.queue.get(agent) ?? [])]);
    }
    if (!typed) {
      this.d.log?.(
        `hub delivery: couldn't type ${batch.length} Hub item${batch.length === 1 ? "" : "s"} into ${agent}; kept for the next try`,
      );
      return;
    }
    this.waitSaid.delete(agent);
    this.heldCode.delete(agent);
    const oldest = Math.min(
      ...batch.map((dv) => {
        const t = Date.parse(dv.createdAt);
        return Number.isFinite(t) ? t : now;
      }),
    );
    const waited = Math.max(0, Math.round((now - oldest) / 1000));
    this.d.log?.(
      `hub delivery: typed ${batch.length} Hub item${batch.length === 1 ? "" : "s"} into ${agent} (oldest waited ${waited}s)`,
    );
    this.active.set(agent, {
      ids: batch.map((dv) => dv.id),
      artifact: batch[0].thread.artifact,
      url: batch[0].thread.url || undefined,
      sawBusy: false,
      typedAt: now,
      lastBeat: now,
    });
    for (const dv of batch) {
      this.heldReason.delete(dv.id);
      this.heldLogged.delete(dv.id);
      this.note(dv.id, "typed", dv);
      await this.ack(dv.id, "delivered");
      await this.ack(dv.id, "working");
    }
    // Issue 701: the person's own comment answers a question the agent
    // asked them (its waiting mark goes).
    if (
      o &&
      batch.some(
        (dv) => !dv.id.startsWith(LOCAL_PREFIX) && isOwner(dv.author, o),
      )
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
  /**
   * Issue 1311: how many items wait for agent `agent` on its person's
   * unsent draft (0 when something else holds them, or nothing does).
   */
  waitingOnDraft(agent: string): number {
    if (this.heldCode.get(agent) !== "draft") return 0;
    const q = this.queue.get(agent) ?? [];
    // Issue 750: Hub's items wait on its tools, not on the draft.
    return this.d.agents.hubTools?.(agent) === false
      ? q.filter((dv) => dv.id.startsWith(LOCAL_PREFIX)).length
      : q.length;
  }

  private async ackHeld(q: Delivery[], code: HeldCode): Promise<void> {
    if (q[0]) this.heldCode.set(q[0].agent, code);
    // Issue 750: no Hub tools: `held` to a Hub that takes it, else `queued`.
    const { state, reason } =
      code === "hub_tools"
        ? toolsHeldAck(this.d.ackHeld?.() ? [ACK_HELD_FEATURE] : [])
        : { state: "queued" as const, reason: HELD_WORDS[code] };
    for (const dv of q)
      if (this.heldLogged.get(dv.id) !== code) {
        this.heldLogged.set(dv.id, code);
        this.note(dv.id, "held", dv, code);
      }
    for (const dv of [...q]) {
      if (dv.id.startsWith(LOCAL_PREFIX)) continue;
      if (this.heldReason.get(dv.id) === reason) continue;
      this.heldReason.set(dv.id, reason);
      await this.ack(dv.id, state, { reason });
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
    this.h.since = this.now();
    this.healthChanged();
    while (!signal.aborted) {
      // Issue 703: one stream's own abort, for the silence watch.
      const one = new AbortController();
      const up = () => one.abort();
      signal.addEventListener("abort", up, { once: true });
      const silenceMs = this.d.silenceMs?.() ?? 75_000;
      let silent = false;
      let watch: ReturnType<typeof setTimeout> | null = null;
      const arm = () => {
        if (watch) clearTimeout(watch);
        if (!(silenceMs > 0)) return;
        watch = setTimeout(() => {
          silent = true;
          one.abort();
        }, silenceMs);
        watch.unref?.();
      };
      const openedAt = this.now();
      let outcome: "ended" | "failed" | "refused" = "ended";
      let chunks = 0;
      try {
        arm();
        const reader = new SseReader();
        for await (const chunk of this.d.hub.stream(
          this.d.seen.last,
          one.signal,
        )) {
          // Issue 702/703: the stream opened, or sent bytes (Hub's
          // keep-alive too): a good read.
          arm();
          this.streamIs(true);
          this.readOk(chunks++ === 0 ? "open" : "bytes");
          await this.checkStale();
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
            if (id) this.cursorTo(id);
          }
          if (signal.aborted || silent) break;
        }
      } catch (e) {
        if (!signal.aborted && !silent) {
          const t = troubleOf(e);
          outcome = t === "refused" ? "refused" : "failed";
          this.troubled(
            t,
            t === "refused"
              ? `${String((e as Error)?.message ?? e)}; reading the list instead`
              : String((e as Error)?.message ?? e),
          );
        }
      } finally {
        if (watch) clearTimeout(watch);
        signal.removeEventListener("abort", up);
        this.streamIs(false);
      }
      if (signal.aborted) return;
      if (outcome === "refused") {
        await this.poll();
        await sleep(this.d.pollMs ?? 30_000, signal);
        continue;
      }
      const lived = this.now() - openedAt >= SHORT_LIFE_MS;
      if (lived) wait = first;
      if (silent) {
        // Issue 703: no bytes, not even Hub's keep-alive: a half-dead
        // connection. Read the list once, then open a new stream at once.
        this.troubled(
          "silent",
          `no bytes on the comment stream for ${Math.round(silenceMs / 1000)}s: reopening it`,
        );
        await this.poll();
        continue;
      }
      // Issue 703: Hub ends a long stream itself: reopen at once.
      if (outcome === "ended" && lived) continue;
      if (outcome === "ended") this.troubled("closed", TROUBLE_TEXT.closed);
      // Issue 702: whatever happened to the stream, the list still runs.
      await this.poll();
      await sleep(wait, signal);
      wait = Math.min(max, wait * 2);
    }
  }

  /** The list after the last id, oldest first (Hub has no stream). */
  async poll(): Promise<void> {
    let list: unknown[];
    try {
      list = await this.d.hub.list(this.d.seen.last);
    } catch (e) {
      // Issue 702: never swallowed: kept for doctor and the bell.
      this.notePoll({ error: String((e as Error)?.message ?? e) });
      this.troubled(
        troubleOf(e),
        `the comment list: ${String((e as Error)?.message ?? e)}`,
      );
      return;
    }
    this.readOk("list");
    for (const v of list) {
      await this.take(v);
      const id = parseDelivery(v)?.id;
      if (id) this.cursorTo(id);
    }
    this.notePoll({ list });
  }
}
