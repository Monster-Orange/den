/**
 * Issue 144 GATE-SLOT: the machine's slot store.
 *
 * One directory per machine user, shared by every install and repo on the
 * machine, and needing no running Den: `DEN_GATE_DIR`, else
 * ~/Library/Application Support/den/gate-slots (macOS), else
 * $XDG_STATE_HOME/den/gate-slots (~/.local/state). In it:
 *   slots/<id>.json   one per holder or waiter (no secrets, a label only)
 *   settings.json     cpu_slots, overrun_margin_minutes,
 *                     remote_renew_seconds, remote_lapse_seconds; issue
 *                     803: class_order, class_map, class_windows (text)
 *   events.jsonl      the slot log: asked, waits, granted, released, taken
 *                     back (process gone, or lease lapsed), overdue, ended
 *                     early (Coach reads time lost); issue 715: priority
 *                     (who, why, what it passed) and priority-waits
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
import {
  classOf,
  parseClassMap,
  parseClassOrder,
  parseClassWindows,
  readClasses,
} from "./classes.js";
import {
  GATE_DEFAULTS,
  byAsked,
  expectedStart,
  gone,
  grants,
  lapsed,
  overrun,
  passedBy,
  priorityIds,
  queueOrder,
  queuePlace,
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
  overrun_margin_minutes?: number | null;
  remote_renew_seconds?: number | null;
  remote_lapse_seconds?: number | null;
  remote_max_slots?: number | null;
  remote_max_asks?: number | null;
  priority_max?: number | null;
  priority_pass_limit_minutes?: number | null;
  priority_agents?: number | null;
  /** Issue 803: priority classes (text; "" or null clears). */
  class_order?: string | null;
  class_map?: string | null;
  class_windows?: string | null;
};

/** Issue 803: the settings that are a line of text, and their checks. */
export const GATE_TEXT: Record<
  "class_order" | "class_map" | "class_windows",
  (v: string) => unknown
> = {
  class_order: parseClassOrder,
  class_map: parseClassMap,
  class_windows: parseClassWindows,
};
type GateNumberKey = Exclude<keyof GateSettingsPatch, keyof typeof GATE_TEXT>;

/** Each setting: its least and most, and whether it is whole. */
export const GATE_LIMITS: Record<
  GateNumberKey,
  { min: number; max: number; int: boolean }
> = {
  cpu_slots: { min: 1, max: 64, int: true },
  overrun_margin_minutes: { min: 0, max: 24 * 60, int: false },
  remote_renew_seconds: { min: 5, max: 3600, int: true },
  remote_lapse_seconds: { min: 10, max: 24 * 3600, int: true },
  remote_max_slots: { min: 1, max: 256, int: true },
  remote_max_asks: { min: 1, max: 256, int: true },
  // Issue 715: release priority. 0 turns it off; agents 1 yes, 0 no.
  priority_max: { min: 0, max: 16, int: true },
  priority_pass_limit_minutes: { min: 1, max: 24 * 60, int: false },
  priority_agents: { min: 0, max: 1, int: true },
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
  | "priority-waits";

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
  /** Issue 803: its class, when classes are set. */
  class?: string;
}

/** Issue 715: who asked for priority, for the record. */
const byOf = (e: GateEntry): string =>
  e.actor ?? (e.agent ? "an agent" : "a person");

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
}

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

/** Issue 715: priority asked for by an agent where only people may. */
export class GatePriorityRefused extends Error {}

/** Issue 621: a runner token has as many slots as it may. */
export class GateFullError extends Error {}

