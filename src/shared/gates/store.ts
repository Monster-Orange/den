/**
 * 0.4.49 GATE-SLOT (den#144): the machine's slot store.
 *
 * One directory per machine user, shared by every install and repo on the
 * machine, and needing no running Den: `DEN_GATE_DIR`, else
 * ~/Library/Application Support/den/gate-slots (macOS), else
 * $XDG_STATE_HOME/den/gate-slots (~/.local/state). In it:
 *   slots/<id>.json   one per holder or waiter (no secrets, a label only)
 *   settings.json     cpu_slots, lease_minutes, overrun_margin_minutes
 *   events.jsonl      grant, wait, release, taken back, ended early
 *   lock/             held while the grant decision is made
 *
 * Every read takes back a holder whose process is gone or that went quiet
 * past the lease, and records it. Nothing here kills a process.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GATE_DEFAULTS,
  grants,
  takenBackWhy,
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

export type GateEvent =
  | "asked"
  | "granted"
  | "released"
  | "taken-back-gone"
  | "taken-back-quiet"
  | "ended-early"
  | "renewed";

export interface GateEventRow {
  at: string;
  event: GateEvent;
  id: string;
  kind: GateKind;
  who: string;
  label: string;
  /** For granted: minutes waited. For released: minutes held. */
  minutes?: number;
  /** For ended-early: who ended it. */
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
      const num = (k: string, d: number, min: number) => {
        const n = v[k];
        return typeof n === "number" && Number.isFinite(n) && n >= min ? n : d;
      };
      return {
        cpuSlots: Math.floor(num("cpu_slots", GATE_DEFAULTS.cpuSlots, 1)),
        leaseMinutes: num("lease_minutes", GATE_DEFAULTS.leaseMinutes, 1),
        overrunMarginMinutes: num(
          "overrun_margin_minutes",
          GATE_DEFAULTS.overrunMarginMinutes,
          0,
        ),
      };
    } catch {
      return { ...GATE_DEFAULTS };
    }
  }

  /** Writes the machine's settings; null clears a key (default again). */
  writeSettings(patch: {
    cpu_slots?: number | null;
    lease_minutes?: number | null;
    overrun_margin_minutes?: number | null;
  }): void {
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
    this.atomicWrite(file, JSON.stringify(cur, null, 2) + "\n");
  }

  private atomicWrite(file: string, body: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  }

  private record(row: Omit<GateEventRow, "at">): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(
      path.join(this.dir, "events.jsonl"),
      JSON.stringify({ at: new Date(this.now()).toISOString(), ...row }) + "\n",
    );
  }

  events(): GateEventRow[] {
    try {
      return fs
        .readFileSync(path.join(this.dir, "events.jsonl"), "utf-8")
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

  private remove(id: string) {
    try {
      fs.unlinkSync(this.file(id));
    } catch {
      /* already gone */
    }
  }

  /**
   * Takes back the gone and the quiet, grants who may start, and returns
   * the queue as it now stands. Call under the lock.
   */
  private settle(): GateEntry[] {
    const s = this.settings();
    const now = this.now();
    let entries = this.readAll();
    for (const e of entries) {
      const why = takenBackWhy(e, s, now, this.alive);
      if (!why) continue;
      this.remove(e.id);
      if (e.grantedAt || why === "gone")
        this.record({
          event: why === "gone" ? "taken-back-gone" : "taken-back-quiet",
          id: e.id,
          kind: e.kind,
          who: e.who,
          label: e.label,
          ...(e.grantedAt
            ? { minutes: (now - Date.parse(e.grantedAt)) / 60_000 }
            : {}),
        });
    }
    entries = entries.filter((e) => fs.existsSync(this.file(e.id)));
    const at = new Date(now).toISOString();
    for (const id of grants(entries, s)) {
      const e = entries.find((x) => x.id === id);
      if (!e) continue;
      e.grantedAt = at;
      e.aliveAt = at;
      this.atomicWrite(this.file(id), JSON.stringify(e));
      this.record({
        event: "granted",
        id,
        kind: e.kind,
        who: e.who,
        label: e.label,
        minutes: (now - Date.parse(e.askedAt)) / 60_000,
      });
    }
    return entries;
  }

  /** The queue now (holders and waiters), after taking back and granting. */
  list(): GateEntry[] {
    return this.locked(() => this.settle());
  }

  /** Asks for a slot; returns the entry (granted at once if it may start). */
  ask(o: {
    kind: GateKind;
    who: string;
    label: string;
    pid: number;
    estimateMin: number;
    agent?: boolean;
  }): GateEntry {
    return this.locked(() => {
      const at = new Date(this.now()).toISOString();
      const e: GateEntry = {
        id: `${o.kind}-${randomBytes(5).toString("hex")}`,
        kind: o.kind,
        who: o.who.slice(0, 200),
        label: o.label.slice(0, 120),
        pid: o.pid,
        askedAt: at,
        aliveAt: at,
        estimateMin: o.estimateMin,
        ...(o.agent ? { agent: true } : {}),
      };
      fs.mkdirSync(this.slots, { recursive: true });
      fs.writeFileSync(this.file(e.id), JSON.stringify(e), { flag: "wx" });
      this.record({
        event: "asked",
        id: e.id,
        kind: e.kind,
        who: e.who,
        label: e.label,
      });
      return this.settle().find((x) => x.id === e.id) ?? e;
    });
  }

  /** The holder or waiter says it is alive; returns it, or null if gone. */
  renew(id: string): GateEntry | null {
    return this.locked(() => {
      const e = this.settle().find((x) => x.id === id);
      if (!e) return null;
      e.aliveAt = new Date(this.now()).toISOString();
      this.atomicWrite(this.file(id), JSON.stringify(e));
      return e;
    });
  }

  /** The holder is done (or the waiter gives up). */
  release(id: string): boolean {
    return this.locked(() => {
      const e = this.readAll().find((x) => x.id === id);
      if (!e) return false;
      this.remove(id);
      this.record({
        event: "released",
        id,
        kind: e.kind,
        who: e.who,
        label: e.label,
        ...(e.grantedAt
          ? { minutes: (this.now() - Date.parse(e.grantedAt)) / 60_000 }
          : {}),
      });
      this.settle();
      return true;
    });
  }

  /** A person ends someone's slot early; recorded with who. */
  endEarly(id: string, by: string): boolean {
    return this.locked(() => {
      const e = this.readAll().find((x) => x.id === id);
      if (!e) return false;
      this.remove(id);
      this.record({
        event: "ended-early",
        id,
        kind: e.kind,
        who: e.who,
        label: e.label,
        by: by.slice(0, 200),
      });
      this.settle();
      return true;
    });
  }
}
