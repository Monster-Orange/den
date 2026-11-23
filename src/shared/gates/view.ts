/**
 * Issue 144 GATE-SLOT: the queue as the web page, the MCP tools and
 * `gate status --json` show it.
 */
import {
  expectedStart,
  loadHold,
  overrun,
  priorityIds,
  queueEnd,
  queueMinOf,
  yieldedTo,
  type EstimateSource,
} from "./rules.js";
import { boxEndpoints, boxSkipReason, type GateBox } from "./boxes.js";
import { classOf, windowHeld } from "./classes.js";
import type { GateStore } from "./store.js";

export interface GateSlotView {
  id: string;
  kind: "browser" | "cpu";
  who: string;
  label: string;
  granted: boolean;
  /** Issue 999: the estimate given (or measured), and where from. */
  estimate: { minutes: number; from: EstimateSource };
  /** Issue 999: what the queue's wait times use, and where from. */
  expected: { minutes: number; from: EstimateSource };
  /** Issue 999: the given estimate is over twice the measured median. */
  padded?: boolean;
  agent: boolean;
  actor?: string;
  /** Issue 621: a CI runner's slot (held by lease): the runner's name. */
  runner?: string;
  /** Issue 714: granted to an MCP agent, not claimed yet: by then. */
  claimBy?: string;
  /** Issue 625: the test box it holds a slot on (absent: this machine). */
  box?: string;
  /** Issue 1033: a held browser slot's machine: the box's name, or "local". */
  machine?: string;
  /** Issue 1033: why a run that could go to a box stays here. */
  hostWhy?: string;
  /** Issue 625: a waiter that may go to a box: "any", or the box's name. */
  where?: string;
  /** Issue 625 clause 11: boxes this waiter can't use, and why. */
  skips?: { box: string; reason: string }[];
  /** A browser run's declared container browser: "self" or its address. */
  browserEndpoint?: string;
  grantedAt?: string;
  expectedEnd?: string;
  overrun?: boolean;
  askedAt?: string;
  expectedStart?: string;
  /**
   * Issue 715: a release run a person waits on: why, and whether it holds
   * priority now (false: it waits behind another, or already started).
   */
  priority?: { reason: string; holds: boolean };
  /** Issue 795: waiting entries it let go just ahead of it, until it starts. */
  yieldedTo?: string[];
  /** Issue 803: its class (from settings), when classes are set. */
  class?: string;
  /** Issue 803: held for its class's window ("22:00-06:00"). */
  window?: string;
  /**
   * Issue 1009: a cpu waiter held by the machine's load while a release
   * browser run holds a browser slot: the load and the setting.
   */
  loadHold?: {
    load: number;
    limit: number;
    /** Issue 1048: "cores" (over a multiple of the cores) or "release". */
    why: "release" | "cores";
    perCore?: number;
    cores?: number;
  };
  /**
   * Issue 1132: granted, but its command waits for the machine's load to
   * drop under gates.max_start_load: the load seen, the ceiling, since.
   */
  startHold?: { load: number; limit: number; since: string };
}

/** Issue 1132: what was stopped of an ended run (the last hour). */
export interface GateLeftoverView {
  at: string;
  id: string;
  label: string;
  cmd: string;
  count: number;
  reason: string;
}

/**
 * Issue 625: a test box as the queue shows it: its slots, how many are
 * held, and what its last check found ("unchecked" before the first).
 * Never how Den reaches it.
 */
export interface GateBoxView {
  name: string;
  slots: number;
  held: number;
  /** "off": turned off; "window": outside its window (no contact either). */
  state:
    | "open"
    | "held"
    | "unreachable"
    | "low"
    | "unknown"
    | "unchecked"
    | "off"
    | "window";
  reason?: string;
  checkedAt?: string;
  /** Issue 1017: the Playwright versions its servers serve, when set. */
  playwrightVersions?: string[];
  /** Its window, "HH:MM-HH:MM" in the gate machine's local time. */
  window?: string;
  /** Outside its window: when it opens, the gate machine's "HH:MM"... */
  opens?: string;
  /** ...and that moment (ISO), for a page to show in its viewer's time. */
  opensAt?: string;
}

/** Why a box is skipped by choice, in words (gate status, doctor). */
export function boxOffWords(b: GateBoxView): string | undefined {
  if (b.state === "off") return "turned off";
  if (b.state === "window") return `outside its window (opens ${b.opens})`;
  return undefined;
}

/** Issue 1017: a box's Playwright versions, never its addresses. */
const versionsOf = (b: GateBox) => {
  const vs = boxEndpoints(b)
    .map((x) => x.version)
    .filter((v): v is string => !!v);
  return vs.length ? { playwrightVersions: vs } : {};
};

