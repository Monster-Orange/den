/**
 * NT-3 / NT-6: this Den's notifications, one model for Den and Hub items:
 * `{ id, source, kind, subject, scope, text, link, at, read }`, kept in
 * `<state>/notifications.json` (0600), the newest 500.
 *
 * - kind: waiting | finished | answer | mention | decision | service.
 * - subject: `agent:<id>`, `thread:<id>` or `record:<id>`.
 * - scope: `workspace/<ws>` (Den's own, grouped by project then agent) or
 *   `hub/<project>` (Hub's).
 * One unread item per subject and kind: a second "waiting" from the same
 * agent updates it (text, time) rather than stacking. Mutes are per
 * agent or project, until a time. Never throws on a broken file: it
 * starts empty.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type NotificationKind =
  | "waiting"
  | "finished"
  | "answer"
  | "mention"
  | "decision"
  | "service";

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  "waiting",
  "finished",
  "answer",
  "mention",
  "decision",
  "service",
];

export interface Notification {
  id: string;
  source: "den" | "hub";
  kind: NotificationKind;
  subject: string;
  scope: string;
  text: string;
  link?: string;
  /** ISO 8601. */
  at: string;
  read: boolean;
}

export interface Mute {
  /** `agent:<id>` or `workspace/<ws>` or `hub/<project>`. */
  target: string;
  /** ISO 8601. */
  until: string;
}

interface StoreFile {
  items: Notification[];
  mutes: Mute[];
}

export const NOTIFICATIONS_FILE = "notifications.json";
export const MAX_NOTIFICATIONS = 500;
const MAX_TEXT = 300;

/** What a mark-read or clear applies to. */
export type Which =
  | { all: true }
  | { id: string }
  | { subject: string }
  | { scope: string };

function matches(n: Notification, w: Which): boolean {
  if ("all" in w) return true;
  if ("id" in w) return n.id === w.id;
  if ("subject" in w) return n.subject === w.subject;
  return n.scope === w.scope;
}

/** One line, plain, bounded: what a notification says. */
const plain = (v: string) =>
  v
    // Control characters out (terminal escapes included). Intentional.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);

export class NotificationStore {
  private readonly file: string;

  constructor(
    stateDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(stateDir, NOTIFICATIONS_FILE);
  }

  private read(): StoreFile {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf-8")) as {
        items?: unknown;
        mutes?: unknown;
      };
      const items = Array.isArray(v.items)
        ? (v.items as Notification[]).filter(
            (n) =>
              n &&
              typeof n.id === "string" &&
              typeof n.subject === "string" &&
              NOTIFICATION_KINDS.includes(n.kind),
          )
        : [];
      const mutes = Array.isArray(v.mutes)
        ? (v.mutes as Mute[]).filter(
            (m) =>
              m && typeof m.target === "string" && typeof m.until === "string",
          )
        : [];
      return { items, mutes };
    } catch {
      return { items: [], mutes: [] };
    }
  }

  private write(f: StoreFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(f)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Newest first. */
  list(): Notification[] {
    return [...this.read().items].sort((a, b) => b.at.localeCompare(a.at));
  }

  unread(): number {
    return this.read().items.filter((n) => !n.read).length;
  }

  /** Whether `subject` (or its scope) is muted now. */
  muted(subject: string, scope: string): boolean {
    const t = this.now().toISOString();
    return this.read().mutes.some(
      (m) => (m.target === subject || m.target === scope) && m.until > t,
    );
  }

  /**
   * Add one, or update the unread one with the same subject and kind.
   * Null when muted (nothing kept).
   */
  add(n: {
    source?: "den" | "hub";
    kind: NotificationKind;
    subject: string;
    scope: string;
    text: string;
    link?: string;
  }): Notification | null {
    if (this.muted(n.subject, n.scope)) return null;
    const f = this.read();
    const at = this.now().toISOString();
    const text = plain(n.text);
    const same = f.items.find(
      (x) => !x.read && x.subject === n.subject && x.kind === n.kind,
    );
    let out: Notification;
    if (same) {
      same.text = text;
      same.at = at;
      if (n.link) same.link = n.link;
      out = same;
    } else {
      out = {
        id: crypto.randomUUID(),
        source: n.source ?? "den",
        kind: n.kind,
        subject: n.subject,
        scope: n.scope,
        text,
        ...(n.link ? { link: n.link } : {}),
        at,
        read: false,
      };
      f.items.push(out);
    }
    f.items.sort((a, b) => a.at.localeCompare(b.at));
    if (f.items.length > MAX_NOTIFICATIONS)
      f.items = f.items.slice(-MAX_NOTIFICATIONS);
    this.write(f);
    return { ...out };
  }

  /** The agent is busy again, or was answered: its waiting item goes. */
  withdraw(subject: string, kind: NotificationKind = "waiting"): boolean {
    const f = this.read();
    const before = f.items.length;
    f.items = f.items.filter(
      (x) => !(x.subject === subject && x.kind === kind && !x.read),
    );
    if (f.items.length === before) return false;
    this.write(f);
    return true;
  }

  /** Mark read; how many changed. */
  markRead(w: Which): number {
    const f = this.read();
    let n = 0;
    for (const x of f.items)
      if (!x.read && matches(x, w)) {
        x.read = true;
        n++;
      }
    if (n) this.write(f);
    return n;
  }

  /** Remove the read ones (of `w`, default all); how many went. */
  clearRead(w: Which = { all: true }): number {
    const f = this.read();
    const before = f.items.length;
    f.items = f.items.filter((x) => !(x.read && matches(x, w)));
    const n = before - f.items.length;
    if (n) this.write(f);
    return n;
  }

  /** Mute an agent (`agent:<id>`) or a project (`workspace/<ws>`) for `minutes`. */
  mute(target: string, minutes: number): Mute {
    const f = this.read();
    const until = new Date(
      this.now().getTime() + Math.max(1, minutes) * 60_000,
    ).toISOString();
    const t = this.now().toISOString();
    f.mutes = f.mutes.filter((m) => m.target !== target && m.until > t);
    const m = { target, until };
    f.mutes.push(m);
    this.write(f);
    return m;
  }

  unmute(target: string): void {
    const f = this.read();
    f.mutes = f.mutes.filter((m) => m.target !== target);
    this.write(f);
  }

  mutes(): Mute[] {
    const t = this.now().toISOString();
    return this.read().mutes.filter((m) => m.until > t);
  }
}

