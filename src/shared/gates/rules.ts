/**
 * Issue 144 GATE-SLOT: who may run a heavy test now.
 *
 * One machine runs gates for many repos and installs. cpu runs (unit
 * suites) share up to `cpuSlots`. Issue 751: browser and cpu runs wait in
 * separate lines, first come within each, so a cpu waiter is never behind
 * a browser waiter, nor a browser waiter behind a cpu waiter. Up to
 * `cpuSlotsBesideBrowser` cpu runs may run beside a browser run on this
 * machine (a browser run on a test box is not this machine's); at 0 a
 * browser run runs alone. A browser waiter can't be starved: while one
 * waits for cpu runs to drop to that number, no further cpu run starts
 * past it. Nothing is ever pre-empted: a later ask only waits, and a live
 * holder keeps its slot however long it runs (past its estimate it is
 * flagged, never stopped).
 *
 * Issue 715: a release run a person waits on (`gate run --priority
 * release --reason <why>`) goes to the front of its kind's queue. It never
 * passes a holder (nothing is pre-empted). Issue 751: it passes every plain
 * waiter of its kind, however long it has waited; `priorityPassLimitMinutes`
 * applies only between marked runs (a marked run that has waited past it
 * is never passed; 0: none is). At most `priorityMax` such runs per kind
 * hold priority at a time (the first asked). The store refuses a further
 * marked ask while that many wait (11-21); should more be marked (the cap
 * lowered), a later one waits in line as an ordinary run until the one
 * ahead starts, then takes priority. The
 * store records each jump (who, why, what it passed).
 *
 * Issue 803: with classes set (classes.ts), a higher class's waiters go
 * first; within a class it is first-come. A windowed class's long run,
 * outside its window, waits (at the back, blocking no one) while a
 * higher-class run holds or waits. No classes: exactly the order above.
 *
 * Issue 795: the owner of a waiting entry may yield to one waiting entry
 * behind it (`gate yield <my-id> --to <their-id>`): that entry moves to
 * just ahead of it, and it keeps its own place otherwise (A, B, C becomes
 * C, A, B). Yields are applied after priority and classes, in the order
 * they were made.
 *
 * All together, in this precedence: a granted slot is never pre-empted;
 * release priority (715, and 739's runners) goes first, past any class;
 * then classes; then yields, which never move an entry past one that
 * outranks it by priority or class (other than the yielder, who chose
 * to); then first come. A window's hold applies last.
 *
 * Pure: the store (store.ts) reads the entries, takes back holders whose
 * processes are gone, then asks `grants` which waiters may start.
 */
import {
  classRank,
  windowHeld,
  windowOpens,
  type GateClasses,
} from "./classes.js";

export type GateKind = "browser" | "cpu";

export interface GateEntry {
  id: string;
  kind: GateKind;
  /** Who asked, in words: "<install> · <project> · <agent or person>". */
  who: string;
  /** Issue 803: the project it ran for (its class comes from settings). */
  project?: string;
  /** What runs, a short label (never the command's arguments). */
  label: string;
  /** The process that holds or waits (gate run, or the agent's MCP server). */
  pid: number;
  /** The command gate run started: the slot stays while it still runs. */
  runPid?: number;
  /** When it asked (ISO); the queue's order. */
  askedAt: string;
  /** When it got the slot (ISO), or absent while waiting. */
  grantedAt?: string;
  /** When it was flagged past its estimate (ISO), once. */
  flaggedAt?: string;
  /** How long the run expects to take, minutes. */
  estimateMin: number;
  /** An agent asked (an agent token or DEN_AGENT), not a person. */
  agent?: boolean;
  /** Which agent (`agent:<id>`), when it said; its row on Agents shows it. */
  actor?: string;
  /**
   * Issue 621: a CI job in a runner VM asked over HTTP with a runner
   * token. It has no process here: it holds by lease, renewed every
   * remoteRenewSeconds, and is taken back once the lease lapses.
   */
  /**
   * Issue 715: a release run a person waits on asked for priority, with
   * why. `at`: when it took priority (the store records it once).
   */
  priority?: { for: "release"; reason: string; at?: string };
  /**
   * Issue 714: an agent asked over MCP. Its process (the MCP server)
   * outlives its work, so it holds by claim and lease: granted while it
   * waited, it is unclaimed until `claimBy`; claimed, it is renewed by
   * asking again with its id (`renewedAt`). See unclaimed and mcpLapsed.
   */
  mcp?: {
    /** The install whose agent asked (its state dir): only it tells it. */
    install: string;
    /** Granted while it waited: claim by then, or it passes on. */
    claimBy?: string;
    /** When it was last claimed or renewed (ISO). */
    renewedAt?: string;
  };
  /**
   * Issue 625: where a browser run may go: this machine only ("local",
   * the default), this machine or any test box ("any"), or one box by
   * name. `box`: the box it got (absent: this machine), and that box's
   * time scale (its estimate stretches by it).
   */
  where?: string;
  /** Issue 625 clause 11: the run's Playwright client version. */
  pwVersion?: string;
  /**
   * A browser run's declared container browser (browser-container.ts):
   * "self" (the run starts its own), or the address without its path.
   */
  browserEndpoint?: string;
  box?: string;
  boxTimeScale?: number;
  /**
   * Issue 795: waiting entries this one let go just ahead of it, and when
   * (the order yields are applied in).
   */
  yields?: { to: string; at: string }[];
  remote?: {
    /** The runner token's name (who, in words). */
    runner: string;
    /** The runner token's id: only it renews or releases the slot. */
    tokenId: string;
    /** When the lease lapses (ISO). */
    leaseUntil: string;
  };
}

