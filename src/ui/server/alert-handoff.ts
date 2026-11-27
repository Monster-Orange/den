import { createHash, randomBytes } from "node:crypto";
import type { Alert } from "./alert-feed.js";

export type TabEvent =
  | { type: "tab"; tab: string }
  | { type: "alert"; alert: Alert }
  | { type: "drop"; id: string };

export interface AlertHandoffDeps {
  windowMs: () => number;
  maxTabs: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Tab {
  id: string;
  person: string;
  opened: number;
  device: string | null;
  visible: boolean;
  send: (e: TabEvent) => void;
  end: () => void;
}

interface Pending {
  alertId: string;
  device: string;
  endpoint: string;
  tabs: Set<string>;
  timer: unknown;
  push: (endpoints: string[]) => void;
}

export const WINDOW_MIN_MS = 1000;
export const WINDOW_MAX_MS = 10_000;

const hash = (endpoint: string): string =>
  createHash("sha256").update(endpoint).digest("hex");

export class AlertHandoff {
  private readonly tabs = new Map<string, Tab>();
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

  close(tab: string): void {
    if (!this.tabs.has(tab)) return;
    this.leave(tab);
    this.tabs.delete(tab);
  }

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
