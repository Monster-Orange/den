/**
 * Issue 774, mock v3 row 7b (Den Builder's ruling): this computer has a
 * Den tab open and push is on for it. The open tab shows the alert; the
 * push to this same device is skipped while a tab shows it.
 *
 * A device is its push subscription's endpoint (one per browser profile),
 * never an IP or a user agent. Each open tab holds an event stream
 * (GET /api/alerts/stream); the server names the tab and binds it to its
 * person. The tab says which of its person's own subscriptions it is, and
 * whether it is visible (POST /api/alerts/presence). For an alert:
 *
 *   - each endpoint with a visible tab claiming it: those tabs get the
 *     alert first, and a timer of `windowMs` starts. The first ack (POST
 *     /api/alerts/ack) clears it, and the device's other tabs drop it;
 *   - no ack in time, every such tab hidden or closed: the push goes to
 *     that one endpoint, as before;
 *   - every other endpoint: pushed at once.
 *
 * The endpoint is a capability (whoever holds it, with the keys, can push
 * to the device): it is kept only as a sha256 hash, and never logged.
 * In memory: a restart drops the tabs, which reconnect.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Alert } from "./alert-feed.js";

/** What a tab's stream carries. */
export type TabEvent =
  | { type: "tab"; tab: string }
  | { type: "alert"; alert: Alert }
  | { type: "drop"; id: string };

