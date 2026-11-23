/**
 * Issue 144 GATE-SLOT: the machine's slot store.
 *
 * One directory per machine user, shared by every install and repo on the
 * machine, and needing no running Den: `DEN_GATE_DIR`, else
 * ~/Library/Application Support/den/gate-slots (macOS), else
 * $XDG_STATE_HOME/den/gate-slots (~/.local/state). In it:
 *   slots/<id>.json   one per holder or waiter (no secrets, a label only)
 *   settings.json     cpu_slots, cpu_slots_beside_browser (issue 751),
 *                     cpu_slots_beside_release_browser (its follow-up),
 *                     cpu_hold_load (issue 1009),
 *                     load_hold_per_core (issue 1048),
 *                     local_browser_slots,
 *                     overrun_margin_minutes, overrun_bell_multiple,
 *                     remote_renew_seconds, remote_lapse_seconds; issue
 *                     803: class_order, class_map, class_windows (text)
 *   events.jsonl      the slot log: asked, waits, granted, released, taken
 *                     back (process gone, or lease lapsed), overdue, ended
 *                     early (Coach reads time lost); issue 715: priority
 *                     (who, why, what it passed) and priority-waits;
 *                     issue 795: yielded (the entry and the one let ahead);
 *                     issue 867: waiter-gone, reattached, and a gone
 *                     waiter taken back with reason "waiter-gone"
 *   dropped.json      issue 867: places taken back from gone waiters, until
 *                     their asker asks again (told once) or a day passes
 *   lock/             held while the grant decision is made
 *
 * Every read takes back a holder whose processes are gone (or, issue 621,
 * a runner whose lease lapsed), at once, and records it; it flags (once) a holder past its estimate plus the margin.
 * Nothing here kills a process or takes a live holder's slot.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";
import { browserRequiresContainerDefault } from "./browser-container.js";
import {
  BOX_DEFAULTS,
  BOX_NAME_RE,
  assign,
  boxCapOf,
  boxOff,
  boxRecheckSeconds,
  boxesOf,
  boxesWanted,
  checkBox,
  checkBoxDefault,
  freshNo,
  freshYes,
  parseHostOnly,
  withMemory,
  readBoxStates,
  realBoxProbe,
  writeBoxStates,
  type BoxCap,
  type BoxOff,
  type BoxProbe,
  type BoxSettings,
  type BoxState,
  type GateBox,
} from "./boxes.js";
import {
  classOf,
  parseClassMap,
  parseClassOrder,
  parseClassWindows,
  readClasses,
} from "./classes.js";
import {
  DEFAULT_ESTIMATE_MIN,
  GATE_DEFAULTS,
  byAsked,
  expectedStart,
  gone,
  lapsed,
  mcpLapsed,
  overrun,
  passedBy,
  priorityIds,
  queueOrder,
  queuePlace,
  unclaimed,
  type GateEntry,
  type GateKind,
  type GateSettings,
} from "./rules.js";

export function gateDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.DEN_GATE_DIR?.trim();
  if (set) return path.resolve(set);
  const home = env.HOME?.trim() || os.homedir();
  if (process.platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "den",
      "gate-slots",
    );
  const xdg = env.XDG_STATE_HOME?.trim();
  return path.join(
    xdg || path.join(home, ".local", "state"),
    "den",
    "gate-slots",
  );
}

export type GateSettingsPatch = {
  cpu_slots?: number | null;
  /** Issue 751: cpu runs beside a browser run here; 0: it runs alone. */
  cpu_slots_beside_browser?: number | null;
  /** Issue 751 follow-up: cpu runs beside a release browser run (0). */
  cpu_slots_beside_release_browser?: number | null;
  /** Browser runs that may hold this machine at once (default 1). */
  local_browser_slots?: number | null;
  /** Issue 1009: cpu asks wait at this load under a release run (0: off). */
  cpu_hold_load?: number | null;
  /** Issue 1048: cpu asks wait over this many times the cores (0: off). */
  load_hold_per_core?: number | null;
  overrun_margin_minutes?: number | null;
  /** Issue 993: held past this many times its estimate: the bell. */
  overrun_bell_multiple?: number | null;
  remote_renew_seconds?: number | null;
  remote_lapse_seconds?: number | null;
  remote_max_slots?: number | null;
  remote_max_asks?: number | null;
  priority_max?: number | null;
  priority_pass_limit_minutes?: number | null;
  priority_agents?: number | null;
  priority_runners?: number | null;
  claim_minutes?: number | null;
  mcp_renew_minutes?: number | null;
  mcp_lapse_minutes?: number | null;
  mcp_grace_minutes?: number | null;
  waiter_return_minutes?: number | null;
  box_check_timeout_seconds?: number | null;
  box_recheck_seconds?: number | null;
  /** 1: a browser ask on this host declares a container browser. */
  browser_requires_container?: number | null;
  /** Issue 803: priority classes (text; "" or null clears). */
  class_order?: string | null;
  class_map?: string | null;
  class_windows?: string | null;
  /** Issue 1033: where a browser run with no --box goes: any or local. */
  browser_box_default?: string | null;
  /** Issue 1033: projects and label patterns kept on this machine. */
  browser_host_only?: string | null;
};

/** Issue 803: the settings that are a line of text, and their checks. */
/**
 * Issue 1002: the most of the slot log an ask's measured estimate reads,
 * from its end (1 MiB, some 5,000 rows), so an ask's cost doesn't grow
 * with the log. A log under it reads whole, as before.
 */
export const MEASURE_TAIL_MAX_BYTES = 1024 * 1024;
const MEASURE_CHUNK_BYTES = 64 * 1024;

export const GATE_TEXT: Record<
  | "class_order"
  | "class_map"
  | "class_windows"
  | "browser_box_default"
  | "browser_host_only",
  (v: string) => unknown
> = {
  class_order: parseClassOrder,
  class_map: parseClassMap,
  class_windows: parseClassWindows,
  browser_box_default: checkBoxDefault,
  browser_host_only: parseHostOnly,
};
type GateNumberKey = Exclude<keyof GateSettingsPatch, keyof typeof GATE_TEXT>;

/** Each setting: its least and most, and whether it is whole. */
export const GATE_LIMITS: Record<
  GateNumberKey,
  { min: number; max: number; int: boolean }
> = {
  cpu_slots: { min: 1, max: 64, int: true },
  // Issue 751: 0 is "a browser run runs alone".
  cpu_slots_beside_browser: { min: 0, max: 64, int: true },
  // 0 (the default) is "a release browser run runs alone".
  cpu_slots_beside_release_browser: { min: 0, max: 64, int: true },
  // Each local browser run is in its own container; 1 is one at a time.
  local_browser_slots: { min: 1, max: 64, int: true },
  // Issue 1009: a 5-minute load average; 0 turns the hold off.
  cpu_hold_load: { min: 0, max: 1024, int: false },
  // Issue 1048: a multiple of the cores; 0 turns the hold off.
  load_hold_per_core: { min: 0, max: 64, int: false },
  overrun_margin_minutes: { min: 0, max: 24 * 60, int: false },
  // Issue 993: 1 is "as soon as it passes its estimate".
  overrun_bell_multiple: { min: 1, max: 100, int: false },
  remote_renew_seconds: { min: 5, max: 3600, int: true },
  remote_lapse_seconds: { min: 10, max: 24 * 3600, int: true },
  remote_max_slots: { min: 1, max: 256, int: true },
  remote_max_asks: { min: 1, max: 256, int: true },
  // Issue 715: release priority. 0 turns it off; agents 1 yes, 0 no.
  priority_max: { min: 0, max: 16, int: true },
  // Issue 751: between marked runs only; 0: a marked run is never passed.
  priority_pass_limit_minutes: { min: 0, max: 24 * 60, int: false },
  priority_agents: { min: 0, max: 1, int: true },
  // Issue 739: CI runners may ask for priority; 1 yes, 0 no.
  priority_runners: { min: 0, max: 1, int: true },
  // Issue 714: an agent's slot held over MCP: claim, renew, lapse, grace.
  claim_minutes: { min: 1, max: 24 * 60, int: false },
  mcp_renew_minutes: { min: 1, max: 24 * 60, int: false },
  mcp_lapse_minutes: { min: 1, max: 7 * 24 * 60, int: false },
  mcp_grace_minutes: { min: 0, max: 7 * 24 * 60, int: false },
  // Issue 867: how long a gone waiter keeps its place.
  waiter_return_minutes: { min: 0, max: 24 * 60, int: false },
  // Issue 625: a test box's check, and how long a no from it is kept.
  // The check runs outside the lock, so it may take its time.
  // Clause 12: never more than 25 s (BOX_CHECK_CAP_MS).
  box_check_timeout_seconds: { min: 1, max: 25, int: true },
  box_recheck_seconds: { min: 1, max: 24 * 3600, int: true },
  // A browser ask declares a container browser; 1 yes, 0 no. Unset: yes
  // on a macOS host, no elsewhere (browser-container.ts).
  browser_requires_container: { min: 0, max: 1, int: true },
};

