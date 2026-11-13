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
  /** NT-6, a Hub item: whether Hub has it read (what the last sync saw). */
  hubRead?: boolean;
  /** NT-6, a Hub item: its project's name, for the bell's heading. */
  scopeName?: string;
  /**
   * Den's own text as a key and its values, for the page to say in its
   * language (`text` is the English, for the CLI and old pages).
   */
  msg?: NoteMsg;
}

/** A page string key (bell.m.*) and its values. */
export interface NoteMsg {
  key: string;
  vars: Record<string, string | number>;
}

const MSG_KEY = /^bell\.m\.[A-Za-z]{1,24}$/;

/** `msg` checked and made plain, or undefined. */
function cleanMsg(m: NoteMsg | undefined): NoteMsg | undefined {
  if (!m || !MSG_KEY.test(m.key)) return undefined;
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(m.vars ?? {}).slice(0, 8))
    if (/^[a-z]{1,16}$/i.test(k))
      vars[k] =
        typeof v === "number" && Number.isFinite(v) ? v : plain(String(v));
  return { key: m.key, vars };
}

/** NT-6: one of Hub's notifications (GET /api/notifications), checked. */
export interface HubNote {
  id: string;
  kind: NotificationKind;
  subject: string;
  scope: string;
  text: string;
  link?: string;
  at: string;
  readBy: string[];
  /** Its project's name (Hub, when it sends one). */
  scopeName?: string;
}

