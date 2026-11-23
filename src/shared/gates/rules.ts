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
 * hold priority at a time (the first asked); a later one waits in line as
 * an ordinary run until the one ahead starts, then takes priority. The
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
import * as os from "os";
import {
  classRank,
  windowHeld,
  windowOpens,
  type GateClasses,
} from "./classes.js";

export type GateKind = "browser" | "cpu";

/** Issue 999: where a run's estimate came from. */
export type EstimateSource = "given" | "label" | "actor" | "default";

/** Issue 999: a run with no estimate and no history: minutes. */
export const DEFAULT_ESTIMATE_MIN = 10;

/** Issue 999: the minutes the queue's wait times use for a run. */
export const queueMinOf = (e: GateEntry): number =>
  e.expectedMin ?? e.estimateMin;

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
  /**
   * Issue 1132: the process group gate run started its command in (the
   * command leads it). When the slot ends, whatever is left in it is
   * stopped; nothing outside it ever is.
   */
  group?: number;
  /** Issue 1132: the command's name (never its arguments), for the log. */
  cmd?: string;
  /**
   * Issue 1132: granted, but its command waits for the machine's load to
   * drop under gates.max_start_load: the load seen, the ceiling, since.
   */
  startHold?: { load: number; limit: number; since: string };
  /** When it asked (ISO); the queue's order. */
  askedAt: string;
  /**
   * Issue 867: a waiter whose run is gone (a restart ended it), kept in
   * line since then (ISO) until its run asks again or the time is up.
   */
  orphanedAt?: string;
  /** When it got the slot (ISO), or absent while waiting. */
  grantedAt?: string;
  /** When it was flagged past its estimate (ISO), once. */
  flaggedAt?: string;
  /** How long the run expects to take, minutes. */
  estimateMin: number;
  /**
   * Issue 999: where estimateMin came from: given by the caller, or the
   * median of the label's runs, of the asker's runs of its kind, or the
   * kind's default. Absent on entries from before: given.
   */
  estimateFrom?: EstimateSource;
  /**
   * Issue 999: a given estimate over twice the measured median: the
   * median the queue's wait times use instead, and where it came from.
   */
  expectedMin?: number;
  expectedFrom?: EstimateSource;
  /** Issue 999: the given estimate is over twice the measured median. */
  padded?: boolean;
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
  /**
   * Issue 1033: a browser run that could have gone to a test box by
   * default but stays on this machine: why, in one line.
   */
  hostWhy?: string;
  /**
   * Issue 1033: a default pick (where "any") may take only these boxes:
   * the others can't serve it (no declared Playwright version, or one
   * that doesn't serve the run's).
   */
  onlyBoxes?: string[];
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
   * Issue 751 follow-up: cpu runs that may run beside a release-priority
   * browser run on this machine. Default 0: a release run runs alone, so
   * its checks aren't slowed.
   */
  cpuSlotsBesideReleaseBrowser: number;
  /**
   * Browser runs that may hold this machine at once (each runs in its own
   * container), counted as a test box's slots are. Default 1.
   */
  localBrowserSlots: number;
  /**
   * Issue 1009: while this machine's 5-minute load average is at or above
   * this, and a release-priority browser run holds a browser slot, cpu
   * asks wait (holders are never stopped). 0 turns it off.
   */
  cpuHoldLoad: number;
  /**
   * Issue 1048: while this machine's 5-minute load average is over this
   * many times its cores, new cpu runs wait, but only while another cpu
   * run is going (so the line never stops for good). A release run never
   * waits. 0 turns it off.
   */
  loadHoldPerCore: number;
  /**
   * Issue 1132: a granted run doesn't start its command while this
   * machine's 5-minute load average (the total, not per core) is at or
   * over this; it waits, saying why. Every kind, release runs too. 0 turns
   * it off. Default cores × 1.5 (27 on 18 cores), under where the machine
   * stalls: an 18-core machine reset twice at a 5-minute load of about 34.
   * It is not cpu_hold_load (issue 1009), which holds only cpu asks and
   * only while a release browser run holds a slot.
   */
  maxStartLoad: number;
  /**
   * Issue 1132 (issue 460's wait limit): a run held by maxStartLoad this
   * many minutes starts anyway, and its record says it started busy. 0:
   * it waits for the load however long.
   */
  maxStartWaitMinutes: number;
  /**
   * Issue 1132: seconds between TERM and KILL for what a run left in its
   * process group when its slot ended.
   */
  reapGraceSeconds: number;
  /** Past its estimate by this much, a run is flagged (never stopped). */
  overrunMarginMinutes: number;
  /**
   * Issue 993: held past this many times its estimate, a slot is in the
   * bell's Needs you (End for the person) and its agent is told once.
   */
  overrunBellMultiple: number;
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
  /** Issue 867: minutes a gone waiter keeps its place (0: taken back at once). */
  waiterReturnMinutes: number;
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
  /**
   * Issue 1033: where a browser `gate run` with no --box goes: "any",
   * the first free browser slot here or on a test box (the default), or
   * "local", this machine only (as before).
   */
  browserBoxDefault: "any" | "local";
  /**
   * Issue 1033: projects and label patterns whose browser runs stay on
   * this machine, comma-separated: <project>, label:<pattern> (* matches
   * any text). Empty: none.
   */
  browserHostOnly: string;
}

