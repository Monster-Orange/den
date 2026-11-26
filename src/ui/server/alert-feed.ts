/**
 * Issue 172: the server's one place an alert is decided (alerts.ts says
 * what one says). A new need comes in (Attention's wait, a held write);
 * the person's switches, mutes and quiet hours decide; then it goes two ways:
 *
 *   - the feed: the last 50 alerts, numbered, that an open Den tab reads
 *     with GET /api/alerts?after=<seq> and shows as a browser
 *     notification (public/alerts.js);
 *   - push: each subscribed device (a phone, a closed tab), by Web Push
 *     (web-push.ts), when the person has it on.
 *
 * In memory: a restart starts a new count (a tab's next read starts
 * fresh). Never throws to its callers: an alert is best effort, the bell
 * still has the need.
 */
import { randomUUID } from "node:crypto";
import {
  ALERT_KINDS,
  agentLink,
  alertBody,
  type AlertPrefs,
  type AlertWhy,
  inQuietHours,
} from "./alerts.js";
import type { UiLanguage } from "../../shared/ui-language.js";

export interface Alert {
  seq: number;
  id: string;
  at: string;
  why: AlertWhy;
  agent: string;
  /** The product's title (the notification's heading). */
  title: string;
  body: string;
  project: string;
  /** The agent's page. */
  link: string;
}

export interface AlertFeedDeps {
  prefs: () => AlertPrefs;
  lang: () => UiLanguage;
  zone?: () => string | null;
  title: () => string;
  nameOf: (agent: string) => string;
  now?: () => number;
  muted?: (agent: string, workspace: string) => boolean;
  /** Web Push to the person's devices (S2); absent, none. */
  push?: (a: Alert, prefs: AlertPrefs) => Promise<unknown>;
}

/** How many alerts the feed keeps for tabs to read. */
export const ALERT_FEED_MAX = 50;

export class AlertFeed {
  private readonly items: Alert[] = [];
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly d: AlertFeedDeps) {
    this.now = d.now ?? Date.now;
  }

  /**
   * Agent `agent` in `workspace` began to need its person or finished a
   * turn. The alert, or null when quiet hours, a mute or a switch hold it.
   */
  needs(n: { agent: string; workspace: string; why: AlertWhy }): Alert | null {
    let prefs: AlertPrefs;
    try {
      prefs = this.d.prefs();
    } catch {
      return null;
    }
    const at = new Date(this.now());
    let zone: string | null = null;
    try {
      zone = this.d.zone?.() ?? null;
    } catch {
      zone = null;
    }
    if (inQuietHours(prefs, at, zone)) return null;
    if (ALERT_KINDS[n.why]?.alert === "opt-in" && !prefs.finished) return null;
    try {
      if (this.d.muted?.(n.agent, n.workspace)) return null;
    } catch {
      /* can't tell: it alerts */
    }
    let lang: UiLanguage = "en";
    let name = n.agent;
    let title = "";
    try {
      lang = this.d.lang();
      name = this.d.nameOf(n.agent) || n.agent;
      title = this.d.title();
    } catch {
      /* the defaults */
    }
    const a: Alert = {
      seq: ++this.seq,
      id: randomUUID(),
      at: at.toISOString(),
      why: n.why,
      agent: n.agent,
      title,
      body: alertBody(lang, n.why, name),
      link: agentLink(n.workspace, n.agent),
      project: n.workspace,
    };
    this.items.push(a);
    if (this.items.length > ALERT_FEED_MAX)
      this.items.splice(0, this.items.length - ALERT_FEED_MAX);
    if (prefs.phone && this.d.push)
      void this.d.push(a, prefs).catch(() => undefined);
    return a;
  }

  latest(): number {
    return this.seq;
  }

  /**
   * What a tab reads: the alerts after `after` (none on its first read,
   * `after` null: it starts from now), the number to ask after next, and
   * the person's switches the tab acts on.
   */
  after(after: number | null): {
    seq: number;
    alerts: Alert[];
    prefs: { desktop: boolean; sound: boolean; tab_count: boolean };
  } {
    let p = { desktop: true, sound: false, tab_count: true };
    try {
      const x = this.d.prefs();
      p = { desktop: x.desktop, sound: x.sound, tab_count: x.tabCount };
    } catch {
      /* the defaults */
    }
    // A count from before a restart (higher than ours): start from now.
    if (after === null || after > this.seq || (!p.desktop && !p.sound))
      return { seq: this.seq, alerts: [], prefs: p };
    return {
      seq: this.seq,
      alerts: this.items.filter((a) => a.seq > after),
      prefs: p,
    };
  }
}