/** Hub's item, or null when it isn't one Den can show. */
export function parseHubNote(v: unknown): HubNote | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const str = (x: unknown, max: number) =>
    typeof x === "string" ? x.slice(0, max) : "";
  const id = str(r.id, 128);
  const kind = r.kind as NotificationKind;
  const subject = str(r.subject, 200);
  if (!id || !NOTIFICATION_KINDS.includes(kind)) return null;
  if (!/^(thread|record|agent):/.test(subject)) return null;
  const at = str(r.at, 64);
  if (!at || Number.isNaN(Date.parse(at))) return null;
  const link = str(r.link, 2048);
  return {
    id,
    kind,
    subject,
    scope: str(r.scope, 128).replace(/[^\w.:/-]/g, ""),
    ...(str(r.scopeName, 120).trim()
      ? { scopeName: plain(str(r.scopeName, 120)) }
      : {}),
    text: str(r.text, 1000),
    // Hub's own page, https only (never a script or a file link).
    ...(/^https:\/\//.test(link) ? { link } : {}),
    at: new Date(at).toISOString(),
    readBy: Array.isArray(r.readBy)
      ? r.readBy.filter((x): x is string => typeof x === "string")
      : [],
  };
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
    msg?: NoteMsg;
    link?: string;
  }): Notification | null {
    if (this.muted(n.subject, n.scope)) return null;
    const f = this.read();
    const at = this.now().toISOString();
    const text = plain(n.text);
    const msg = cleanMsg(n.msg);
    const same = f.items.find(
      (x) => !x.read && x.subject === n.subject && x.kind === n.kind,
    );
    let out: Notification;
    if (same) {
      same.text = text;
      if (msg) same.msg = msg;
      else delete same.msg;
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
        ...(msg ? { msg } : {}),
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

  /**
   * NT-6: Hub's list (computed by Hub, the latest 50) against Den's Hub
   * items. New ones are added (unless muted); Hub's read marks Den's read;
   * one read in Den but not on Hub is returned, for Den to mark on Hub;
   * one Hub no longer lists goes. Den's own items are left alone.
   */
  syncHub(notes: readonly HubNote[], owner: string | null): string[] {
    const f = this.read();
    const me = owner?.toLowerCase() ?? null;
    const byId = new Map(
      f.items.filter((x) => x.source === "hub").map((x) => [x.id, x]),
    );
    const listed = new Set<string>();
    const push: string[] = [];
    let changed = false;
    for (const n of notes) {
      const id = `hub:${n.id}`;
      listed.add(id);
      const hubRead = !!me && n.readBy.some((l) => l.toLowerCase() === me);
      // Hub's own scope: "hub/<project>/<space>".
      const scope = n.scope.startsWith("hub/")
        ? n.scope
        : `hub/${n.scope}`.replace(/\/$/, "");
      const x = byId.get(id);
      if (!x) {
        if (this.muted(n.subject, scope)) continue;
        f.items.push({
          id,
          source: "hub",
          kind: n.kind,
          subject: n.subject,
          scope,
          ...(n.scopeName ? { scopeName: n.scopeName } : {}),
          text: plain(n.text),
          ...(n.link ? { link: n.link } : {}),
          at: n.at,
          read: hubRead,
          hubRead,
        });
        changed = true;
        continue;
      }
      const text = plain(n.text);
      // Newer activity on Hub's item (another reply): it's news again.
      const newer = n.at > x.at;
      if (
        x.text !== text ||
        x.at !== n.at ||
        x.link !== n.link ||
        x.scope !== scope ||
        x.scopeName !== n.scopeName
      ) {
        x.text = text;
        x.at = n.at;
        if (n.link) x.link = n.link;
        else delete x.link;
        // Hub filed it under its own project (Hub before that: the team's).
        x.scope = scope;
        if (n.scopeName) x.scopeName = n.scopeName;
        else delete x.scopeName;
        changed = true;
      }
      // Whose read is it? Unknown: reads stay where they were made.
      if (!me) continue;
      if (hubRead) {
        if (!x.read || !x.hubRead) changed = true;
        x.read = true;
        x.hubRead = true;
      } else if (newer && x.read) {
        x.read = false;
        x.hubRead = false;
        changed = true;
      } else if (x.read && !x.hubRead) {
        // Read here, not yet there.
        push.push(n.id);
      }
      // Read here and told to Hub: it stays read, even while Hub's list
      // still lags behind.
    }
    const before = f.items.length;
    f.items = f.items.filter((x) => x.source !== "hub" || listed.has(x.id));
    if (f.items.length !== before) changed = true;
    if (changed) {
      f.items.sort((a, b) => a.at.localeCompare(b.at));
      if (f.items.length > MAX_NOTIFICATIONS)
        f.items = f.items.slice(-MAX_NOTIFICATIONS);
      this.write(f);
    }
    return push;
  }

  /** NT-6: Hub took Den's read for these (Hub's ids). */
  hubMarked(ids: readonly string[]): void {
    if (!ids.length) return;
    const want = new Set(ids.map((i) => `hub:${i}`));
    const f = this.read();
    let n = 0;
    for (const x of f.items)
      if (want.has(x.id) && !x.hubRead) {
        x.hubRead = true;
        n++;
      }
    if (n) this.write(f);
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
  /** NT-6: how often Den reads Hub's notifications (seconds; 0: never). */
  hubPollSeconds: number;
}

export function readNotificationConfig(
  den: unknown,
  user: unknown,
): NotificationConfig {
  type N = { asks_per_hour?: unknown; hub_poll_seconds?: unknown };
  const pick = (c: unknown) =>
    ((c as { notifications?: N } | null)?.notifications ?? {}) as N;
  const ask = pick(user).asks_per_hour ?? pick(den).asks_per_hour;
  const poll = pick(user).hub_poll_seconds ?? pick(den).hub_poll_seconds;
  let asksPerHour = 30;
  if (ask !== undefined && ask !== null) {
    if (!(typeof ask === "number" && Number.isInteger(ask) && ask >= 1))
      throw new Error(
        "notifications.asks_per_hour must be a whole number, at least 1",
      );
    asksPerHour = ask;
  }
  let hubPollSeconds = 60;
  if (poll !== undefined && poll !== null) {
    if (
      !(
        typeof poll === "number" &&
        Number.isInteger(poll) &&
        (poll === 0 || (poll >= 10 && poll <= 3600))
      )
    )
      throw new Error(
        "notifications.hub_poll_seconds must be 0 (never) or a whole number from 10 to 3600",
      );
    hubPollSeconds = poll;
  }
  return { asksPerHour, hubPollSeconds };
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