export function gateBoxesView(
  store: GateStore,
  slots: { box?: string; granted: boolean }[],
): GateBoxView[] {
  const states = store.boxStates();
  const off = store.boxesOff();
  return store.boxes().map((b) => {
    const st = states[b.name];
    const o = off[b.name];
    const base = {
      name: b.name,
      slots: b.browser_slots,
      held: slots.filter((s) => s.granted && s.box === b.name).length,
      ...(b.window ? { window: b.window } : {}),
    };
    // Turned off or outside its window: never checked, whatever it said.
    if (o)
      return o.why === "off"
        ? { ...base, state: "off" as const }
        : {
            ...base,
            state: "window" as const,
            opens: o.opens,
            opensAt: new Date(o.opensAt).toISOString(),
          };
    return {
      ...base,
      state: st?.state ?? "unchecked",
      ...(st?.reason ? { reason: st.reason } : {}),
      ...(st?.at ? { checkedAt: st.at } : {}),
      ...versionsOf(b),
    };
  });
}

export function gateView(store: GateStore, now = Date.now()) {
  const all = store.list();
  const settings = store.settings();
  const pri = priorityIds(all, settings);
  const boxes = store.boxes();
  const skipsOf = (e: (typeof all)[number]) => {
    if (e.grantedAt || !e.where) return [];
    return boxes
      .filter((b) => e.where === "any" || e.where === b.name)
      .map((b) => ({
        box: b.name,
        // Issue 1033: a default pick leaves out a box that can't serve it.
        reason:
          e.onlyBoxes && !e.onlyBoxes.includes(b.name)
            ? "it declares no Playwright version: a run takes it only with --box"
            : boxSkipReason(e, b),
      }))
      .filter((x) => x.reason);
  };
  const held = windowHeld(all, settings.classes, now);
  const hold = loadHold(all, settings, store.load(), store.cores());
  const slots: GateSlotView[] = all.map((e) => ({
    id: e.id,
    kind: e.kind,
    who: e.who,
    label: e.label,
    granted: !!e.grantedAt,
    // Issue 999: the given estimate and what the queue uses, each with
    // where it came from; padded: the given one is over twice the median.
    estimate: { minutes: e.estimateMin, from: e.estimateFrom ?? "given" },
    expected: {
      minutes: queueMinOf(e),
      from: e.expectedFrom ?? e.estimateFrom ?? "given",
    },
    ...(e.padded ? { padded: true } : {}),
    agent: e.agent === true,
    ...(e.actor ? { actor: e.actor } : {}),
    ...(e.remote ? { runner: e.remote.runner } : {}),
    // Issue 714: an agent's MCP slot granted while it waited, unclaimed.
    ...(e.mcp?.claimBy ? { claimBy: e.mcp.claimBy } : {}),
    ...(e.box ? { box: e.box } : {}),
    ...(e.grantedAt && e.kind === "browser"
      ? { machine: e.box ?? "local" }
      : {}),
    ...(e.hostWhy ? { hostWhy: e.hostWhy } : {}),
    ...(!e.grantedAt && e.where ? { where: e.where } : {}),
    ...(skipsOf(e).length ? { skips: skipsOf(e) } : {}),
    ...(e.browserEndpoint ? { browserEndpoint: e.browserEndpoint } : {}),
    ...(e.priority
      ? { priority: { reason: e.priority.reason, holds: pri.has(e.id) } }
      : {}),
    ...(yieldedTo(e, all).length ? { yieldedTo: yieldedTo(e, all) } : {}),
    ...(settings.classes ? { class: classOf(e, settings.classes) } : {}),
    ...(held.has(e.id) ? { window: held.get(e.id)!.text } : {}),
    ...(hold && !e.grantedAt && e.kind === "cpu" && !e.priority
      ? {
          loadHold: {
            ...hold,
            load: Math.round(hold.load * 10) / 10,
          },
        }
      : {}),
    ...(e.grantedAt && e.startHold ? { startHold: e.startHold } : {}),
    ...(e.grantedAt
      ? {
          grantedAt: e.grantedAt,
          // Issue 999: what the queue expects (a padded one's median).
          expectedEnd: new Date(queueEnd(e)).toISOString(),
          overrun: overrun(e, settings, now),
        }
      : {
          askedAt: e.askedAt,
          expectedStart: new Date(
            expectedStart(all, e.id, now, settings),
          ).toISOString(),
        }),
  }));
  // Issue 1132: leftovers stopped in the last hour (the TERM row: KILL
  // after it is the same run's).
  const leftovers: GateLeftoverView[] = store
    .stoppedLeftovers(now - 60 * 60_000)
    .filter((r) => r.signal !== "KILL")
    .map((r) => ({
      at: r.at,
      id: r.id,
      label: r.label,
      cmd: r.cmd ?? "",
      count: r.count ?? 0,
      reason: r.reason ?? "ended",
    }));
  return {
    settings,
    slots,
    boxes: gateBoxesView(store, slots),
    leftovers,
    // Issue 1264: agents' heavy runs that ran outside the gate today.
    outsideToday: store.outsideToday(),
  };
}