/**
 * A settings change as the web sends it ({cpu_slots,
 * overrun_margin_minutes}, null clears), checked; or what is wrong.
 */
export function checkGatePatch(
  v: unknown,
): { ok: true; patch: GateSettingsPatch } | { ok: false; error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { ok: false, error: "gate_slots is an object" };
  const patch: GateSettingsPatch = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    // Issue 803: a line of text, checked by its parser; "" clears it.
    const text = GATE_TEXT[k as keyof typeof GATE_TEXT];
    if (text) {
      if (x === undefined) continue;
      if (x !== null && (typeof x !== "string" || x.length > 2000))
        return { ok: false, error: `gate_slots.${k} is text, or null` };
      const err = x ? text(x) : null;
      if (typeof err === "string")
        return { ok: false, error: `gate_slots.${k}: ${err}` };
      (patch as Record<string, unknown>)[k] = x ? x.trim() : null;
      continue;
    }
    const l = GATE_LIMITS[k as GateNumberKey];
    if (!l)
      return {
        ok: false,
        error: `gate_slots.${k} is not a setting (${[...Object.keys(GATE_LIMITS), ...Object.keys(GATE_TEXT)].join(", ")})`,
      };
    if (x === undefined) continue;
    if (
      x !== null &&
      (typeof x !== "number" ||
        !Number.isFinite(x) ||
        x < l.min ||
        x > l.max ||
        (l.int && !Number.isInteger(x)))
    )
      return {
        ok: false,
        error: `gate_slots.${k} is ${l.int ? "a whole number" : "a number"} from ${l.min} to ${l.max}, or null`,
      };
    patch[k as GateNumberKey] = x;
  }
  return { ok: true, patch };
}

export type GateEvent =
  | "asked"
  | "waits"
  | "granted"
  | "released"
  | "taken-back-gone"
  | "taken-back-lapsed"
  | "taken-back-revoked"
  | "overdue"
  | "ended-early"
  | "priority"
  | "priority-waits"
  | "passed-unclaimed"
  | "yielded"
  // Issue 867: a waiter's run is gone, its place kept; and taken back.
  | "waiter-gone"
  | "reattached"
  // Issue 1263: a run's throwaway containers removed after its slot ended.
  | "containers-removed";

/** Issue 963: one key's change: the value in effect before and after. */
export interface GateSettingChange {
  from: number | string | null;
  to: number | string | null;
}

/** Issue 963: a settings change, in the slot log. */
export interface GateSettingsRow {
  at: string;
  event: "settings";
  /** Who changed it, named as an ask is (gate run's who). */
  by: string;
  changes: Record<string, GateSettingChange>;
}

/** A settings key's value in effect, as stored (true/false as 1/0). */
function settingValue(s: GateSettings, key: string): number | string | null {
  const camel = key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  const v = (s as unknown as Record<string, unknown>)[camel];
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return null;
}

/** Issue 867: a place taken back from a waiter whose run was gone. */
export interface DroppedPlace {
  id: string;
  kind: GateKind;
  who: string;
  label: string;
  askedAt: string;
  /** When it was taken back (ISO). */
  at: string;
  reason: "waiter-gone";
}

/**
 * Issue 867: a waiter (not a holder) asked through `gate run`, whose place
 * is kept while its run is gone. An MCP or runner entry has its lease.
 */
function keptWaiter(
  e: GateEntry,
  s: Pick<GateSettings, "waiterReturnMinutes">,
): boolean {
  return !e.grantedAt && !e.mcp && !e.remote && s.waiterReturnMinutes > 0;
}

/** Issue 999: the median of some minutes, to a whole minute. */
function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  const m = v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return Math.max(1, Math.round(m));
}

export interface GateEventRow {
  at: string;
  event: GateEvent;
  id: string;
  kind: GateKind;
  who: string;
  label: string;
  /** granted: minutes waited. released, taken back: minutes held. */
  minutes?: number;
  /** waits: the slots it waits behind; priority-waits: the priority runs. */
  behind?: string[];
  /** Issue 715: priority, priority-waits: why the run asked for it. */
  reason?: string;
  /** Issue 715: priority: the waiters it went ahead of. */
  passed?: string[];
  /** waits: when it may expect to start (ISO). */
  expectedStart?: string;
  /** ended-early: who ended it; priority: who asked (agent or person). */
  by?: string;
  /** Issue 621: a runner's slot: the runner token's name. */
  runner?: string;
  /** Issue 714: an MCP slot: the agent and the install that asked. */
  actor?: string;
  install?: string;
  /** Issue 714: granted while it waited: claim it by then (ISO). */
  claimBy?: string;
  /** Issue 625: the test box the slot is on (absent: this machine). */
  box?: string;
  /** Issue 795: yielded: the waiting entry let just ahead of this one. */
  to?: string;
  /** Issue 803: its class, when classes are set. */
  class?: string;
  /** Issue 1033: granted (browser): the test box's name, or "local". */
  machine?: string;
  /** Issue 1033: why a run that could go to a box stays here. */
  hostWhy?: string;
  /** Issue 1263: containers-removed: how many, and their image names. */
  count?: number;
  images?: string[];
}

/** Issue 715: who asked for priority, for the record (739: a runner). */
const byOf = (e: GateEntry): string =>
  e.remote
    ? `runner:${e.remote.runner}`
    : (e.actor ?? (e.agent ? "an agent" : "a person"));

/** Issue 715: a priority reason, one line, at most 200 characters. */
const reasonOf = (r: string | undefined) =>
  r?.replace(/\s+/g, " ").trim().slice(0, 200);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
};

export interface GateStoreOpts {
  dir?: string;
  now?: () => number;
  alive?: (pid: number) => boolean;
  /** How long to wait for the lock before giving up, ms. */
  lockWaitMs?: number;
  /** Issue 625: checks a test box (tests pass a fake). */
  probe?: BoxProbe;
  /** The host's platform (the browser-container default); tests set it. */
  platform?: NodeJS.Platform;
  /**
   * Issue 1009: the machine's 5-minute load average (default
   * os.loadavg()[1]); tests pass a stub.
   */
  load?: () => number;
  /** Issue 1048: the machine's cores (default os.availableParallelism). */
  cores?: () => number;
}