export interface AlertHandoffDeps {
  /** How long a visible tab has to ack before the push goes (ms). */
  windowMs: () => number;
  /** Streams one person may hold; past it, the oldest is dropped. */
  maxTabs: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Tab {
  id: string;
  person: string;
  opened: number;
  /** sha256 of the endpoint it claimed, or null. */
  device: string | null;
  visible: boolean;
  send: (e: TabEvent) => void;
  end: () => void;
}

interface Pending {
  alertId: string;
  device: string;
  endpoint: string;
  /** The tabs it went to (and that may ack it). */
  tabs: Set<string>;
  timer: unknown;
  push: (endpoints: string[]) => void;
}

/** The tab-first window's bounds (alerts.tab_first_seconds is clamped). */
export const WINDOW_MIN_MS = 1000;
export const WINDOW_MAX_MS = 10_000;

const hash = (endpoint: string): string =>
  createHash("sha256").update(endpoint).digest("hex");

export class AlertHandoff {
  private readonly tabs = new Map<string, Tab>();
  /** By `${alertId} ${device}`. */
  private readonly pending = new Map<string, Pending>();
  private opened = 0;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: AlertHandoffDeps) {
    this.setTimer =
      d.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer =
      d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /**
   * A tab opened its stream as `person`. Its id (the stream's first event,
   * sent here). Past the person's cap, their oldest tab is closed (`end`).
   */
  open(person: string, send: (e: TabEvent) => void, end: () => void): string {
    const id = randomBytes(16).toString("base64url");
    this.tabs.set(id, {
      id,
      person,
      opened: ++this.opened,
      device: null,
      visible: false,
      send,
      end,
    });
    safe(() => send({ type: "tab", tab: id }));
    let max = 20;
    try {
      max = Math.max(1, Math.floor(this.d.maxTabs()));
    } catch {
      /* the default */
    }
    const mine = [...this.tabs.values()]
      .filter((t) => t.person === person)
      .sort((a, b) => a.opened - b.opened);
    for (const t of mine.slice(0, Math.max(0, mine.length - max))) {
      this.close(t.id);
      safe(t.end);
    }
    return id;
  }

  /**
   * The tab says which device it is and whether it is visible. "forbidden":
   * not this person's tab. "not_yours": the endpoint is none of `owns`
   * (the person's own stored subscriptions), so the tab stands in for no
   * device. Going hidden hands its pending alerts to push.
   */
  presence(
    tab: string,
    person: string,
    p: { endpoint?: string | null; visible: boolean },
    owns: (endpoint: string) => boolean,
  ): "ok" | "forbidden" | "not_yours" {
    const t = this.tabs.get(tab);
    if (!t || t.person !== person) return "forbidden";
    let result: "ok" | "not_yours" = "ok";
    if (p.endpoint) {
      let mine = false;
      try {
        mine = owns(p.endpoint);
      } catch {
        mine = false;
      }
      if (mine) t.device = hash(p.endpoint);
      else {
        t.device = null;
        result = "not_yours";
      }
    } else if (p.endpoint === null) t.device = null;
    t.visible = p.visible === true;
    if (!t.visible || !t.device) this.leave(t.id);
    return result;
  }

  /** The tab's stream closed: its pending alerts go to push if no one is left. */
  close(tab: string): void {
    if (!this.tabs.has(tab)) return;
    this.leave(tab);
    this.tabs.delete(tab);
  }

  /**
   * An alert for the devices `endpoints` (the stored subscriptions push
   * would send to). `push` sends to the given endpoints only.
   */
  deliver(
    a: Alert,
    endpoints: readonly string[],
    push: (endpoints: string[]) => void,
  ): void {
    const now: string[] = [];
    for (const endpoint of endpoints) {
      const device = hash(endpoint);
      const tabs = [...this.tabs.values()].filter(
        (t) => t.visible && t.device === device,
      );
      if (!tabs.length) {
        now.push(endpoint);
        continue;
      }
      const key = `${a.id} ${device}`;
      const p: Pending = {
        alertId: a.id,
        device,
        endpoint,
        tabs: new Set(tabs.map((t) => t.id)),
        timer: null,
        push,
      };
      p.timer = this.setTimer(() => this.expire(key), this.windowMs());
      this.pending.set(key, p);
      for (const t of tabs) safe(() => t.send({ type: "alert", alert: a }));
    }
    if (now.length) safe(() => push(now));
  }

  /**
   * The tab showed alert `id`. "forbidden": not this person's tab;
   * "not_pending": nothing of `id` waits on this tab. The device's other
   * tabs are told to drop it.
   */
  ack(
    tab: string,
    person: string,
    id: string,
  ): "ok" | "forbidden" | "not_pending" {
    const t = this.tabs.get(tab);
    if (!t || t.person !== person) return "forbidden";
    const key = t.device ? `${id} ${t.device}` : "";
    const p = key ? this.pending.get(key) : undefined;
    if (!p || !p.tabs.has(tab)) return "not_pending";
    this.clearTimer(p.timer);
    this.pending.delete(key);
    for (const other of p.tabs) {
      if (other === tab) continue;
      const o = this.tabs.get(other);
      if (o) safe(() => o.send({ type: "drop", id }));
    }
    return "ok";
  }

  pendingCount(): number {
    return this.pending.size;
  }

  tabCount(): number {
    return this.tabs.size;
  }

  /** For tests: what is held (hashes only). */
  debugState(): unknown {
    return {
      tabs: [...this.tabs.values()].map((t) => ({
        person: t.person,
        device: t.device,
        visible: t.visible,
      })),
      pending: [...this.pending.values()].map((p) => ({
        alertId: p.alertId,
        device: p.device,
        tabs: [...p.tabs].length,
      })),
    };
  }

  /** The window, clamped to 1–10 s (a Setting can't make push "never"). */
  private windowMs(): number {
    let ms = 3000;
    try {
      ms = this.d.windowMs();
    } catch {
      /* the default */
    }
    if (!Number.isFinite(ms)) ms = 3000;
    return Math.min(WINDOW_MAX_MS, Math.max(WINDOW_MIN_MS, ms));
  }

  /** `tab` no longer answers: where it was the last one, push now. */
  private leave(tab: string): void {
    for (const [key, p] of [...this.pending]) {
      if (!p.tabs.delete(tab)) continue;
      const left = [...p.tabs].some((id) => {
        const t = this.tabs.get(id);
        return !!t && t.visible && t.device === p.device;
      });
      if (!left) this.expire(key);
    }
  }

  private expire(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.clearTimer(p.timer);
    this.pending.delete(key);
    safe(() => p.push([p.endpoint]));
  }
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* a gone stream or a failed push: best effort */
  }
}