/**
 * NT-3: the bell's groups: by scope (project, or Hub project), then by
 * subject (agent), newest first; waiting before the rest within a scope.
 */
export function groupNotifications(
  items: Notification[],
): { scope: string; subjects: { subject: string; items: Notification[] }[] }[] {
  const by = new Map<string, Map<string, Notification[]>>();
  for (const n of [...items].sort((a, b) => b.at.localeCompare(a.at))) {
    const s = by.get(n.scope) ?? new Map<string, Notification[]>();
    const l = s.get(n.subject) ?? [];
    l.push(n);
    s.set(n.subject, l);
    by.set(n.scope, s);
  }
  const waiting = (l: Notification[]) =>
    l.some((n) => n.kind === "waiting" && !n.read) ? 0 : 1;
  return [...by.entries()].map(([scope, s]) => ({
    scope,
    subjects: [...s.entries()]
      .map(([subject, l]) => ({ subject, items: l }))
      .sort(
        (a, b) =>
          waiting(a.items) - waiting(b.items) ||
          b.items[0].at.localeCompare(a.items[0].at),
      ),
  }));
}

/**
 * notifications.* (the org's den.yml, then user.yml):
 *   asks_per_hour (default 30, at least 1): how many ask_human questions
 *   one agent may put in the bell in an hour; the next is held back.
 * A bad value throws naming its key.
 */
export interface NotificationConfig {
  asksPerHour: number;
}

export function readNotificationConfig(
  den: unknown,
  user: unknown,
): NotificationConfig {
  const pick = (c: unknown) =>
    ((c as { notifications?: { asks_per_hour?: unknown } } | null)
      ?.notifications ?? {}) as { asks_per_hour?: unknown };
  const v = pick(user).asks_per_hour ?? pick(den).asks_per_hour;
  if (v === undefined || v === null) return { asksPerHour: 30 };
  if (typeof v === "number" && Number.isInteger(v) && v >= 1)
    return { asksPerHour: v };
  throw new Error(
    "notifications.asks_per_hour must be a whole number, at least 1",
  );
}

/** ask_human's limit: per agent, the questions of the last hour. */
export class AskLimit {
  private readonly asked = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  /** True, and counted, when this agent may ask now. */
  take(agent: string, perHour: number): boolean {
    const t = this.now();
    const recent = (this.asked.get(agent) ?? []).filter(
      (at) => t - at < 3_600_000,
    );
    if (recent.length >= perHour) {
      this.asked.set(agent, recent);
      return false;
    }
    recent.push(t);
    this.asked.set(agent, recent);
    return true;
  }
}
