/**
 * Issue 144 GATE-SLOT: the machine's slot store.
 *
 * One directory per machine user, shared by every install and repo on the
 * machine, and needing no running Den: `DEN_GATE_DIR`, else
 * ~/Library/Application Support/den/gate-slots (macOS), else
 * $XDG_STATE_HOME/den/gate-slots (~/.local/state). In it:
 *   slots/<id>.json   one per holder or waiter (no secrets, a label only)
 *   settings.json     cpu_slots, overrun_margin_minutes, release_slots,
 *                     release_quiet_wait_minutes, release_tag_max_age_hours,
 *                     cancel_grace_seconds
 *   events.jsonl      the slot log: asked, waits, granted, released, taken
 *                     back, overdue, ended early, cancelled (Coach reads
 *                     time lost)
 *   lock/             held while the grant decision is made
 *
 * Every read takes back a holder whose processes are gone, at once, and
 * records it; it flags (once) a holder past its estimate plus the margin.
 * Nothing here kills a process or takes a live holder's slot: stopping a
 * cancelled run is cancel.ts's, and the slot is freed only after it.
 */
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";
import {
  GATE_DEFAULTS,
  byQueue,
  expectedStart,
  gone,
  grants,
  idleDue,
  minutesPast,
  overrun,
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
  release_slots?: number | null;
  release_quiet_wait_minutes?: number | null;
  release_tag_max_age_hours?: number | null;
  cancel_grace_seconds?: number | null;
  idle_flag_after_minutes?: number | null;
  idle_cpu_percent?: number | null;
  idle_sample_seconds?: number | null;
  idle_cancel_grace_minutes?: number | null;
};

/** Each setting: its least and most, whether it is whole, and its field. */
export const GATE_LIMITS: Record<
  keyof GateSettingsPatch,
  { min: number; max: number; int: boolean; field: keyof GateSettings }
> = {
  cpu_slots: { min: 1, max: 64, int: true, field: "cpuSlots" },
  overrun_margin_minutes: {
    min: 0,
    max: 24 * 60,
    int: false,
    field: "overrunMarginMinutes",
  },
  release_slots: { min: 1, max: 16, int: true, field: "releaseSlots" },
  release_quiet_wait_minutes: {
    min: 0,
    max: 24 * 60,
    int: false,
    field: "releaseQuietWaitMinutes",
  },
  release_tag_max_age_hours: {
    min: 1,
    max: 24 * 366,
    int: false,
    field: "releaseTagMaxAgeHours",
  },
  cancel_grace_seconds: {
    min: 0,
    max: 3600,
    int: false,
    field: "cancelGraceSeconds",
  },
  idle_flag_after_minutes: {
    min: 0,
    max: 24 * 60,
    int: false,
    field: "idleFlagAfterMinutes",
  },
  idle_cpu_percent: { min: 0, max: 100, int: false, field: "idleCpuPercent" },
  idle_sample_seconds: {
    min: 1,
    max: 3600,
    int: false,
    field: "idleSampleSeconds",
  },
  idle_cancel_grace_minutes: {
    min: 0,
    max: 24 * 60,
    int: false,
    field: "idleCancelGraceMinutes",
  },
};

/**
 * A settings change as the web sends it ({cpu_slots, …}, null clears),
 * checked; or what is wrong.
 */
export function checkGatePatch(
  v: unknown,
): { ok: true; patch: GateSettingsPatch } | { ok: false; error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { ok: false, error: "gate_slots is an object" };
  const patch: GateSettingsPatch = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const l = GATE_LIMITS[k as keyof GateSettingsPatch];
    if (!l)
      return {
        ok: false,
        error: `gate_slots.${k} is not a setting (${Object.keys(GATE_LIMITS).join(", ")})`,
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
    patch[k as keyof GateSettingsPatch] = x;
  }
  return { ok: true, patch };
}

export type GateEvent =
  | "asked"
  | "waits"
  | "granted"
  | "released"
  | "taken-back-gone"
  | "overdue"
  | "ended-early"
  | "cancelled"
  | "idle"
  | "idle-cleared";

/** Issue 498: another holder, as a release run's record names it. */
export interface GateAlongside {
  id: string;
  kind: GateKind;
  label: string;
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
  /** waits: the slots it waits behind. */
  behind?: string[];
  /** waits: when it may expect to start (ISO). */
  expectedStart?: string;
  /** ended-early, cancelled: who did it. */
  by?: string;
  /** cancelled: whether it was waiting or running. */
  was?: "queued" | "running";
  /** Issue 498, a release run: its candidate tag and commit. */
  tag?: string;
  commit?: string;
  /** Issue 498, a release run's start and end: the machine's load (1, 5, 15 min). */
  load?: number[];
  /** Issue 498, a release run's start and end: the other runs holding. */
  alongside?: GateAlongside[];
  /** Issue 498: it started past the quiet wait, beside ordinary runs. */
  ranAnyway?: boolean;
  /** cancelled: why, when not its owner's or a person's own choice. */
  reason?: string;
  /** idle: minutes past its estimate, and its tree's CPU share (%). */
  minutesPast?: number;
  cpuPercent?: number;
}