/**
 * Issue 1132: the default start ceiling, cores × 1.5 (27 on 18 cores), so
 * it holds below where the machine stalls (about 34 on 18 cores).
 */
export function maxStartLoadDefault(): number {
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.round(Math.max(1, cores) * 1.5);
}

/** Issue 1009: the default hold load, cores × 4 / 3 (24 on 18 cores). */
export function cpuHoldLoadDefault(): number {
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.round((Math.max(1, cores) * 4) / 3);
}

export const GATE_DEFAULTS: GateSettings = {
  cpuSlots: 2,
  cpuSlotsBesideBrowser: 2,
  cpuSlotsBesideReleaseBrowser: 0,
  localBrowserSlots: 1,
  cpuHoldLoad: cpuHoldLoadDefault(),
  // Issue 1048 (Vision 11-22): 3 × cores. (Issue 1132: a load of about
  // 40 on 18 cores is not normal; the machine reset at about 34. The
  // start ceiling, maxStartLoad, now holds every run below that.)
  loadHoldPerCore: 3,
  maxStartLoad: maxStartLoadDefault(),
  maxStartWaitMinutes: 10,
  reapGraceSeconds: 10,
  overrunMarginMinutes: 15,
  overrunBellMultiple: 2,
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
  waiterReturnMinutes: 10,
  browserRequiresContainer: process.platform === "darwin",
  browserBoxDefault: "any",
  browserHostOnly: "",
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
  Pick<
    GateSettings,
    | "cpuSlotsBesideBrowser"
    | "cpuSlotsBesideReleaseBrowser"
    | "localBrowserSlots"
  >;

/** Issue 751: cpu runs that may run beside a browser run here. */
function besideOf(s: Partial<QueueSettings>): number {
  const n = s.cpuSlotsBesideBrowser ?? GATE_DEFAULTS.cpuSlotsBesideBrowser;
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** Issue 751 follow-up: cpu runs beside a release browser run here. */
function besideReleaseOf(s: Partial<QueueSettings>): number {
  const n =
    s.cpuSlotsBesideReleaseBrowser ??
    GATE_DEFAULTS.cpuSlotsBesideReleaseBrowser;
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** What localRoom reads of a run: its kind, and whether it is release. */
type RoomRun = Pick<GateEntry, "kind" | "priority">;

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
 * Issue 751 follow-up: a release-priority browser run uses the release
 * beside count instead, holding or waiting.
 */
export function localRoom(
  entries: GateEntry[],
  s: Pick<GateSettings, "cpuSlots"> & Partial<QueueSettings>,
) {
  const holders = entries.filter((e) => e.grantedAt);
  // Issue 625: a browser run on a test box doesn't hold this machine.
  let browser = holders.filter((e) => e.kind === "browser" && !e.box).length;
  let cpu = holders.filter((e) => e.kind === "cpu").length;
  const local = holders.filter((e) => e.kind === "browser" && !e.box);
  let release = local.some((e) => !!e.priority);
  let draining: number | undefined;
  const beside = besideOf(s);
  const besideRelease = besideReleaseOf(s);
  const browserSlots = localBrowserOf(s);
  const slots = Math.max(1, Math.floor(s.cpuSlots));
  const besideFor = (r: RoomRun) => (r.priority ? besideRelease : beside);
  /** cpu runs allowed beside the browser runs holding or draining for. */
  const cap = (): number => {
    let n = slots;
    if (browser > 0) n = Math.min(n, release ? besideRelease : beside);
    if (draining !== undefined) n = Math.min(n, draining);
    return n;
  };
  return {
    fits(r: RoomRun): boolean {
      if (r.kind === "browser")
        return browser < browserSlots && cpu <= besideFor(r);
      return cpu < cap();
    },
    take(r: RoomRun): void {
      if (r.kind === "browser") {
        browser++;
        if (r.priority) release = true;
      } else cpu++;
    },
    /**
     * A waiter that wanted this machine and could not start: a browser
     * waiter with a browser slot free waits only on cpu runs, so later cpu
     * grants stop at its beside count.
     */
    wait(r: RoomRun): void {
      if (r.kind === "browser" && browser < browserSlots)
        draining = Math.min(draining ?? Infinity, besideFor(r));
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

/** Why plain cpu asks wait on the machine's load (issues 1009, 1048). */
export type LoadHold =
  | { why: "release"; load: number; limit: number }
  | {
      why: "cores";
      load: number;
      limit: number;
      perCore: number;
      cores: number;
    };

/**
 * Why plain cpu asks wait now, if they do (a release cpu ask never does).
 * Issue 1009: the 5-minute load (`load`) is at or above cpuHoldLoad (0:
 * off) while a release browser run holds a browser slot, here or on a
 * test box (its app runs here).
 * Issue 1048: the load is over loadHoldPerCore × `cores` (0: off) while a
 * cpu run is going. With none going the next one starts, whatever the
 * load: the hold slows the line, never stops it.
 * Absent: they don't (or no load was read).
 */
export function loadHold(
  entries: GateEntry[],
  s: Partial<Pick<GateSettings, "cpuHoldLoad" | "loadHoldPerCore">>,
  load: number | undefined,
  cores?: number,
): LoadHold | undefined {
  if (load === undefined || !Number.isFinite(load)) return undefined;
  const limit = s.cpuHoldLoad ?? GATE_DEFAULTS.cpuHoldLoad;
  const release = entries.some(
    (e) => e.grantedAt && e.kind === "browser" && !!e.priority,
  );
  if (limit > 0 && load >= limit && release)
    return { why: "release", load, limit };
  const perCore = s.loadHoldPerCore ?? GATE_DEFAULTS.loadHoldPerCore;
  if (!(perCore > 0) || !(cores !== undefined && cores > 0)) return undefined;
  const coreLimit = Math.round(perCore * cores * 100) / 100;
  const cpuGoing = entries.some((e) => e.grantedAt && e.kind === "cpu");
  return load > coreLimit && cpuGoing
    ? { why: "cores", load, limit: coreLimit, perCore, cores }
    : undefined;
}

/**
 * Issue 1132: why a granted run's command may not start now: the 5-minute
 * load is at or over maxStartLoad (0: off). Absent: it may (or no load
 * was read).
 */
export function startHold(
  s: Partial<Pick<GateSettings, "maxStartLoad">>,
  load: number | undefined,
): { load: number; limit: number } | undefined {
  if (load === undefined || !Number.isFinite(load)) return undefined;
  const limit = s.maxStartLoad ?? GATE_DEFAULTS.maxStartLoad;
  return limit > 0 && load >= limit ? { load, limit } : undefined;
}

/** Issue 1048: a cpu slot's worker cap: its share of the cores, at least 2. */
export function gateWorkers(cores: number, cpuSlots: number): number {
  return Math.max(2, Math.floor(cores / Math.max(1, Math.floor(cpuSlots))));
}

/**
 * Which waiters may start now on this machine, in order. Issue 751: each
 * kind's line on its own; a waiter that can't start holds back only its
 * own kind (and, as a browser run, cpu runs past the beside count).
 */
export function grants(
  entries: GateEntry[],
  s: Pick<GateSettings, "cpuSlots"> &
    Partial<
      QueueSettings & Pick<GateSettings, "cpuHoldLoad" | "loadHoldPerCore">
    >,
  now: number = Date.now(),
  load?: number,
  cores?: number,
): string[] {
  const room = localRoom(entries, s);
  const held = windowHeld(entries, s.classes, now);
  const cpuHeld = !!loadHold(entries, s, load, cores); // issues 1009, 1048
  const out: string[] = [];
  const stopped = new Set<GateKind>();
  for (const w of queueOrder(entries, s, now)) {
    if (held.has(w.id)) continue; // issue 803: it waits for its window
    if (cpuHeld && w.kind === "cpu" && !w.priority) continue; // issue 1009
    if (stopped.has(w.kind)) continue;
    if (!room.fits(w)) {
      room.wait(w);
      stopped.add(w.kind);
      continue;
    }
    room.take(w);
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

/**
 * Issue 999: when the queue expects a holder to end (ms): as expectedEnd,
 * with the measured median in place of a padded estimate.
 */
export function queueEnd(e: GateEntry): number {
  return (
    t(e.grantedAt ?? e.askedAt) + queueMinOf(e) * (e.boxTimeScale ?? 1) * 60_000
  );
}

/**
 * Past its estimate plus the margin: flagged, never stopped. Issue 999: a
 * padded estimate's measured median, so padding can't hide a slot.
 */
export function overrun(
  e: GateEntry,
  s: Pick<GateSettings, "overrunMarginMinutes">,
  now: number,
): boolean {
  return !!e.grantedAt && now > queueEnd(e) + s.overrunMarginMinutes * 60_000;
}

/**
 * Issue 993: held past `overrunBellMultiple` times its estimate (the box's
 * time scale counted): the bell shows it, with End for the person.
 */
export function overrunBell(
  e: GateEntry,
  s: Pick<GateSettings, "overrunBellMultiple">,
  now: number,
): boolean {
  if (!e.grantedAt) return false;
  // Issue 999: a padded estimate's measured median, as overrun.
  const est = queueMinOf(e) * (e.boxTimeScale ?? 1) * 60_000;
  return now - t(e.grantedAt) > s.overrunBellMultiple * est;
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
      .map((e) => Math.max(now, queueEnd(e)))
      .sort((a, b) => a - b)
      .slice(-n);
    const slots = [...Array<number>(n - ends.length).fill(now), ...ends];
    for (const w of ahead.filter((x) => x.kind === "browser")) {
      const i = slots.indexOf(Math.min(...slots));
      slots[i] = slots[i]! + queueMinOf(w) * 60_000;
    }
    free = Math.min(...slots);
  } else {
    free = Math.max(
      now,
      ...entries.filter((e) => e.grantedAt && mine(e)).map(queueEnd),
    );
    for (const w of ahead) free += queueMinOf(w) * 60_000;
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