export interface GateSettings {
  /** cpu runs that may share the machine (its load budget). */
  cpuSlots: number;
  /**
   * Issue 751: cpu runs that may run beside a browser run on this machine
   * (never more than cpuSlots). 0: a browser run runs alone.
   */
  cpuSlotsBesideBrowser: number;
  /**
   * Browser runs that may hold this machine at once (each runs in its own
   * container), counted as a test box's slots are. Default 1.
   */
  localBrowserSlots: number;
  /** Past its estimate by this much, a run is flagged (never stopped). */
  overrunMarginMinutes: number;
  /** Issue 621: how often a runner renews its lease, seconds (it is told). */
  remoteRenewSeconds: number;
  /** Issue 621: a runner's lease not renewed this long is taken back. */
  remoteLapseSeconds: number;
  /** Issue 621: live slots (held or waiting) one runner token may have. */
  remoteMaxSlots: number;
  /** Issue 621: asks one runner token may have waiting on an answer. */
  remoteMaxAsks: number;
  /** Issue 715: marked release runs per kind that hold priority at once. */
  priorityMax: number;
  /**
   * Issue 715, 751: a marked release run that has waited this long is never
   * passed by another (0: none is). Plain waiters are always passed.
   */
  priorityPassLimitMinutes: number;
  /** Issue 715: agents may ask for priority (else people only). */
  priorityAgents: boolean;
  /** Issue 739: CI runners (runner token) may ask for priority. */
  priorityRunners: boolean;
  /** Issue 714: an MCP slot granted while it waited: minutes to claim it. */
  claimMinutes: number;
  /** Issue 714: how often an MCP holder renews, minutes (it is told). */
  mcpRenewMinutes: number;
  /** Issue 714: not renewed this long (and past estimate plus grace): lapses. */
  mcpLapseMinutes: number;
  /** Issue 714: past its estimate by this much, an unrenewed slot may lapse. */
  mcpGraceMinutes: number;
  /** Issue 803: the classes, read from the three lines; absent: off. */
  classes?: GateClasses;
  /** Issue 803: the lines as typed (absent when no classes are set). */
  classOrder?: string;
  classMap?: string;
  classWindows?: string;
  /**
   * On macOS a browser ask must declare a container browser
   * (browser-container.ts). Default: on for a macOS host, off elsewhere.
   */
  browserRequiresContainer: boolean;
}

export const GATE_DEFAULTS: GateSettings = {
  cpuSlots: 2,
  cpuSlotsBesideBrowser: 2,
  localBrowserSlots: 1,
  overrunMarginMinutes: 15,
  remoteRenewSeconds: 30,
  remoteLapseSeconds: 120,
  remoteMaxSlots: 4,
  remoteMaxAsks: 4,
  priorityMax: 1,
  priorityPassLimitMinutes: 0,
  priorityAgents: true,
  priorityRunners: true,
  claimMinutes: 3,
  mcpRenewMinutes: 5,
  mcpLapseMinutes: 15,
  mcpGraceMinutes: 15,
  browserRequiresContainer: process.platform === "darwin",
};

const t = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/** The queue's order: who asked first (id breaks a tie). */
export function byAsked(a: GateEntry, b: GateEntry): number {
  return t(a.askedAt) - t(b.askedAt) || a.id.localeCompare(b.id);
}

