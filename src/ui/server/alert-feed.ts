/**
 * Issue 172: the server's one place an alert is decided (alerts.ts says
 * what one says). A new need comes in (Attention's wait, a held write);
 * the person's switches and quiet hours decide; then it goes two ways:
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
  agentLink,
  alertBody,
  type AlertPrefs,
  type AlertWhy,
  inQuietHours,
} from "./alerts.js";
import type { UiLanguage } from "./ui-language.js";

export interface Alert {
  seq: number;
  id: string;
  at: string;
  why: AlertWhy;
  agent: string;
  /** The product's title (the notification's heading). */
  title: string;
  /** The bell's words: who, and what it waits on. Nothing else. */
  body: string;
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
   * Agent `agent` in `workspace` began to need its person. The alert, or
   * null when the person's quiet hours hold it back.
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
    };
    this.items.push(a);
    if (this.items.length > ALERT_FEED_MAX)
      this.items.splice(0, this.items.length - ALERT_FEED_MAX);
    if (prefs.phone && this.d.push)
      void this.d.push(a, prefs).catch(() => undefined);
    return a;
  }

  /**
   * What a tab reads: the alerts after `after` (none on its first read,
   * `after` null: it starts from now), and the number to ask after next.
   * Desktop off: none, and the count still moves.
   */
  after(after: number | null): { seq: number; alerts: Alert[] } {
    let desktop = true;
    try {
      desktop = this.d.prefs().desktop;
    } catch {
      desktop = true;
    }
    // A count from before a restart (higher than ours): start from now.
    if (after === null || after > this.seq || !desktop)
      return { seq: this.seq, alerts: [] };
    return {
      seq: this.seq,
      alerts: this.items.filter((a) => a.seq > after),
    };
  }
}