/**
 * Issue 1048: this machine's 5-minute load average. DEN_GATE_LOAD5 fixes
 * the reading (the test setup sets 0, so a busy machine never holds an
 * unrelated test's slot; a drill can set it high).
 */
export function realLoad(env: NodeJS.ProcessEnv = process.env): number {
  const fixed = Number((env.DEN_GATE_LOAD5 ?? "").trim() || NaN);
  return Number.isFinite(fixed) ? fixed : (os.loadavg()[1] ?? 0);
}

/** Issue 1048: this machine's cores. */
export const realCores = (): number =>
  os.availableParallelism?.() ?? os.cpus().length;

/**
 * Issue 621: renew and lapse, seconds. A lapse shorter than two renews
 * would take back a runner that renews on time: it is read as two.
 */
function leaseTimes(renew: number, lapse: number) {
  const r = Math.floor(renew);
  return {
    remoteRenewSeconds: r,
    remoteLapseSeconds: Math.max(Math.floor(lapse), 2 * r),
  };
}

/** Issue 803: the class settings, or none at all when no classes are set. */
function classSettings(
  classOrder: string,
  classMap: string,
  classWindows: string,
): Partial<GateSettings> {
  const classes = readClasses(classOrder, classMap, classWindows);
  return classes ? { classes, classOrder, classMap, classWindows } : {};
}

/** A browser run's declared container browser: short, one line. */
function browserEndpointOf(kind: GateKind, v: string | undefined) {
  return kind === "browser" && v && /^[\x21-\x7e]{1,300}$/.test(v)
    ? { browserEndpoint: v }
    : {};
}

/** Issue 1033: one line, at most 200 characters, no control characters. */
const oneLineOf = (r: string) =>
  r
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ")
    .trim()
    .slice(0, 200);

/** Issue 715: priority asked for by an agent where only people may. */
export class GatePriorityRefused extends Error {}

/** Issue 795: a yield that isn't the owner's, or isn't waiting to waiting. */
export class GateYieldRefused extends Error {}

/** Issue 621: a runner token has as many slots as it may. */
export class GateFullError extends Error {}