type PrioritySettings = Pick<
  GateSettings,
  "priorityMax" | "priorityPassLimitMinutes" | "classes"
>;

/** What the queue's order and guesses read (issue 751 adds the beside count). */
type QueueSettings = PrioritySettings &
  Pick<GateSettings, "cpuSlotsBesideBrowser" | "localBrowserSlots">;

/** Issue 751: cpu runs that may run beside a browser run here. */
function besideOf(s: Partial<QueueSettings>): number {
  const n = s.cpuSlotsBesideBrowser ?? GATE_DEFAULTS.cpuSlotsBesideBrowser;
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** Browser runs that may hold this machine at once (at least 1). */
function localBrowserOf(s: Partial<QueueSettings>): number {
  const n = s.localBrowserSlots ?? GATE_DEFAULTS.localBrowserSlots;
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
}

/**
 * Issue 751: this machine's room, as one assignment fills it. A browser run
 * starts while fewer than localBrowserSlots browser runs hold here and at
 * most the beside count of cpu runs do; a cpu run starts while fewer than
 * cpuSlots hold, or fewer than the beside count (one total, however many
 * browser runs) while any browser run holds here. A browser waiter
 * kept out only by cpu runs (`wait`) caps later cpu grants at the beside
 * count, so the cpu runs drain to it and the browser run starts.
 */
export function localRoom(
  entries: GateEntry[],
  s: Pick<GateSettings, "cpuSlots"> & Partial<QueueSettings>,
) {
  const holders = entries.filter((e) => e.grantedAt);
  // Issue 625: a browser run on a test box doesn't hold this machine.
  let browser = holders.filter((e) => e.kind === "browser" && !e.box).length;
  let cpu = holders.filter((e) => e.kind === "cpu").length;
  let draining = false;
  const beside = besideOf(s);
  const browserSlots = localBrowserOf(s);
  const slots = Math.max(1, Math.floor(s.cpuSlots));
  return {
    fits(kind: GateKind): boolean {
      if (kind === "browser") return browser < browserSlots && cpu <= beside;
      return cpu < (browser > 0 || draining ? Math.min(slots, beside) : slots);
    },
    take(kind: GateKind): void {
      if (kind === "browser") browser++;
      else cpu++;
    },
    /**
     * A waiter of `kind` that wanted this machine and could not start: a
     * browser waiter with a browser slot free waits only on cpu runs.
     */
    wait(kind: GateKind): void {
      if (kind === "browser" && browser < browserSlots) draining = true;
    },
  };
}

/**
 * Issue 715: the marked waiters that hold priority now: per kind, the
 * first `priorityMax` that asked.
 */
export function priorityIds(
  entries: GateEntry[],
  s: Partial<PrioritySettings> = GATE_DEFAULTS,
): Set<string> {
  const max = Math.max(
    0,
    Math.floor(s.priorityMax ?? GATE_DEFAULTS.priorityMax),
  );
  const out = new Set<string>();
  const n: Record<string, number> = {};
  for (const w of entries
    .filter((e) => !e.grantedAt && e.priority)
    .sort(byAsked)) {
    if ((n[w.kind] ?? 0) >= max) continue;
    n[w.kind] = (n[w.kind] ?? 0) + 1;
    out.add(w.id);
  }
  return out;
}

/**
 * The waiters in the order they start: by class (issue 803), then by
 * ask, except that a run holding priority (issue 715) goes ahead of its
 * kind's other waiters, of any class: every plain one, and a marked one
 * only while it has waited less than the pass limit (issue 751). Then
 * yields (issue 795); a window's hold last. Each kind is its own line
 * (issue 751): read a waiter's place among its own kind (queuePlace).
 */
export function queueOrder(
  entries: GateEntry[],
  s: Partial<QueueSettings> = GATE_DEFAULTS,
  now: number = Date.now(),
): GateEntry[] {
  const c = s.classes;
  const rank = (e: GateEntry) => classRank(e, c);
  const q = entries
    .filter((e) => !e.grantedAt)
    .sort((a, b) => rank(a) - rank(b) || byAsked(a, b));
  const pri = priorityIds(entries, s);
  const limitMs =
    (s.priorityPassLimitMinutes ?? GATE_DEFAULTS.priorityPassLimitMinutes) *
    60_000;
  for (const p of q.filter((e) => pri.has(e.id))) {
    const from = q.indexOf(p);
    q.splice(from, 1);
    let to = from;
    for (let i = from - 1; i >= 0; i--) {
      const w = q[i]!;
      if (w.kind !== p.kind) continue;
      if (pri.has(w.id)) break;
      // Issue 751: the limit guards marked runs only; at 0, all of them.
      if (w.priority && (limitMs <= 0 || now - t(w.askedAt) > limitMs)) break;
      to = i;
    }
    q.splice(to, 0, p);
  }
  // Issue 795, below 715 and 803: a yield never passes a waiter that
  // outranks the one moved, by priority (same kind) or by class.
  const outranks = (w: GateEntry, m: GateEntry) =>
    (pri.has(w.id) && !pri.has(m.id) && w.kind === m.kind) || rank(w) < rank(m);
  return windowLast(applyYields(q, outranks), entries, s, now);
}

/**
 * Issue 795: each yield, oldest first, moves its waiting entry to just
 * ahead of the one that yielded, when it is still behind it and no waiter
 * between them outranks it (issue 803's classes, issue 715's priority).
 */
function applyYields(
  q: GateEntry[],
  outranks: (w: GateEntry, moved: GateEntry) => boolean = () => false,
): GateEntry[] {
  const moves = q
    .flatMap((e) => (e.yields ?? []).map((y) => ({ from: e.id, ...y })))
    .sort((a, b) => t(a.at) - t(b.at));
  for (const m of moves) {
    const at = q.findIndex((e) => e.id === m.from);
    const to = q.findIndex((e) => e.id === m.to);
    if (at < 0 || to <= at) continue;
    if (q.slice(at + 1, to).some((w) => outranks(w, q[to]!))) continue;
    const [w] = q.splice(to, 1);
    q.splice(at, 0, w!);
  }
  return q;
}

/** Issue 803: the waiters a window holds back go last, in their order. */
function windowLast(
  q: GateEntry[],
  entries: GateEntry[],
  s: Partial<PrioritySettings>,
  now: number,
): GateEntry[] {
  const held = windowHeld(entries, s.classes, now);
  if (!held.size) return q;
  return [
    ...q.filter((e) => !held.has(e.id)),
    ...q.filter((e) => held.has(e.id)),
  ];
}

/** Issue 795: the waiting entries `e` let ahead of it, still waiting. */
export function yieldedTo(e: GateEntry, entries: GateEntry[]): string[] {
  if (e.grantedAt || !e.yields?.length) return [];
  const waiting = new Set(entries.filter((x) => !x.grantedAt).map((x) => x.id));
  return [...new Set(e.yields.map((y) => y.to))].filter((id) =>
    waiting.has(id),
  );
}

/** Issue 715: the same-kind waiters a priority run goes ahead of. */
export function passedBy(
  entries: GateEntry[],
  id: string,
  s: Partial<PrioritySettings> = GATE_DEFAULTS,
  now: number = Date.now(),
): string[] {
  const p = entries.find((e) => e.id === id);
  if (!p || p.grantedAt) return [];
  const order = queueOrder(entries, s, now);
  const at = order.indexOf(p);
  return order
    .slice(at + 1)
    .filter((w) => w.kind === p.kind && byAsked(w, p) < 0)
    .map((w) => w.id);
}

/**
 * Which waiters may start now on this machine, in order. Issue 751: each
 * kind's line on its own; a waiter that can't start holds back only its
 * own kind (and, as a browser run, cpu runs past the beside count).
 */
export function grants(
  entries: GateEntry[],
  s: Pick<GateSettings, "cpuSlots"> & Partial<QueueSettings>,
  now: number = Date.now(),
): string[] {
  const room = localRoom(entries, s);
  const held = windowHeld(entries, s.classes, now);
  const out: string[] = [];
  const stopped = new Set<GateKind>();
  for (const w of queueOrder(entries, s, now)) {
    if (held.has(w.id)) continue; // issue 803: it waits for its window
    if (stopped.has(w.kind)) continue;
    if (!room.fits(w.kind)) {
      room.wait(w.kind);
      stopped.add(w.kind);
      continue;
    }
    room.take(w.kind);
    out.push(w.id);
  }
  return out;
}

/**
 * Whether an entry's processes are all gone (its slot is free at once).
 * gate run's own command counts: a wrapper killed hard leaves its run, and
 * the run keeps the slot until it ends.
 */
export function gone(e: GateEntry, alive: (pid: number) => boolean): boolean {
  if (e.remote) return false; // a lease holder: see lapsed
  return !alive(e.pid) && (e.runPid === undefined || !alive(e.runPid));
}

/** Issue 621: a runner's lease ran out (its slot is free at once). */
export function lapsed(e: GateEntry, now: number): boolean {
  return !!e.remote && !(Date.parse(e.remote.leaseUntil) > now);
}

/**
 * 0 for a holder; a waiter's place in its kind's line (1 is next; issue
 * 751); -1 if absent.
 */
export function queuePlace(
  entries: GateEntry[],
  id: string,
  s: Partial<QueueSettings> = GATE_DEFAULTS,
  now: number = Date.now(),
): number {
  const e = entries.find((x) => x.id === id);
  if (!e) return -1;
  if (e.grantedAt) return 0;
  const queue = queueOrder(entries, s, now).filter((x) => x.kind === e.kind);
  return queue.findIndex((x) => x.id === id) + 1;
}

/** When a holder is expected to end (ms), from its grant and estimate. */
export function expectedEnd(e: GateEntry): number {
  return (
    t(e.grantedAt ?? e.askedAt) + e.estimateMin * (e.boxTimeScale ?? 1) * 60_000
  );
}

/** Past its estimate plus the margin: flagged, never stopped. */
export function overrun(
  e: GateEntry,
  s: Pick<GateSettings, "overrunMarginMinutes">,
  now: number,
): boolean {
  return (
    !!e.grantedAt && now > expectedEnd(e) + s.overrunMarginMinutes * 60_000
  );
}

/**
 * For a waiter: when it may expect to start (ms): the holders' latest
 * expected end, plus the estimates of the waiters ahead of it. A guess.
 * Issue 751: only its own kind's holders and line count, unless a browser
 * run runs alone (cpuSlotsBesideBrowser 0), when both kinds do. With
 * localBrowserSlots above 1, a browser waiter's guess runs that many slots:
 * each frees at its holder's expected end (or now), and each waiter ahead
 * takes the slot that frees first.
 */
export function expectedStart(
  entries: GateEntry[],
  id: string,
  now: number,
  s: Partial<QueueSettings> = GATE_DEFAULTS,
): number {
  const me = entries.find((e) => e.id === id);
  const alone = besideOf(s) === 0;
  const mine = (e: GateEntry) => alone || !me || e.kind === me.kind;
  const queue = queueOrder(entries, s, now).filter(mine);
  const ahead = queue.slice(
    0,
    Math.max(
      0,
      queue.findIndex((e) => e.id === id),
    ),
  );
  const n = localBrowserOf(s);
  let free: number;
  if (me?.kind === "browser" && n > 1) {
    const ends = entries
      .filter((e) => e.grantedAt && e.kind === "browser" && !e.box)
      .map((e) => Math.max(now, expectedEnd(e)))
      .sort((a, b) => a - b)
      .slice(-n);
    const slots = [...Array<number>(n - ends.length).fill(now), ...ends];
    for (const w of ahead.filter((x) => x.kind === "browser")) {
      const i = slots.indexOf(Math.min(...slots));
      slots[i] = slots[i]! + w.estimateMin * 60_000;
    }
    free = Math.min(...slots);
  } else {
    free = Math.max(
      now,
      ...entries.filter((e) => e.grantedAt && mine(e)).map(expectedEnd),
    );
    for (const w of ahead) free += w.estimateMin * 60_000;
  }
  // Issue 803: held for its window: not before the window opens.
  const win = windowHeld(entries, s.classes, now).get(id);
  return win ? Math.max(free, windowOpens(win, now)) : free;
}

/** Issue 714: an MCP slot granted while it waited, not claimed in time. */
export function unclaimed(e: GateEntry, now: number): boolean {
  return !!e.grantedAt && !!e.mcp?.claimBy && now > t(e.mcp.claimBy);
}

/**
 * Issue 714: a claimed MCP slot whose lease lapsed: not renewed for
 * mcpLapseMinutes AND past its estimate plus mcpGraceMinutes. A slot that
 * renews, or still runs within its estimate, keeps holding.
 */
export function mcpLapsed(
  e: GateEntry,
  s: Pick<GateSettings, "mcpLapseMinutes" | "mcpGraceMinutes">,
  now: number,
): boolean {
  if (!e.mcp || !e.grantedAt || e.mcp.claimBy) return false;
  const last = t(e.mcp.renewedAt ?? e.grantedAt);
  return (
    now - last > s.mcpLapseMinutes * 60_000 &&
    now > expectedEnd(e) + s.mcpGraceMinutes * 60_000
  );
}
