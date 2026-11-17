/**
 * Issue 144 GATE-SLOT: the machine's slot store.
 *
 * One directory per machine user, shared by every install and repo on the
 * machine, and needing no running Den: `DEN_GATE_DIR`, else
 * ~/Library/Application Support/den/gate-slots (macOS), else
 * $XDG_STATE_HOME/den/gate-slots (~/.local/state). In it:
 *   slots/<id>.json   one per holder or waiter (no secrets, a label only)
 *   settings.json     cpu_slots, overrun_margin_minutes
 *   events.jsonl      the slot log: asked, waits, granted, released, taken
 *                     back, overdue, ended early (Coach reads time lost)
 *   lock/             held while the grant decision is made
 *
 * Every read takes back a holder whose processes are gone, at once, and
 * records it; it flags (once) a holder past its estimate plus the margin.
 * Nothing here kills a process or takes a live holder's slot.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";
import {
  GATE_DEFAULTS,
  byAsked,
  expectedStart,
  gone,
  grants,
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
};

/** Each setting: its least and most, and whether it is whole. */
export const GATE_LIMITS: Record<
  keyof GateSettingsPatch,
  { min: number; max: number; int: boolean }
> = {
  cpu_slots: { min: 1, max: 64, int: true },
  overrun_margin_minutes: { min: 0, max: 24 * 60, int: false },
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
  | "ended-early";

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
  /** ended-early: who ended it. */
  by?: string;
}

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
      const num = (k: keyof GateSettingsPatch, d: number) => {
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

  /** Holds the lock while `fn` runs. A lock older than 30 s is stale. */
  private locked<T>(fn: () => T): T {
    const lock = path.join(this.dir, "lock");
    fs.mkdirSync(this.dir, { recursive: true });
    const until = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 30_000)
            fs.rmdirSync(lock);
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
        fs.rmdirSync(lock);
      } catch {
        /* already gone */
      }
    }
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
      if (!gone(e, this.alive)) {
        entries.push(e);
        continue;
      }
      this.remove(e.id);
      this.record(e, { event: "taken-back-gone", ...this.heldFor(e, now) });
    }
    for (const id of grants(entries, s)) {
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
    return entries.sort(
      (a, b) => Number(!a.grantedAt) - Number(!b.grantedAt) || byAsked(a, b),
    );
  }

  /** The queue now: holders first, then the waiters in the order they asked. */
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
  }): GateEntry {
    return this.locked(() => {
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
      };
      fs.mkdirSync(this.slots, { recursive: true });
      // Created whole and only once (#380): readAll never sees it half-written.
      writeFileAtomic(this.file(e.id), JSON.stringify(e), { exclusive: true });
      this.record(e, { event: "asked" });
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