export class GateStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly lockWaitMs: number;
  /** Issue 867: the last ask took back a kept place (not a new entry). */
  lastAskReattached = false;
  private readonly probe: BoxProbe;
  private readonly readLoad: () => number;
  private readonly readCores: () => number;
  readonly platform: NodeJS.Platform;
  /** Issue 1002: bytes of the slot log measured() has read (for tests). */
  logBytesRead = 0;

  constructor(o: GateStoreOpts = {}) {
    this.platform = o.platform ?? process.platform;
    this.dir = o.dir ?? gateDir();
    this.now = o.now ?? Date.now;
    this.alive = o.alive ?? isAlive;
    this.lockWaitMs = o.lockWaitMs ?? 10_000;
    this.probe = o.probe ?? realBoxProbe;
    this.readLoad = o.load ?? (() => realLoad());
    this.readCores = o.cores ?? realCores;
  }

  /** Issue 1048: this machine's cores (at least 1). */
  cores(): number {
    try {
      const n = this.readCores();
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    } catch {
      return 1;
    }
  }

  /** Issue 1009: the machine's 5-minute load average now (NaN: unread). */
  load(): number {
    try {
      const n = this.readLoad();
      return Number.isFinite(n) ? n : NaN;
    } catch {
      return NaN;
    }
  }

  private get slots() {
    return path.join(this.dir, "slots");
  }

  /** Issue 993: the store's clock (ms), as its rules read the time. */
  clock(): number {
    return this.now();
  }

  settings(): GateSettings & BoxSettings {
    try {
      const v = JSON.parse(
        fs.readFileSync(path.join(this.dir, "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
      const text = (k: keyof typeof GATE_TEXT) =>
        typeof v[k] === "string" ? (v[k] as string) : "";
      const num = (k: GateNumberKey, d: number) => {
        const n = v[k];
        const l = GATE_LIMITS[k];
        return typeof n === "number" &&
          Number.isFinite(n) &&
          n >= l.min &&
          n <= l.max
          ? n
          : d;
      };
      return {
        cpuSlots: Math.floor(num("cpu_slots", GATE_DEFAULTS.cpuSlots)),
        cpuSlotsBesideBrowser: Math.floor(
          num("cpu_slots_beside_browser", GATE_DEFAULTS.cpuSlotsBesideBrowser),
        ),
        cpuSlotsBesideReleaseBrowser: Math.floor(
          num(
            "cpu_slots_beside_release_browser",
            GATE_DEFAULTS.cpuSlotsBesideReleaseBrowser,
          ),
        ),
        localBrowserSlots: Math.floor(
          num("local_browser_slots", GATE_DEFAULTS.localBrowserSlots),
        ),
        cpuHoldLoad: num("cpu_hold_load", GATE_DEFAULTS.cpuHoldLoad),
        loadHoldPerCore: num(
          "load_hold_per_core",
          GATE_DEFAULTS.loadHoldPerCore,
        ),
        overrunMarginMinutes: num(
          "overrun_margin_minutes",
          GATE_DEFAULTS.overrunMarginMinutes,
        ),
        overrunBellMultiple: num(
          "overrun_bell_multiple",
          GATE_DEFAULTS.overrunBellMultiple,
        ),
        ...leaseTimes(
          num("remote_renew_seconds", GATE_DEFAULTS.remoteRenewSeconds),
          num("remote_lapse_seconds", GATE_DEFAULTS.remoteLapseSeconds),
        ),
        remoteMaxSlots: Math.floor(
          num("remote_max_slots", GATE_DEFAULTS.remoteMaxSlots),
        ),
        remoteMaxAsks: Math.floor(
          num("remote_max_asks", GATE_DEFAULTS.remoteMaxAsks),
        ),
        priorityMax: Math.floor(num("priority_max", GATE_DEFAULTS.priorityMax)),
        priorityPassLimitMinutes: num(
          "priority_pass_limit_minutes",
          GATE_DEFAULTS.priorityPassLimitMinutes,
        ),
        priorityAgents:
          num("priority_agents", GATE_DEFAULTS.priorityAgents ? 1 : 0) === 1,
        priorityRunners:
          num("priority_runners", GATE_DEFAULTS.priorityRunners ? 1 : 0) === 1,
        claimMinutes: num("claim_minutes", GATE_DEFAULTS.claimMinutes),
        mcpRenewMinutes: num(
          "mcp_renew_minutes",
          GATE_DEFAULTS.mcpRenewMinutes,
        ),
        mcpLapseMinutes: num(
          "mcp_lapse_minutes",
          GATE_DEFAULTS.mcpLapseMinutes,
        ),
        mcpGraceMinutes: num(
          "mcp_grace_minutes",
          GATE_DEFAULTS.mcpGraceMinutes,
        ),
        waiterReturnMinutes: num(
          "waiter_return_minutes",
          GATE_DEFAULTS.waiterReturnMinutes,
        ),
        boxCheckTimeoutSeconds: num(
          "box_check_timeout_seconds",
          BOX_DEFAULTS.boxCheckTimeoutSeconds,
        ),
        boxRecheckSeconds: num(
          "box_recheck_seconds",
          BOX_DEFAULTS.boxRecheckSeconds,
        ),
        browserRequiresContainer:
          num(
            "browser_requires_container",
            browserRequiresContainerDefault(this.platform) ? 1 : 0,
          ) === 1,
        // Issue 1033: a browser run with no --box: here or a test box.
        browserBoxDefault:
          text("browser_box_default").trim() === "local" ? "local" : "any",
        browserHostOnly: text("browser_host_only"),
        // Issue 803: priority classes; none set is today's queue (and
        // today's settings, key for key).
        ...classSettings(
          text("class_order"),
          text("class_map"),
          text("class_windows"),
        ),
      };
    } catch {
      return {
        ...GATE_DEFAULTS,
        ...BOX_DEFAULTS,
        browserRequiresContainer: browserRequiresContainerDefault(
          this.platform,
        ),
      };
    }
  }

  /**
   * Writes the machine's settings; null clears a key (default again).
   * Issue 963: each change is in the slot log, with `by` (who changed it,
   * named as an ask is), when, and each key's value before and after (the
   * value in effect: a cleared key's is its default). No change, no row.
   */
  writeSettings(patch: GateSettingsPatch, by = "unknown"): void {
    const before = this.settings();
    this.writeSettingsFile(patch);
    const after = this.settings();
    const changes: Record<string, GateSettingChange> = {};
    for (const k of Object.keys(patch)) {
      const from = settingValue(before, k);
      const to = settingValue(after, k);
      if (from !== to) changes[k] = { from, to };
    }
    if (!Object.keys(changes).length) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const row: GateSettingsRow = {
      at: new Date(this.now()).toISOString(),
      event: "settings",
      by,
      changes,
    };
    fs.appendFileSync(this.eventsFile, JSON.stringify(row) + "\n");
  }

  /** Issue 963: the slot log's settings changes, oldest first. */
  settingsChanges(): GateSettingsRow[] {
    return this.logRows().filter(
      (r): r is GateSettingsRow => r.event === "settings",
    );
  }

  private writeSettingsFile(patch: GateSettingsPatch): void {
    const file = path.join(this.dir, "settings.json");
    let cur: Record<string, unknown> = {};
    try {
      cur = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      /* none yet */
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete cur[k];
      else if (v !== undefined) cur[k] = v;
    }
    writeFileAtomic(file, JSON.stringify(cur, null, 2) + "\n");
  }

  /** The slot log: every ask, wait, grant, release, flag and early end. */
  get eventsFile(): string {
    return path.join(this.dir, "events.jsonl");
  }

  /** Appends to the slot log; returns the row's time. */
  private record(e: GateEntry, row: Partial<GateEventRow>): string {
    fs.mkdirSync(this.dir, { recursive: true });
    const at = new Date(this.now()).toISOString();
    const cls = classOf(e, this.settings().classes);
    const full = {
      at,
      id: e.id,
      kind: e.kind,
      who: e.who,
      label: e.label,
      ...(e.remote ? { runner: e.remote.runner } : {}),
      ...(e.mcp ? { actor: e.actor, install: e.mcp.install } : {}),
      ...(e.box ? { box: e.box } : {}),
      ...(cls ? { class: cls } : {}),
      ...row,
    };
    fs.appendFileSync(this.eventsFile, JSON.stringify(full) + "\n");
    return at;
  }

  /**
   * Issue 1263: logs that run `id`'s throwaway containers were removed. The
   * slot is gone by then, so its kind, asker and label come from its last
   * row. Image names only: never a command line or environment.
   */
  noteContainersRemoved(
    id: string,
    r: { count: number; images: string[] },
  ): void {
    this.locked(() => {
      const last = this.events()
        .filter((x) => x.id === id)
        .at(-1);
      fs.mkdirSync(this.dir, { recursive: true });
      const row: GateEventRow = {
        at: new Date(this.now()).toISOString(),
        event: "containers-removed",
        id,
        kind: last?.kind ?? (id.startsWith("browser-") ? "browser" : "cpu"),
        who: last?.who ?? "",
        label: last?.label ?? "",
        count: r.count,
        images: r.images,
      };
      fs.appendFileSync(this.eventsFile, JSON.stringify(row) + "\n");
    });
  }

  /** The runs' rows (issue 963: never a settings change). */
  events(): GateEventRow[] {
    return this.logRows().filter(
      (r): r is GateEventRow => r.event !== "settings",
    );
  }

  private logRows(): (GateEventRow | GateSettingsRow)[] {
    try {
      return fs
        .readFileSync(this.eventsFile, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as GateEventRow | GateSettingsRow);
    } catch {
      return [];
    }
  }

  /**
   * Issue 867: a kept place of a gone waiter that this ask is the same run
   * as (kind, asker, label, and where it may run), taken back: its pid is
   * the new one, its place and id as they were. Call under the lock.
   */
  private keptPlaceFor(o: {
    kind: GateKind;
    who: string;
    label: string;
    pid: number;
    where?: string;
    mcp?: { install: string };
  }): GateEntry | null {
    if (o.mcp) return null;
    const s = this.settings();
    const now = this.now();
    const who = o.who.slice(0, 200);
    const label = o.label.slice(0, 120);
    const where = (whereOf(o.kind, o.where) as { where?: string }).where;
    const e = this.readAll()
      .filter(
        (x) =>
          x.kind === o.kind &&
          x.who === who &&
          x.label === label &&
          x.where === where &&
          keptWaiter(x, s) &&
          (x.orphanedAt || gone(x, this.alive)),
      )
      .sort((a, b) => a.askedAt.localeCompare(b.askedAt))[0];
    if (!e) return null;
    if (
      e.orphanedAt &&
      now - Date.parse(e.orphanedAt) > s.waiterReturnMinutes * 60_000
    )
      return null;
    e.pid = o.pid;
    delete e.runPid;
    delete e.orphanedAt;
    this.write(e);
    this.record(e, { event: "reattached" });
    return this.settle().find((x) => x.id === e.id) ?? e;
  }

  private get droppedFile(): string {
    return path.join(this.dir, "dropped.json");
  }

  private readDropped(): DroppedPlace[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.droppedFile, "utf-8"));
      return Array.isArray(v) ? (v as DroppedPlace[]) : [];
    } catch {
      return [];
    }
  }

  /** Issue 867: a place taken back from a gone waiter, kept a day (50 at most). */
  private noteDropped(e: GateEntry, at: string): void {
    const day = this.now() - 24 * 60 * 60_000;
    const kept = this.readDropped().filter((d) => Date.parse(d.at) > day);
    kept.push({
      id: e.id,
      kind: e.kind,
      who: e.who,
      label: e.label,
      askedAt: e.askedAt,
      at,
      reason: "waiter-gone",
    });
    writeFileAtomic(this.droppedFile, JSON.stringify(kept.slice(-50)) + "\n");
  }

  /**
   * Issue 867: what became of this asker's earlier place of the same run,
   * if a gone waiter's place was taken back in the last day. Told once.
   */
  droppedFor(
    e: Pick<GateEntry, "kind" | "who" | "label">,
  ): DroppedPlace | null {
    return this.locked(() => {
      const all = this.readDropped();
      const i = all.findIndex(
        (d) => d.kind === e.kind && d.who === e.who && d.label === e.label,
      );
      if (i < 0) return null;
      const [d] = all.splice(i, 1);
      writeFileAtomic(this.droppedFile, JSON.stringify(all) + "\n");
      return d!;
    });
  }

  /**
   * Holds the lock while `fn` runs. The lock names its holder's pid; a
   * lock whose holder is gone (killed while holding it) is taken back at
   * once (issue 275), and any lock older than 30 s is stale.
   */
  private locked<T>(fn: () => T): T {
    const lock = path.join(this.dir, "lock");
    fs.mkdirSync(this.dir, { recursive: true });
    const until = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        fs.mkdirSync(lock);
        try {
          fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
        } catch {
          /* the 30 s rule still covers it */
        }
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
        try {
          if (
            Date.now() - fs.statSync(lock).mtimeMs > 30_000 ||
            this.holderGone(lock)
          )
            fs.rmSync(lock, { recursive: true, force: true });
        } catch {
          /* someone else took it back */
        }
        if (Date.now() > until)
          throw new Error(`the gate-slot lock (${lock}) stayed held`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      return fn();
    } finally {
      try {
        fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    }
  }

  /** The lock names a pid, and that process is no longer running. */
  private holderGone(lock: string): boolean {
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf-8").trim());
    } catch {
      return false; // no pid yet: its holder may be writing it
    }
    return Number.isInteger(pid) && pid > 0 && !this.alive(pid);
  }

  private readAll(): GateEntry[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.slots).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: GateEntry[] = [];
    for (const n of names) {
      try {
        out.push(
          JSON.parse(
            fs.readFileSync(path.join(this.slots, n), "utf-8"),
          ) as GateEntry,
        );
      } catch {
        /* half-written or gone: skip */
      }
    }
    return out;
  }

  /**
   * Issue 1263: the ids of every slot (held or waiting), read strictly for a
   * sweep that removes containers: null when the slots can't be read for
   * sure (the folder unreadable or missing, a file unreadable or not JSON),
   * so "can't read" is never taken for "nothing is live". A file gone
   * between the listing and its read is a slot that just ended. Settles
   * first, as list() does.
   */
  liveIds(): Set<string> | null {
    const all = this.liveSlots();
    return all && new Set(all.map((e) => e.id));
  }

  /**
   * Issue 1289: liveIds' strict read, with each slot's checkout tag. Null
   * when the slots can't be read for sure.
   */
  liveSlots(): { id: string; checkout?: string }[] | null {
    this.list();
    let names: string[];
    try {
      names = fs.readdirSync(this.slots).filter((n) => n.endsWith(".json"));
    } catch {
      return null;
    }
    const out: { id: string; checkout?: string }[] = [];
    for (const n of names) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(this.slots, n), "utf-8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        return null;
      }
      try {
        const e = JSON.parse(text) as Partial<GateEntry>;
        if (typeof e.id !== "string") return null;
        out.push({
          id: e.id,
          ...(typeof e.checkout === "string" ? { checkout: e.checkout } : {}),
        });
      } catch {
        return null;
      }
    }
    return out;
  }

  private file(id: string) {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`not a slot id: ${id}`);
    return path.join(this.slots, `${id}.json`);
  }

  private write(e: GateEntry) {
    writeFileAtomic(this.file(e.id), JSON.stringify(e));
  }

  private remove(id: string) {
    try {
      fs.unlinkSync(this.file(id));
    } catch {
      /* already gone */
    }
  }

  private heldFor(e: GateEntry, now: number) {
    return e.grantedAt
      ? { minutes: (now - Date.parse(e.grantedAt)) / 60_000 }
      : {};
  }

  /**
   * Takes back the gone, grants who may start, flags the overdue, and
   * returns the queue as it now stands. Call under the lock.
   */
  private settle(claimNow?: string): GateEntry[] {
    const s = this.settings();
    const now = this.now();
    const at = new Date(now).toISOString();
    const entries: GateEntry[] = [];
    for (const e of this.readAll()) {
      // Issue 714: an MCP holder's lease lapses as a runner's does.
      const lapse = lapsed(e, now) || mcpLapsed(e, s, now);
      // Issue 867: a kept waiter stays on the kept-place path even when its
      // old pid number is in use again (another process): its time still
      // runs out, and only its own run asking again takes it back.
      if (!lapse && !e.orphanedAt && !gone(e, this.alive)) {
        entries.push(e);
        continue;
      }
      // Issue 867: a waiter whose run is gone keeps its place a while;
      // one whose process was gone as it asked never waited, so not it.
      if (!lapse && e.id !== claimNow && keptWaiter(e, s)) {
        if (!e.orphanedAt) {
          e.orphanedAt = at;
          this.write(e);
          this.record(e, { event: "waiter-gone" });
        }
        if (now - Date.parse(e.orphanedAt) <= s.waiterReturnMinutes * 60_000) {
          entries.push(e);
          continue;
        }
      }
      this.remove(e.id);
      const why = !lapse && e.orphanedAt ? "waiter-gone" : undefined;
      this.record(e, {
        event: lapse ? "taken-back-lapsed" : "taken-back-gone",
        ...this.heldFor(e, now),
        ...(why ? { reason: why } : {}),
      });
      if (why) this.noteDropped(e, at);
    }
    // Issue 714: an MCP slot granted while it waited and not claimed in
    // time passes on, when someone waits: back in line, at its end.
    if (entries.some((x) => !x.grantedAt))
      for (const e of entries) {
        if (!unclaimed(e, now)) continue;
        this.record(e, { event: "passed-unclaimed", ...this.heldFor(e, now) });
        delete e.grantedAt;
        delete e.flaggedAt;
        delete e.mcp!.claimBy;
        // Issue 625: the box it was given is free again; a new grant
        // picks the place afresh.
        delete e.box;
        delete e.boxTimeScale;
        e.askedAt = at;
        this.write(e);
      }
    // Issue 715: a run that takes priority is recorded once: who, why,
    // and the waiters it goes ahead of.
    for (const id of priorityIds(entries, s)) {
      const e = entries.find((x) => x.id === id)!;
      if (!e.priority || e.priority.at) continue;
      e.priority = { ...e.priority, at };
      this.write(e);
      this.record(e, {
        event: "priority",
        by: byOf(e),
        reason: e.priority.reason,
        passed: passedBy(entries, e.id, s, now),
      });
    }
    // Issue 625: test boxes; an open answer is good for one assignment.
    const caps = this.boxCaps(now);
    // Issue 1009: the machine's load, read once per pass.
    // Issue 867: a gone waiter keeps its place but is never given a slot.
    const live = entries.filter((x) => !x.orphanedAt);
    for (const g of assign(
      live,
      s,
      now,
      caps.caps,
      this.load(),
      this.cores(),
    )) {
      const e = entries.find((x) => x.id === g.id)!;
      e.grantedAt = at;
      // Issue 714: an MCP ask granted while it waited is claimed by its
      // agent within claimMinutes; one granted as it asks is claimed.
      if (e.mcp)
        e.mcp =
          e.id === claimNow
            ? { install: e.mcp.install, renewedAt: at }
            : {
                install: e.mcp.install,
                claimBy: new Date(now + s.claimMinutes * 60_000).toISOString(),
              };
      if (g.box) this.onBox(e, g.box, caps);
      this.write(e);
      this.record(e, {
        event: "granted",
        minutes: (now - Date.parse(e.askedAt)) / 60_000,
        ...(e.mcp?.claimBy ? { claimBy: e.mcp.claimBy } : {}),
        // Issue 1033: the machine a browser run got, and why it stayed.
        ...(e.kind === "browser" ? { machine: e.box ?? "local" } : {}),
        ...(e.hostWhy ? { hostWhy: e.hostWhy } : {}),
      });
    }
    if (caps.used) writeBoxStates(this.dir, caps.states);
    for (const e of entries) {
      if (e.flaggedAt || !overrun(e, s, now)) continue;
      e.flaggedAt = at;
      this.write(e);
      this.record(e, { event: "overdue", ...this.heldFor(e, now) });
    }
    return [
      ...entries.filter((e) => e.grantedAt).sort(byAsked),
      ...queueOrder(entries, s, now),
    ];
  }

  /** The queue now: holders first, then the waiters in the order they start. */
  list(): GateEntry[] {
    return this.locked(() => this.settle());
  }

  /**
   * Issue 999: a run's estimate from the slot log's finished runs: the
   * median of the label's last 10 (3 or more), else of the asker's last
   * 10 of its kind, else none. The asker: the same `who`, or its agent.
   */
  measured(o: {
    kind: GateKind;
    label: string;
    who: string;
    actor?: string;
  }): { minutes: number; from: "label" | "actor" } | null {
    // Issue 1002: newest first, from the log's tail, until the label has
    // its 10 (nothing older could change the answer) or the cap is read.
    const label: number[] = [];
    const mine: number[] = [];
    this.tailRows((r) => {
      if (r.event !== "released" || typeof r.minutes !== "number") return true;
      if (r.kind !== o.kind) return true;
      if (r.label === o.label && label.length < 10) label.push(r.minutes);
      // Its agent's runs from any project, or the same asker in words.
      if (
        mine.length < 10 &&
        (r.who === o.who || (!!o.actor && r.actor === o.actor))
      )
        mine.push(r.minutes);
      return label.length < 10;
    });
    if (label.length >= 3) return { minutes: median(label), from: "label" };
    return mine.length ? { minutes: median(mine), from: "actor" } : null;
  }

  /**
   * Issue 1002: the slot log's rows, newest first, read back from its end
   * in chunks, to `visit` until it returns false, the log's start, or
   * MEASURE_TAIL_MAX_BYTES read. A broken line is skipped.
   */
  private tailRows(visit: (r: GateEventRow | GateSettingsRow) => boolean) {
    let fd: number;
    try {
      fd = fs.openSync(this.eventsFile, "r");
    } catch {
      return;
    }
    try {
      let pos = fs.fstatSync(fd).size;
      const floor = Math.max(0, pos - MEASURE_TAIL_MAX_BYTES);
      // Bytes of a line cut by the chunk before (it continues later on).
      let rest = Buffer.alloc(0);
      while (pos > floor) {
        const n = Math.min(MEASURE_CHUNK_BYTES, pos - floor);
        pos -= n;
        const chunk = Buffer.alloc(n);
        fs.readSync(fd, chunk, 0, n, pos);
        this.logBytesRead += n;
        const buf = Buffer.concat([chunk, rest]);
        // The first line is whole only at the log's start.
        let end = buf.length;
        let nl = buf.lastIndexOf(0x0a, end - 1);
        while (nl >= 0) {
          const l = buf.subarray(nl + 1, end).toString("utf-8");
          if (l && !this.visitLine(l, visit)) return;
          end = nl;
          nl = end > 0 ? buf.lastIndexOf(0x0a, end - 1) : -1;
        }
        rest = buf.subarray(0, end);
        if (pos === 0 && rest.length) {
          this.visitLine(rest.toString("utf-8"), visit);
          return;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private visitLine(
    l: string,
    visit: (r: GateEventRow | GateSettingsRow) => boolean,
  ): boolean {
    let r: GateEventRow | GateSettingsRow;
    try {
      r = JSON.parse(l) as GateEventRow | GateSettingsRow;
    } catch {
      return true;
    }
    return visit(r);
  }

  /**
   * Issue 999: the entry's estimate fields. None given: the measured
   * median, else the kind's default. Given and over twice the median: kept
   * and flagged, and the queue uses the median.
   */
  private estimateOf(o: {
    kind: GateKind;
    label: string;
    who: string;
    actor?: string;
    estimateMin?: number;
  }): Pick<
    GateEntry,
    "estimateMin" | "estimateFrom" | "expectedMin" | "expectedFrom" | "padded"
  > {
    const m = this.measured({
      kind: o.kind,
      label: o.label.slice(0, 120),
      who: o.who.slice(0, 200),
      ...(o.actor ? { actor: o.actor } : {}),
    });
    if (o.estimateMin === undefined)
      return m
        ? { estimateMin: m.minutes, estimateFrom: m.from }
        : { estimateMin: DEFAULT_ESTIMATE_MIN, estimateFrom: "default" };
    if (m && o.estimateMin > 2 * m.minutes)
      return {
        estimateMin: o.estimateMin,
        estimateFrom: "given",
        expectedMin: m.minutes,
        expectedFrom: m.from,
        padded: true,
      };
    return { estimateMin: o.estimateMin, estimateFrom: "given" };
  }

  /** One slot now (after settling), or null when it is gone. */
  get(id: string): GateEntry | null {
    return this.list().find((e) => e.id === id) ?? null;
  }

  /** Asks for a slot; returns the entry (granted at once if it may start). */
  ask(o: {
    kind: GateKind;
    who: string;
    label: string;
    pid: number;
    /** Issue 999: absent: the measured median, else the kind's default. */
    estimateMin?: number;
    agent?: boolean;
    actor?: string;
    /** Issue 715: a release run a person waits on, and why. */
    priority?: { reason: string };
    /** Issue 714: an agent's ask over MCP (claim and lease). */
    mcp?: { install: string };
    /** Issue 625: "local" (default), "any", or a test box's name. */
    where?: string;
    /** Issue 625 clause 11: the run's Playwright client version. */
    pwVersion?: string;
    /** Issue 803: the project it runs for (settings give its class). */
    project?: string;
    /** A browser run's declared container browser, as recorded. */
    browserEndpoint?: string;
    /** Issue 1033: why a run that could go to a box stays here. */
    hostWhy?: string;
    /** Issue 1033: a default pick's boxes (the others can't serve it). */
    onlyBoxes?: string[];
    /** Issue 1289: the run's checkout tag (12 hex characters). */
    checkout?: string;
  }): GateEntry {
    const reason = reasonOf(o.priority?.reason);
    if (o.priority && !reason)
      throw new GatePriorityRefused("a priority ask needs a reason");
    return this.locked(() => {
      if (reason && o.agent && !this.settings().priorityAgents)
        throw new GatePriorityRefused(
          "only a person may ask for release priority on this machine (Settings, gate priority)",
        );
      // Issue 867: the same run asking again takes back its kept place.
      const back = this.keptPlaceFor(o);
      this.lastAskReattached = !!back;
      if (back) return back;
      const e: GateEntry = {
        id: `${o.kind}-${randomBytes(5).toString("hex")}`,
        kind: o.kind,
        who: o.who.slice(0, 200),
        ...(o.project ? { project: o.project.slice(0, 120) } : {}),
        ...(o.checkout && /^[0-9a-f]{12}$/.test(o.checkout)
          ? { checkout: o.checkout }
          : {}),
        label: o.label.slice(0, 120),
        pid: o.pid,
        askedAt: new Date(this.now()).toISOString(),
        ...this.estimateOf(o),
        ...(o.agent ? { agent: true } : {}),
        ...(o.actor && /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.actor)
          ? { actor: o.actor }
          : {}),
        ...(reason ? { priority: { for: "release" as const, reason } } : {}),
        ...(o.mcp ? { mcp: { install: o.mcp.install.slice(0, 512) } } : {}),
        ...whereOf(o.kind, o.where),
        ...(o.pwVersion && /^[0-9A-Za-z.-]{1,48}$/.test(o.pwVersion)
          ? { pwVersion: o.pwVersion }
          : {}),
        ...browserEndpointOf(o.kind, o.browserEndpoint),
        ...(o.kind === "browser" && o.hostWhy
          ? { hostWhy: oneLineOf(o.hostWhy) }
          : {}),
        ...(o.kind === "browser" && o.where === "any" && o.onlyBoxes
          ? {
              onlyBoxes: o.onlyBoxes
                .filter((n) => BOX_NAME_RE.test(n))
                .slice(0, 64),
            }
          : {}),
      };
      fs.mkdirSync(this.slots, { recursive: true });
      // Created whole and only once (#380): readAll never sees it half-written.
      writeFileAtomic(this.file(e.id), JSON.stringify(e), { exclusive: true });
      return this.afterAsk(e);
    });
  }

  /**
   * A new entry is written: log the ask, settle, and log where it waits
   * (issue 715: behind another priority run, if it is marked). Call under
   * the lock.
   */
  private afterAsk(e: GateEntry): GateEntry {
    this.record(e, { event: "asked" });
    // Issue 714: granted as it asks, an MCP slot is claimed at once.
    const all = this.settle(e.id);
    const now = all.find((x) => x.id === e.id) ?? e;
    // Issue 715: marked, but another holds priority: it waits behind it.
    if (now.priority && !now.priority.at && !now.grantedAt)
      this.record(now, {
        event: "priority-waits",
        reason: now.priority.reason,
        behind: all
          .filter((x) => x.kind === now.kind && !x.grantedAt && x.priority?.at)
          .map((x) => x.id),
      });
    if (!now.grantedAt)
      this.record(now, {
        event: "waits",
        behind: all.filter((x) => x.grantedAt).map((x) => x.id),
        expectedStart: new Date(
          expectedStart(all, e.id, this.now(), this.settings()),
        ).toISOString(),
      });
    return now;
  }

  /**
   * Issue 621: a runner (a CI job in a VM, over HTTP) asks. It holds by
   * lease: renew() within remoteLapseSeconds, or it is taken back. Same
   * queue, kinds and slot log as a local ask.
   */
  askRemote(o: {
    kind: GateKind;
    who: string;
    label: string;
    estimateMin: number;
    runner: string;
    tokenId: string;
    /** Issue 739: a release run a person waits on, and why. */
    priority?: { reason: string };
    /** Issue 625: "local" (default), "any", or a test box's name. */
    where?: string;
    /** A browser run's declared container browser, as recorded. */
    browserEndpoint?: string;
  }): GateEntry {
    const reason = reasonOf(o.priority?.reason);
    if (o.priority && !reason)
      throw new GatePriorityRefused("a priority ask needs a reason");
    return this.locked(() => {
      if (reason && !this.settings().priorityRunners)
        throw new GatePriorityRefused(
          "CI runners may not ask for release priority on this machine (Settings, gate priority); ask without it to wait in the normal queue",
        );
      // One token's live slots are capped (a Setting): a retrying or
      // runaway runner can't fill the queue.
      const max = this.settings().remoteMaxSlots;
      if (
        this.readAll().filter((x) => x.remote?.tokenId === o.tokenId).length >=
        max
      )
        throw new GateFullError(
          `this runner has ${max} gate slots already (held or waiting); release one, or raise the limit in Settings`,
        );
      const e: GateEntry = {
        id: `${o.kind}-${randomBytes(5).toString("hex")}`,
        kind: o.kind,
        who: o.who.slice(0, 200),
        label: o.label.slice(0, 120),
        pid: 0,
        askedAt: new Date(this.now()).toISOString(),
        estimateMin: o.estimateMin,
        ...whereOf(o.kind, o.where),
        ...browserEndpointOf(o.kind, o.browserEndpoint),
        remote: {
          runner: o.runner.slice(0, 64),
          tokenId: o.tokenId,
          leaseUntil: this.leaseEnd(),
        },
        ...(reason ? { priority: { for: "release" as const, reason } } : {}),
      };
      fs.mkdirSync(this.slots, { recursive: true });
      writeFileAtomic(this.file(e.id), JSON.stringify(e), { exclusive: true });
      return this.afterAsk(e);
    });
  }

  private leaseEnd(): string {
    return new Date(
      this.now() + this.settings().remoteLapseSeconds * 1000,
    ).toISOString();
  }

  /**
   * Issue 621: a runner renews its lease (holding or still waiting), and
   * hears where it stands. Null when the slot is gone (lapsed, ended,
   * released) or isn't this token's.
   */
  renew(id: string, tokenId: string): GateEntry | null {
    return this.locked(() => {
      const all = this.settle();
      const e = all.find((x) => x.id === id);
      if (!e?.remote || e.remote.tokenId !== tokenId) return null;
      e.remote = { ...e.remote, leaseUntil: this.leaseEnd() };
      this.write(e);
      return e;
    });
  }

  /**
   * Issue 621: a runner token was revoked: its slots, held or waiting, are
   * taken back at once (logged), and the next in line starts.
   */
  takeBackToken(tokenId: string): number {
    return this.locked(() => {
      const mine = this.readAll().filter((x) => x.remote?.tokenId === tokenId);
      const now = this.now();
      for (const e of mine) {
        this.remove(e.id);
        this.record(e, {
          event: "taken-back-revoked",
          ...this.heldFor(e, now),
        });
      }
      if (mine.length) this.settle();
      return mine.length;
    });
  }

  /**
   * Issue 621: one slot as its file stands, with no lock and no settle: a
   * waiting ask's cheap look between its locked renews.
   */
  peek(id: string): GateEntry | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), "utf-8")) as GateEntry;
    } catch {
      return null;
    }
  }

  /** Issue 621: a runner gives back its own slot. */
  releaseRemote(id: string, tokenId: string): boolean {
    return this.locked(() => {
      const e = this.readAll().find((x) => x.id === id);
      if (!e?.remote || e.remote.tokenId !== tokenId) return false;
      this.remove(id);
      this.record(e, { event: "released", ...this.heldFor(e, this.now()) });
      this.settle();
      return true;
    });
  }

  /**
   * Issue 714: an MCP holder asks again with its id: a granted slot is
   * claimed (if it waited for that) and its lease renewed. Null when gone
   * or not an MCP slot.
   */
  renewMcp(id: string): GateEntry | null {
    return this.locked(() => {
      const e = this.settle().find((x) => x.id === id);
      if (!e?.mcp) return null;
      if (!e.grantedAt) return e;
      e.mcp = {
        install: e.mcp.install,
        renewedAt: new Date(this.now()).toISOString(),
      };
      this.write(e);
      return e;
    });
  }

  /**
   * Issue 714: the slot log's rows after byte `from` (a reader's place),
   * and the place to read from next. From past the end (a log that was
   * cut short), it reads from the start.
   */
  eventsFrom(from: number): { rows: GateEventRow[]; next: number } {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(this.eventsFile);
    } catch {
      return { rows: [], next: 0 };
    }
    const start = from > buf.length ? 0 : from;
    const end = buf.lastIndexOf(0x0a) + 1;
    if (end <= start) return { rows: [], next: start };
    const rows: GateEventRow[] = [];
    for (const l of buf.subarray(start, end).toString("utf-8").split("\n")) {
      if (!l) continue;
      try {
        rows.push(JSON.parse(l) as GateEventRow);
      } catch {
        /* a broken line: skip */
      }
    }
    return { rows, next: end };
  }

  /** Issue 714: the slot log's size now, bytes (where a reader starts). */
  eventsEnd(): number {
    try {
      return fs.statSync(this.eventsFile).size;
    } catch {
      return 0;
    }
  }

  /** 0 holding; a waiter's place in line (1 is next); -1 when gone. */
  place(id: string): number {
    return queuePlace(this.list(), id, this.settings(), this.now());
  }

  /** gate run's command: the slot stays while it runs. */
  setRunPid(id: string, runPid: number): void {
    this.locked(() => {
      const e = this.readAll().find((x) => x.id === id);
      if (!e) return;
      e.runPid = runPid;
      this.write(e);
    });
  }

  /** The holder is done (or the waiter gives up). */
  release(id: string): boolean {
    return this.locked(() => {
      const e = this.readAll().find((x) => x.id === id);
      if (!e) return false;
      this.remove(id);
      this.record(e, { event: "released", ...this.heldFor(e, this.now()) });
      this.settle();
      return true;
    });
  }

  /**
   * Issue 795: the owner of waiting entry `id` lets waiting entry `to` go
   * just ahead of it; it keeps its own place otherwise. `owns` says whether
   * the caller owns an entry; a refusal changes nothing. Returns the slot
   * log's row.
   */
  yieldTo(
    id: string,
    to: string,
    owns: (e: GateEntry) => boolean,
  ): GateEventRow {
    return this.locked(() => {
      const all = this.settle();
      const e = all.find((x) => x.id === id);
      if (!e || !owns(e))
        throw new GateYieldRefused(`${id} isn't yours (or is gone)`);
      if (e.grantedAt)
        throw new GateYieldRefused(
          `${id} holds its slot; only a waiting entry can yield`,
        );
      const w = all.find((x) => x.id === to);
      if (!w || w.grantedAt || w.id === id)
        throw new GateYieldRefused(
          "the one you let ahead must be another waiting entry (gate status lists them)",
        );
      const order = queueOrder(all, this.settings(), this.now());
      if (order.indexOf(w) < order.indexOf(e))
        throw new GateYieldRefused(`${to} is already ahead of ${id}`);
      const at = new Date(this.now()).toISOString();
      e.yields = [...(e.yields ?? []), { to, at }];
      this.write(e);
      const row = { event: "yielded" as const, to };
      this.record(e, row);
      this.settle();
      return { at, id, kind: e.kind, who: e.who, label: e.label, ...row };
    });
  }

  /**
   * A person ends someone's slot early; recorded with who. The run it was
   * for is not stopped. Returns the slot log's row (an install's audit
   * points to it), or null if no slot.
   */
  endEarly(id: string, by: string): GateEventRow | null {
    return this.locked(() => {
      const e = this.readAll().find((x) => x.id === id);
      if (!e) return null;
      this.remove(id);
      const row = {
        event: "ended-early" as const,
        id,
        kind: e.kind,
        who: e.who,
        label: e.label,
        by: by.slice(0, 200),
      };
      const at = this.record(e, row);
      this.settle();
      return { at, ...row };
    });
  }

  // ---- Issue 625: test boxes (shared/gates/boxes.ts) ----

  private settingsFile(): Record<string, unknown> {
    try {
      const v = JSON.parse(
        fs.readFileSync(path.join(this.dir, "settings.json"), "utf-8"),
      ) as unknown;
      return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** The test boxes (settings.json `boxes`); none by default. */
  boxes(): GateBox[] {
    return boxesOf(this.settingsFile().boxes);
  }

  /** Writes the box list; the named box is checked afresh. */
  private writeBoxes(list: GateBox[], fresh: string): void {
    const cur = this.settingsFile();
    if (list.length) cur.boxes = list;
    else delete cur.boxes;
    writeFileAtomic(
      path.join(this.dir, "settings.json"),
      JSON.stringify(cur, null, 2) + "\n",
    );
    const st = readBoxStates(this.dir);
    if (fresh in st) {
      delete st[fresh];
      writeBoxStates(this.dir, st);
    }
  }

  /** Adds a test box, or replaces the one of that name. */
  setBox(v: unknown): GateBox {
    const c = checkBox(v);
    if (!c.ok) throw new Error(c.error);
    this.locked(() =>
      this.writeBoxes(
        [...this.boxes().filter((b) => b.name !== c.box.name), c.box],
        c.box.name,
      ),
    );
    return c.box;
  }

  /**
   * Removes a test box. Its running slots finish; a waiter that named it
   * waits until a box of that name is set again.
   */
  removeBox(name: string): boolean {
    return this.locked(() => {
      const list = this.boxes();
      if (!list.some((b) => b.name === name)) return false;
      this.writeBoxes(
        list.filter((b) => b.name !== name),
        name,
      );
      return true;
    });
  }

  /**
   * Turns a test box on or off (a person's). Off: no new slot and no
   * contact; its running slots finish. The box, or null when none is set.
   */
  setBoxEnabled(name: string, on: boolean): GateBox | null {
    return this.locked(() => {
      const list = this.boxes();
      const b = list.find((x) => x.name === name);
      if (!b) return null;
      if (on) delete b.enabled;
      else b.enabled = false;
      this.writeBoxes(list, name);
      return b;
    });
  }

  /** The boxes skipped now (turned off, or outside their window), and why. */
  boxesOff(): Record<string, BoxOff> {
    const now = this.now();
    const out: Record<string, BoxOff> = {};
    for (const b of this.boxes()) {
      const off = boxOff(b, now);
      if (off) out[b.name] = off;
    }
    return out;
  }

  /** What the last check of each box found. */
  boxStates(): Record<string, BoxState> {
    return readBoxStates(this.dir);
  }

  /** The boxes as one assignment sees them (under the lock). */
  private boxCaps(now: number) {
    const boxes = this.boxes();
    const states = boxes.length ? readBoxStates(this.dir) : {};
    const s = this.settings();
    // Turned off, or outside its window: no new slot (running ones finish).
    const caps: BoxCap[] = boxes
      .filter((b) => !boxOff(b, now))
      .map((b) =>
        boxCapOf(b, freshYes(states[b.name], now, s.boxCheckTimeoutSeconds)),
      );
    return { boxes, states, caps, used: false };
  }

  /** A grant on a box: its name and time scale; its open answer is used. */
  private onBox(
    e: GateEntry,
    box: string,
    c: { boxes: GateBox[]; states: Record<string, BoxState>; used: boolean },
  ): void {
    e.box = box;
    const scale = c.boxes.find((b) => b.name === box)?.time_scale;
    if (scale && scale !== 1) e.boxTimeScale = scale;
    delete c.states[box];
    c.used = true;
  }

  /**
   * Checks the test boxes a waiter would be given a slot on now, then
   * gives the slots. Called by whoever waits (gate run, a runner's ask),
   * never on a timer. A box is checked only when a slot on it is about to
   * be given; a held or unreachable box is not checked again for
   * its recheck_seconds (else box_recheck_seconds). A box turned off, or
   * outside its window, is never contacted. The checks run outside the
   * lock. A held or unreachable box is passed over in the same call: the
   * run goes to the next box, or waits.
   */
  async checkBoxes(): Promise<void> {
    const boxes = this.boxes();
    if (!boxes.length) return;
    const s = this.settings();
    for (let round = 0; round < boxes.length; round++) {
      const now = this.now();
      const states = readBoxStates(this.dir);
      const caps = boxes
        .filter(
          (b) =>
            !boxOff(b, now) &&
            !freshNo(states[b.name], now, boxRecheckSeconds(b, s)),
        )
        .map((b) => boxCapOf(b, true));
      const want = boxesWanted(this.readAll(), s, now, caps).filter(
        (n) => !freshYes(states[n], now, s.boxCheckTimeoutSeconds),
      );
      if (!want.length) {
        this.locked(() => this.settle());
        return;
      }
      const found = await Promise.all(
        want.map(async (n) => {
          const b = boxes.find((x) => x.name === n)!;
          try {
            return {
              n,
              r: withMemory(
                b,
                await this.probe(b, s.boxCheckTimeoutSeconds * 1000),
              ),
            };
          } catch (e) {
            return {
              n,
              r: {
                state: "unreachable" as const,
                reason: (e as Error).message,
              },
            };
          }
        }),
      );
      const no = this.locked(() => {
        const st = readBoxStates(this.dir);
        const at = new Date(this.now()).toISOString();
        for (const { n, r } of found)
          st[n] = {
            state: r.state,
            ...(r.reason ? { reason: r.reason.slice(0, 200) } : {}),
            at,
          };
        writeBoxStates(this.dir, st);
        this.settle();
        return found.some((f) => f.r.state !== "open");
      });
      if (!no) return;
    }
  }
}

/** Issue 625: where a browser run may go, as stored (local is the default). */
function whereOf(kind: GateKind, where: string | undefined) {
  return kind === "browser" && where && where !== "local" ? { where } : {};
}