export class GateStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly lockWaitMs: number;

  constructor(o: GateStoreOpts = {}) {
    this.dir = o.dir ?? gateDir();
    this.now = o.now ?? Date.now;
    this.alive = o.alive ?? isAlive;
    this.lockWaitMs = o.lockWaitMs ?? 10_000;
  }

  private get slots() {
    return path.join(this.dir, "slots");
  }

  settings(): GateSettings {
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
        overrunMarginMinutes: num(
          "overrun_margin_minutes",
          GATE_DEFAULTS.overrunMarginMinutes,
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
        // Issue 803: priority classes; none set is today's queue (and
        // today's settings, key for key).
        ...classSettings(
          text("class_order"),
          text("class_map"),
          text("class_windows"),
        ),
      };
    } catch {
      return { ...GATE_DEFAULTS };
    }
  }

  /** Writes the machine's settings; null clears a key (default again). */
  writeSettings(patch: GateSettingsPatch): void {
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
      ...(cls ? { class: cls } : {}),
      ...row,
    };
    fs.appendFileSync(this.eventsFile, JSON.stringify(full) + "\n");
    return at;
  }

  events(): GateEventRow[] {
    try {
      return fs
        .readFileSync(this.eventsFile, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as GateEventRow);
    } catch {
      return [];
    }
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
  private settle(): GateEntry[] {
    const s = this.settings();
    const now = this.now();
    const at = new Date(now).toISOString();
    const entries: GateEntry[] = [];
    for (const e of this.readAll()) {
      const lapse = lapsed(e, now);
      if (!lapse && !gone(e, this.alive)) {
        entries.push(e);
        continue;
      }
      this.remove(e.id);
      this.record(e, {
        event: lapse ? "taken-back-lapsed" : "taken-back-gone",
        ...this.heldFor(e, now),
      });
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
    for (const id of grants(entries, s, now)) {
      const e = entries.find((x) => x.id === id)!;
      e.grantedAt = at;
      this.write(e);
      this.record(e, {
        event: "granted",
        minutes: (now - Date.parse(e.askedAt)) / 60_000,
      });
    }
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
    estimateMin: number;
    agent?: boolean;
    actor?: string;
    /** Issue 715: a release run a person waits on, and why. */
    priority?: { reason: string };
    /** Issue 803: the project it runs for (settings give its class). */
    project?: string;
  }): GateEntry {
    const reason = o.priority?.reason.replace(/\s+/g, " ").trim().slice(0, 200);
    if (o.priority && !reason)
      throw new GatePriorityRefused("a priority ask needs a reason");
    return this.locked(() => {
      if (reason && o.agent && !this.settings().priorityAgents)
        throw new GatePriorityRefused(
          "only a person may ask for release priority on this machine (Settings, gate priority)",
        );
      const e: GateEntry = {
        id: `${o.kind}-${randomBytes(5).toString("hex")}`,
        kind: o.kind,
        who: o.who.slice(0, 200),
        ...(o.project ? { project: o.project.slice(0, 120) } : {}),
        label: o.label.slice(0, 120),
        pid: o.pid,
        askedAt: new Date(this.now()).toISOString(),
        estimateMin: o.estimateMin,
        ...(o.agent ? { agent: true } : {}),
        ...(o.actor && /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.actor)
          ? { actor: o.actor }
          : {}),
        ...(reason ? { priority: { for: "release" as const, reason } } : {}),
      };
      fs.mkdirSync(this.slots, { recursive: true });
      // Created whole and only once (#380): readAll never sees it half-written.
      writeFileAtomic(this.file(e.id), JSON.stringify(e), { exclusive: true });
      this.record(e, { event: "asked" });
      const all = this.settle();
      const now = all.find((x) => x.id === e.id) ?? e;
      // Issue 715: marked, but another holds priority: it waits behind it.
      if (now.priority && !now.priority.at && !now.grantedAt)
        this.record(now, {
          event: "priority-waits",
          reason: now.priority.reason,
          behind: all
            .filter(
              (x) => x.kind === now.kind && !x.grantedAt && x.priority?.at,
            )
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
    });
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
  }): GateEntry {
    return this.locked(() => {
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
        remote: {
          runner: o.runner.slice(0, 64),
          tokenId: o.tokenId,
          leaseUntil: this.leaseEnd(),
        },
      };
      fs.mkdirSync(this.slots, { recursive: true });
      writeFileAtomic(this.file(e.id), JSON.stringify(e), { exclusive: true });
      this.record(e, { event: "asked" });
      const all = this.settle();
      const now = all.find((x) => x.id === e.id) ?? e;
      if (!now.grantedAt)
        this.record(now, {
          event: "waits",
          behind: all.filter((x) => x.grantedAt).map((x) => x.id),
          expectedStart: new Date(
            expectedStart(all, e.id, this.now(), this.settings()),
          ).toISOString(),
        });
      return now;
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
}