/** What `cancel` did (issue 585). */
export type GateCancel =
  | { was: "queued"; row: GateEventRow }
  | {
      was: "running";
      row: GateEventRow;
      /** The run to stop before the slot frees, when gate run started one. */
      runPid?: number;
      /** runPid leads its own process group. */
      group: boolean;
    };

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
  /** Whether a pid is alive; a negative pid asks for a process group. */
  alive?: (pid: number) => boolean;
  /** How long to wait for the lock before giving up, ms. */
  lockWaitMs?: number;
  /** Issue 498: the machine's load average (os.loadavg). */
  load?: () => number[];
  /**
   * Idle flag: a holder's run tree's CPU seconds so far, or null when it
   * can't be read. Default: its process group's (groupCpuSeconds), only
   * on a store with real liveness; a store with a stubbed `alive` reads
   * nothing unless given one.
   */
  cpu?: (e: GateEntry) => number | null;
}

/** How far back cancelledBy reads the slot log. */
const LOG_TAIL_BYTES = 256 * 1024;

export class GateStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly lockWaitMs: number;
  private readonly load: () => number[];
  private readonly cpu: (e: GateEntry) => number | null;

  constructor(o: GateStoreOpts = {}) {
    this.dir = o.dir ?? gateDir();
    this.now = o.now ?? Date.now;
    this.alive = o.alive ?? isAlive;
    this.lockWaitMs = o.lockWaitMs ?? 10_000;
    this.load = o.load ?? (() => os.loadavg());
    this.cpu =
      o.cpu ??
      (o.alive
        ? () => null
        : (e) =>
            e.runPid === undefined
              ? null
              : e.runGroup
                ? groupCpuSeconds(e.runPid)
                : pidCpuSeconds(e.runPid));
  }

  /**
   * Idle flag: a holder due a look (idleDue) gets a CPU reading at most
   * once a window. A window later, below idle_cpu_percent of one CPU, it
   * is flagged (recorded `idle`, once); busy again, the flag is cleared.
   * Only a flag: nothing is stopped here. Returns whether it changed.
   */
  private sampleIdle(e: GateEntry, s: GateSettings, now: number): boolean {
    if (!idleDue(e, s, now)) return false;
    const prev = e.cpuSample;
    const windowMs = s.idleSampleSeconds * 1000;
    if (prev && now - Date.parse(prev.at) < windowMs) return false;
    let cpu: number | null = null;
    try {
      cpu = this.cpu(e);
    } catch {
      cpu = null;
    }
    if (cpu === null) return false;
    const at = new Date(now).toISOString();
    e.cpuSample = { at, cpu };
    if (!prev) return true;
    const secs = (now - Date.parse(prev.at)) / 1000;
    const pct = secs > 0 ? (Math.max(0, cpu - prev.cpu) / secs) * 100 : 100;
    if (pct < s.idleCpuPercent && !e.idleAt) {
      e.idleAt = at;
      this.record(e, {
        event: "idle",
        minutesPast: minutesPast(e, now),
        cpuPercent: Math.round(pct * 100) / 100,
      });
    } else if (pct >= s.idleCpuPercent && e.idleAt) {
      delete e.idleAt;
      this.record(e, {
        event: "idle-cleared",
        cpuPercent: Math.round(pct * 100) / 100,
      });
    }
    return true;
  }

  /** The store's clock (ms). */
  time(): number {
    return this.now();
  }

  /** Whether a pid (or, negative, a process group) is still running. */
  isAlive(pid: number): boolean {
    return this.alive(pid);
  }

  private get slots() {
    return path.join(this.dir, "slots");
  }

  settings(): GateSettings {
    let v: Record<string, unknown> = {};
    try {
      v = JSON.parse(
        fs.readFileSync(path.join(this.dir, "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
    } catch {
      return { ...GATE_DEFAULTS };
    }
    const out: GateSettings = { ...GATE_DEFAULTS };
    for (const [k, l] of Object.entries(GATE_LIMITS)) {
      const n = v[k];
      if (
        typeof n === "number" &&
        Number.isFinite(n) &&
        n >= l.min &&
        n <= l.max
      )
        out[l.field] = l.int ? Math.floor(n) : n;
    }
    return out;
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
    const full = {
      at,
      id: e.id,
      kind: e.kind,
      who: e.who,
      label: e.label,
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
   * Issue 585: who cancelled a slot that is gone, from the slot log's
   * recent rows; null when it wasn't cancelled.
   */
  cancelledBy(id: string): string | null {
    let text = "";
    try {
      const fd = fs.openSync(this.eventsFile, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, LOG_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        text = buf.toString("utf-8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (!l.includes(id) || !l.includes('"cancelled"')) continue;
      try {
        const r = JSON.parse(l) as GateEventRow;
        if (r.id === id && r.event === "cancelled") return r.by ?? "someone";
      } catch {
        /* a cut line at the tail's start */
      }
    }
    return null;
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

  /** Issue 498: a release run's record: the load and the runs beside it. */
  private loadNow(e: GateEntry, all: GateEntry[]): Partial<GateEventRow> {
    if (e.kind !== "release") return {};
    let load: number[] = [];
    try {
      load = this.load().map((n) => Math.round(n * 100) / 100);
    } catch {
      /* no load on this platform */
    }
    return {
      tag: e.tag,
      load,
      alongside: all
        .filter((x) => x.id !== e.id && x.grantedAt)
        .map((x) => ({ id: x.id, kind: x.kind, label: x.label })),
    };
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
      if (!gone(e, this.alive)) {
        entries.push(e);
        continue;
      }
      this.remove(e.id);
      this.record(e, { event: "taken-back-gone", ...this.heldFor(e, now) });
    }
    const ordinaryHeld = entries.some(
      (e) => e.grantedAt && e.kind !== "release",
    );
    for (const id of grants(entries, s, now)) {
      const e = entries.find((x) => x.id === id)!;
      e.grantedAt = at;
      this.write(e);
      this.record(e, {
        event: "granted",
        minutes: (now - Date.parse(e.askedAt)) / 60_000,
        ...this.loadNow(e, entries),
        ...(e.kind === "release" && ordinaryHeld ? { ranAnyway: true } : {}),
      });
    }
    for (const e of entries) {
      if (e.flaggedAt || !overrun(e, s, now)) continue;
      e.flaggedAt = at;
      this.write(e);
      this.record(e, { event: "overdue", ...this.heldFor(e, now) });
    }
    for (const e of entries) if (this.sampleIdle(e, s, now)) this.write(e);
    return entries.sort(
      (a, b) => Number(!a.grantedAt) - Number(!b.grantedAt) || byQueue(a, b),
    );
  }

  /** The queue now: holders first, then the waiters in the order they go. */
  list(): GateEntry[] {
    return this.locked(() => this.settle());
  }

  /** One slot now (after settling), or null when it is gone. */
  get(id: string): GateEntry | null {
    return this.list().find((e) => e.id === id) ?? null;
  }

  /**
   * Asks for a slot; returns the entry (granted at once if it may start).
   * Issue 498: a release ask names its candidate tag, proven by the caller
   * (release-proof.ts), and one tag asks once at a time.
   */
  ask(o: {
    kind: GateKind;
    who: string;
    label: string;
    pid: number;
    estimateMin: number;
    agent?: boolean;
    actor?: string;
    tag?: string;
    commit?: string;
  }): GateEntry {
    if (o.kind === "release" && (!o.tag || !o.commit))
      throw new Error("a release slot needs its candidate's proven tag");
    return this.locked(() => {
      if (
        o.kind === "release" &&
        this.readAll().some((x) => x.kind === "release" && x.tag === o.tag)
      )
        throw new Error(`a release run for ${o.tag} already holds or waits`);
      const e: GateEntry = {
        id: `${o.kind}-${randomBytes(5).toString("hex")}`,
        kind: o.kind,
        who: o.who.slice(0, 200),
        label: o.label.slice(0, 120),
        pid: o.pid,
        askedAt: new Date(this.now()).toISOString(),
        estimateMin: o.estimateMin,
        ...(o.agent ? { agent: true } : {}),
        ...(o.actor && /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.actor)
          ? { actor: o.actor }
          : {}),
        ...(o.kind === "release"
          ? { tag: o.tag!.slice(0, 80), commit: o.commit!.slice(0, 64) }
          : {}),
      };
      fs.mkdirSync(this.slots, { recursive: true });
      // Created whole and only once (#380): readAll never sees it half-written.
      writeFileAtomic(this.file(e.id), JSON.stringify(e), { exclusive: true });
      this.record(e, {
        event: "asked",
        ...(e.tag ? { tag: e.tag, commit: e.commit } : {}),
      });
      const all = this.settle();
      const now = all.find((x) => x.id === e.id) ?? e;
      if (!now.grantedAt)
        this.record(now, {
          event: "waits",
          behind: all.filter((x) => x.grantedAt).map((x) => x.id),
          expectedStart: new Date(
            expectedStart(all, e.id, this.now()),
          ).toISOString(),
        });
      return now;
    });
  }

  /**
   * gate run's command: the slot stays while it runs. `group`: it leads
   * its own process group. Returns the slot as it now stands, or null when
   * it is gone (cancelled while it started: the caller stops its run).
   */
  setRunPid(id: string, runPid: number, group = false): GateEntry | null {
    return this.locked(() => {
      const e = this.readAll().find((x) => x.id === id);
      if (!e) return null;
      e.runPid = runPid;
      if (group) e.runGroup = true;
      this.write(e);
      return e;
    });
  }

  /** The holder is done (or the waiter gives up). */
  release(id: string): boolean {
    return this.locked(() => {
      const all = this.readAll();
      const e = all.find((x) => x.id === id);
      if (!e) return false;
      this.remove(id);
      this.record(e, {
        event: "released",
        ...this.heldFor(e, this.now()),
        ...this.loadNow(e, all),
      });
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

  /** The slot as stored, without settling (a cancel checks it first). */
  peek(id: string): GateEntry | null {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) return null;
    return this.locked(() => this.readAll().find((x) => x.id === id) ?? null);
  }

  /**
   * Issue 585: withdraws a slot; recorded `cancelled` with who and whether
   * it was queued or running. A queued ask, or a holder with no run of its
   * own (an MCP hold), is gone at once. A running `gate run` slot is
   * marked cancelled and stays held: the caller stops its run (cancel.ts)
   * and frees it with releaseCancelled once the run's group is gone.
   * Who may cancel is the caller's to check (rules.ts mayCancel).
   */
  cancel(id: string, by: string, reason?: string): GateCancel | null {
    return this.locked(() => {
      const e = this.readAll().find((x) => x.id === id);
      if (!e) return null;
      const was = e.grantedAt ? ("running" as const) : ("queued" as const);
      const base = {
        event: "cancelled" as const,
        id,
        kind: e.kind,
        who: e.who,
        label: e.label,
        by: (e.cancelled?.by ?? by).slice(0, 200),
        was,
        ...(reason ? { reason: reason.slice(0, 200) } : {}),
      };
      if (was === "running" && e.runPid !== undefined) {
        let at = e.cancelled?.at;
        if (!at) {
          at = this.record(e, base);
          e.cancelled = { by: base.by, at };
          this.write(e);
        }
        return {
          was,
          row: { at, ...base },
          runPid: e.runPid,
          group: e.runGroup === true,
        };
      }
      this.remove(id);
      const at = this.record(e, base);
      this.settle();
      return was === "queued"
        ? { was, row: { at, ...base } }
        : { was, row: { at, ...base }, runPid: undefined, group: false };
    });
  }

  /** Issue 585: frees a cancelled slot once its run is gone (once). */
  releaseCancelled(id: string): boolean {
    return this.release(id);
  }
}

/**
 * Idle flag: CPU time as ps prints it, in seconds: Linux's
 * `[dd-]hh:mm:ss`, macOS's `[hh:]mm:ss.cc`. Null when it isn't one.
 */
export function parseCpuTime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s.trim());
  if (!m) return null;
  const [, d, h, mm, ss] = m;
  return (
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(mm) * 60 +
    Number(ss)
  );
}

/**
 * Idle flag: the CPU seconds of every process ps lists that matches `pick`
 * (its process group, or its pid), summed; null when ps can't say (no ps,
 * Windows, nothing matched).
 */
function psCpuSeconds(pick: (pgid: number, pid: number) => boolean) {
  if (process.platform === "win32") return null;
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-o", "pgid=,pid=,time="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  let sum = 0;
  let seen = false;
  for (const line of out.split("\n")) {
    const [g, p, time] = line.trim().split(/\s+/);
    if (!g || !p || !time || !pick(Number(g), Number(p))) continue;
    const s = parseCpuTime(time);
    if (s === null) continue;
    sum += s;
    seen = true;
  }
  return seen ? sum : null;
}

/** Idle flag: a process group's summed CPU seconds, or null. */
export function groupCpuSeconds(pgid: number): number | null {
  return psCpuSeconds((g) => g === pgid);
}

/** Idle flag: one process's CPU seconds, or null. */
export function pidCpuSeconds(pid: number): number | null {
  return psCpuSeconds((_g, p) => p === pid);
}

/** Group end: one process, as ps lists it. */
export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** Seconds since it started. */
  ageSec: number;
  comm: string;
}

/** Group end: a run's group and what left it (red-first stub). */
export function groupSurvey(
  _rows: ProcRow[],
  _pgid: number,
  _runAgeSec: number,
): { members: ProcRow[]; escaped: ProcRow[] } | null {
  return null;
}
