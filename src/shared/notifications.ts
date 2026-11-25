/**
 * NT-3 / NT-6: this Den's notifications, one model for Den and Hub items:
 * `{ id, source, kind, subject, scope, text, link, at, read }`, kept in
 * `<state>/notifications.json` (0600), the newest 500.
 *
 * - kind: waiting | finished | answer | mention | decision | service;
 *   each belongs to one of the person's seven switches (switchOf).
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
import { writeFileAtomic } from "./atomic-write.js";

export type NotificationKind =
  | "waiting"
  | "finished"
  | "answer"
  | "mention"
  | "decision"
  | "service"
  // Issue 581: Hub's "<someone> shared <a doc> with you".
  | "shared";

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  "waiting",
  "finished",
  "answer",
  "mention",
  "decision",
  "service",
  "shared",
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
  /**
   * Issue 1008: a question withdrawn once it was settled elsewhere: why,
   * who withdrew it (`agent:<id>`, the agent that asked, or `person`) and
   * when; `late` once an answer came after it. A settled row is read and
   * no longer needs the person: the bell lists it with the updates.
   */
  settled?: Settled;
  /**
   * Issue 1371 Part 2: a setting an agent changed without asking: the held
   * write to undo (POST /api/settings/undo, the person's only).
   */
  undo?: { approval: string };
}

/** Issue 1008: how a withdrawn question was settled. */
export interface Settled {
  reason: string;
  by: string;
  /** ISO 8601. */
  at: string;
  late?: true;
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
  /** Issue 581: Den's own words for it (a shared item: Hub sends no text). */
  msg?: NoteMsg;
}

/** Issue 581: a field of a shared item's data, cut and plain. */
const field = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v
        .slice(0, max)
        // Control characters out (terminal escapes included). Intentional.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

/**
 * Issue 581: a "shared" item's bounded data, worded by Den in the page's
 * language; null when its slug or its sharer is missing.
 */
function sharedWords(
  data: unknown,
): { msg: NoteMsg; text: string; slug: string } | null {
  const d = (data && typeof data === "object" ? data : {}) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const slug = field(d.artifact?.slug, 128);
  const actor = field(d.actor?.login, 64);
  if (!slug || !actor) return null;
  const title = field(d.artifact?.title, 200) || slug;
  const note = field((d as Record<string, unknown>).note, 1000);
  const agent = d.actor?.kind === "agent";
  const key = `bell.m.shared${agent ? "Agent" : ""}${note ? "Note" : ""}`;
  const said = `${agent ? "The agent " : ""}${actor} shared ${title} with you`;
  return {
    msg: { key, vars: { actor, title, ...(note ? { note } : {}) } },
    text: note ? `${said}: ${note}` : said,
    slug,
  };
}

/** Issue 581: a link only when https on the connected Hub's origin. */
function onHub(link: string, hub: string | undefined): string | undefined {
  let origin = "";
  try {
    origin = hub ? new URL(hub).origin : "";
  } catch {
    origin = "";
  }
  if (!/^https:\/\//.test(origin)) return undefined;
  try {
    const u = new URL(link);
    if (u.protocol === "https:" && u.origin === origin) return link;
  } catch {
    /* not a URL: Hub's home */
  }
  return `${origin}/`;
}

/** Hub's item, or null when it isn't one Den can show. */
export function parseHubNote(v: unknown, hubUrl?: string): HubNote | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const str = (x: unknown, max: number) =>
    typeof x === "string" ? x.slice(0, max) : "";
  const id = str(r.id, 128);
  const kind = r.kind as NotificationKind;
  const subject = str(r.subject, 200);
  if (!id || !NOTIFICATION_KINDS.includes(kind)) return null;
  const at = str(r.at, 64);
  if (!at || Number.isNaN(Date.parse(at))) return null;
  const link = str(r.link, 2048);
  if (kind === "shared") {
    const w = sharedWords(r.data);
    if (!w) return null;
    const home = onHub(link, hubUrl);
    return {
      id,
      kind,
      subject: /^(thread|record):/.test(subject)
        ? subject
        : `record:artifact/${w.slug}`,
      scope: str(r.scope, 128).replace(/[^\w.:/-]/g, ""),
      ...(str(r.scopeName, 120).trim()
        ? { scopeName: plain(str(r.scopeName, 120)) }
        : {}),
      text: w.text,
      msg: w.msg,
      ...(home ? { link: home } : {}),
      at: new Date(at).toISOString(),
      readBy: Array.isArray(r.readBy)
        ? r.readBy.filter((x): x is string => typeof x === "string")
        : [],
    };
  }
  if (!/^(thread|record|agent):/.test(subject)) return null;
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

/** The file as it is on disk (empty when missing or unreadable). */
function readStore(file: string): StoreFile {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8")) as {
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

function writeStore(file: string, f: StoreFile): void {
  writeFileAtomic(file, `${JSON.stringify(f)}\n`, { mode: 0o600 });
}

/**
 * Issue 1348: one change to the file. It is applied to the file as read
 * under the lock, and may be applied again (to a later read), so whatever
 * varies (an id, the time) is fixed before it is made. True: it changed.
 */
type StoreOp = (f: StoreFile) => boolean;

/**
 * Issue 1348: the lock's times, user.yml `notifications:`, in seconds.
 * A write takes ms, so a lock with no pid (its holder died between taking
 * it and saying who it is) is left after lock_no_pid_seconds; a live
 * holder's only after lock_live_seconds (a process stalled in a swap storm
 * still holds it); a gone holder's at once. lock_exit_wait_seconds: at
 * exit only, how long waiting changes wait for the lock.
 */
export const NOTIFICATION_LOCK_DEFAULTS = {
  lock_exit_wait_seconds: 2,
  lock_no_pid_seconds: 10,
  lock_live_seconds: 60,
} as const;
export const NOTIFICATION_LOCK_RANGES = {
  lock_exit_wait_seconds: { min: 0, max: 60 },
  lock_no_pid_seconds: { min: 1, max: 3600 },
  lock_live_seconds: { min: 1, max: 86_400 },
} as const;
type LockKey = keyof typeof NOTIFICATION_LOCK_DEFAULTS;

/**
 * Issue 1348: the lock's times from a `notifications:` block, in ms. A
 * value that isn't a number in its range keeps its default, and `errors`
 * says which (doctor and the config check can show them).
 */
export function notificationLockSettings(block: unknown): {
  exitWaitMs: number;
  noPidMs: number;
  liveMs: number;
  errors: string[];
} {
  const b = (block && typeof block === "object" ? block : {}) as Record<
    string,
    unknown
  >;
  const errors: string[] = [];
  const sec = (k: LockKey): number => {
    const v = b[k];
    const r = NOTIFICATION_LOCK_RANGES[k];
    if (v === undefined || v === null) return NOTIFICATION_LOCK_DEFAULTS[k];
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < r.min ||
      v > r.max
    ) {
      errors.push(
        `notifications.${k} must be a number of seconds from ${r.min} to ${r.max}, got ${JSON.stringify(v)}; using ${NOTIFICATION_LOCK_DEFAULTS[k]}`,
      );
      return NOTIFICATION_LOCK_DEFAULTS[k];
    }
    return v;
  };
  return {
    exitWaitMs: sec("lock_exit_wait_seconds") * 1000,
    noPidMs: sec("lock_no_pid_seconds") * 1000,
    liveMs: sec("lock_live_seconds") * 1000,
    errors,
  };
}

/**
 * Issue 1348: where this process reads its `notifications:` block. The
 * server and the CLI set it when they start (useNotificationConfig);
 * any other process keeps the defaults. The store doesn't read the config
 * itself: that would make every writer need a distribution root.
 */
let readLockBlock: () => unknown = () => undefined;
let lockTimes: ReturnType<typeof notificationLockSettings> | undefined;

/** Issue 1348: how this process reads user.yml `notifications:`. */
export function useNotificationConfig(read: () => unknown): void {
  readLockBlock = read;
  lockTimes = undefined;
}

/** Issue 1348: this process's lock times, read once. */
function lockSettings(): ReturnType<typeof notificationLockSettings> {
  if (lockTimes) return lockTimes;
  let block: unknown;
  try {
    block = readLockBlock();
  } catch {
    block = undefined; // unreadable: the defaults
  }
  lockTimes = notificationLockSettings(block);
  // Said once, in the log: a bad value keeps its default.
  for (const e of lockTimes.errors) console.error(e);
  return lockTimes;
}
/** Issue 1348: how often a change waiting for the lock tries again. */
const STORE_LOCK_STEP_MS = 5;

function aliveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Issue 1348: the store's cross-process lock, `<file>.lock`, tried once,
 * never waited for. A leftover lock (see lock_live_seconds) is taken back:
 * renamed aside first, and only if it is still the lock looked at (same
 * inode, time and nonce), so two takers that both found it stale never both
 * win. Exported for its tests.
 */
export function tryStoreLock(file: string): boolean {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (!takeBackStoreLock(lock)) return false;
    try {
      fs.mkdirSync(lock);
    } catch {
      return false;
    }
  }
  try {
    // The plain pid: an older Den reads this file as Number(text.trim()).
    writeFileAtomic(path.join(lock, "pid"), String(process.pid));
  } catch {
    /* the lock holds without it; only its takeback needs it */
  }
  try {
    // Issue 1598: a nonce for this take, in its own file, so a lock taken
    // over and made again in one clock tick (the same inode and time) is
    // told apart.
    writeFileAtomic(path.join(lock, "nonce"), crypto.randomUUID());
  } catch {
    /* as above */
  }
  return true;
}

/** A file in a lock folder, or null when it has none (yet). */
function lockFile(lock: string, name: "pid" | "nonce"): string | null {
  try {
    return fs.readFileSync(path.join(lock, name), "utf-8");
  } catch {
    return null; // taken just now, or its holder died before saying who
  }
}

/** Issue 1598: what tells one take of a lock from another: pid and nonce. */
function lockText(lock: string): string {
  return JSON.stringify([lockFile(lock, "pid"), lockFile(lock, "nonce")]);
}

/**
 * Issue 1348: moves a leftover lock out of the way; false: it isn't one.
 * Exported for its tests, whose `afterSeen` runs between the look and the
 * move (another taker's turn).
 */
export function takeBackStoreLock(
  lock: string,
  test?: { afterSeen?: () => void },
): boolean {
  let seen: fs.Stats;
  try {
    seen = fs.statSync(lock);
  } catch {
    return true; // gone meanwhile: free
  }
  const seenText = lockText(lock);
  const pid = Number((JSON.parse(seenText)[0] ?? "").trim() || NaN);
  const age = Date.now() - seen.mtimeMs;
  const known = Number.isInteger(pid) && pid > 0;
  const t = lockSettings();
  const left = known ? !aliveProcess(pid) || age >= t.liveMs : age >= t.noPidMs;
  if (!left) return false;
  test?.afterSeen?.();
  const aside = `${lock}.old-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return false; // another taker moved it first
  }
  try {
    const moved = fs.statSync(aside);
    // Issue 1598: its text too: one taken over and made again in one tick
    // can keep the inode and time, never the nonce.
    if (
      moved.ino !== seen.ino ||
      moved.mtimeMs !== seen.mtimeMs ||
      lockText(aside) !== seenText
    ) {
      // Not the one looked at: a lock taken since. Put it back.
      try {
        fs.renameSync(aside, lock);
      } catch {
        /* a newer lock is there: this one's holder ended up beside it */
      }
      return false;
    }
  } catch {
    return false;
  }
  fs.rmSync(aside, { recursive: true, force: true });
  return true;
}

function unlockStore(file: string): void {
  fs.rmSync(`${file}.lock`, { recursive: true, force: true });
}

/**
 * Issue 1348: changes made while another process held the lock, by file,
 * in order. This process's reads see them at once; a timer saves them
 * once the lock is free (the server's thread never waits for it).
 */
const PENDING = new Map<
  string,
  { ops: StoreOp[]; timer?: NodeJS.Timeout; waiters: (() => void)[] }
>();

/**
 * Issue 1348: the process is ending (a normal exit, and the server's
 * SIGTERM and restart, which end in process.exit): its waiting changes are
 * saved now. The thread serves nothing any more, so this one waits for the
 * lock, at most lock_exit_wait_seconds (a gone or stale holder's lock is taken
 * back sooner).
 */
function savePendingAtExit(): void {
  const until = Date.now() + lockSettings().exitWaitMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (const file of [...PENDING.keys()]) {
    const p = PENDING.get(file)!;
    if (p.timer) clearTimeout(p.timer);
    savePending(file, false);
    while (PENDING.has(file) && Date.now() < until) {
      Atomics.wait(nap, 0, 0, STORE_LOCK_STEP_MS);
      savePending(file, false);
    }
  }
}
let exitHooked = false;

function savePending(file: string, retry = true): void {
  const p = PENDING.get(file);
  if (!p) return;
  p.timer = undefined;
  let locked = false;
  try {
    locked = tryStoreLock(file);
  } catch {
    locked = false;
  }
  if (!locked) {
    if (retry)
      p.timer = setTimeout(() => savePending(file), STORE_LOCK_STEP_MS);
    return;
  }
  try {
    // Issue 1348: onto the file as it is now, so another process's change
    // made meanwhile stays.
    const f = readStore(file);
    let changed = false;
    for (const op of p.ops) changed = op(f) || changed;
    if (changed) writeStore(file, f);
  } catch (e) {
    // Unwritable: as a direct write's failure, the changes are not kept.
    // The caller was answered already, so the log says so (no content).
    console.error(
      `notifications: ${p.ops.length} waiting change(s) not saved (${(e as NodeJS.ErrnoException).code ?? "error"})`,
    );
  } finally {
    unlockStore(file);
    PENDING.delete(file);
    for (const w of p.waiters) w();
  }
}

/** Whether `subject` (or its scope) is muted at `t` in `mutes`. */
function mutedIn(
  mutes: readonly Mute[],
  subject: string,
  scope: string,
  t: string,
): boolean {
  return mutes.some(
    (m) => (m.target === subject || m.target === scope) && m.until > t,
  );
}

/**
 * Issue 1348: resolves once this process's changes to `stateDir`'s store,
 * made while the lock was busy, are saved (at once when there are none).
 */
export function notificationsSaved(stateDir: string): Promise<void> {
  const p = PENDING.get(path.join(stateDir, NOTIFICATIONS_FILE));
  return p ? new Promise((r) => p.waiters.push(r)) : Promise.resolve();
}

export class NotificationStore {
  private readonly file: string;

  constructor(
    stateDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(stateDir, NOTIFICATIONS_FILE);
  }

  /** The file, with this process's changes still waiting for the lock. */
  private read(): StoreFile {
    const f = readStore(this.file);
    for (const op of PENDING.get(this.file)?.ops ?? []) op(f);
    return f;
  }

  private write(f: StoreFile): void {
    writeStore(this.file, f);
  }

  /**
   * Issue 1348: one change, under the store's lock: read, change, write.
   * With the lock busy (another process writing, for ms), it is applied to
   * what this process sees now and saved once the lock is free: no wait on
   * the thread, and no other process's write lost. Returns `op`'s result.
   */
  private change<T>(op: (f: StoreFile) => { out: T; changed: boolean }): T {
    if (!PENDING.has(this.file) && tryStoreLock(this.file)) {
      try {
        const f = readStore(this.file);
        const r = op(f);
        if (r.changed) this.write(f);
        return r.out;
      } finally {
        unlockStore(this.file);
      }
    }
    const r = op(this.read());
    if (r.changed) {
      const p = PENDING.get(this.file) ?? { ops: [], waiters: [] };
      PENDING.set(this.file, p);
      p.ops.push((f) => op(f).changed);
      if (!exitHooked) {
        exitHooked = true;
        process.on("exit", savePendingAtExit);
      }
      p.timer ??= setTimeout(() => savePending(this.file), STORE_LOCK_STEP_MS);
    }
    return r.out;
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
    return mutedIn(this.read().mutes, subject, scope, this.now().toISOString());
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
    undo?: { approval: string };
  }): Notification | null {
    if (this.muted(n.subject, n.scope)) return null;
    const at = this.now().toISOString();
    const text = plain(n.text);
    const msg = cleanMsg(n.msg);
    // Issue 1348: fixed before the change, which may be applied again.
    const id = crypto.randomUUID();
    return this.change((f) => {
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
        if (n.undo) same.undo = { approval: String(n.undo.approval) };
        out = same;
      } else {
        out = {
          id,
          source: n.source ?? "den",
          kind: n.kind,
          subject: n.subject,
          scope: n.scope,
          text,
          ...(msg ? { msg } : {}),
          ...(n.link ? { link: n.link } : {}),
          ...(n.undo ? { undo: { approval: String(n.undo.approval) } } : {}),
          at,
          read: false,
        };
        f.items.push(out);
      }
      f.items.sort((a, b) => a.at.localeCompare(b.at));
      if (f.items.length > MAX_NOTIFICATIONS)
        f.items = f.items.slice(-MAX_NOTIFICATIONS);
      return { out: { ...out } as Notification | null, changed: true };
    });
  }

  /**
   * NT-6: Hub's list (computed by Hub, the latest 50) against Den's Hub
   * items. New ones are added (unless muted); Hub's read marks Den's read;
   * one read in Den but not on Hub is returned, for Den to mark on Hub;
   * one Hub no longer lists goes. Den's own items are left alone.
   */
  syncHub(notes: readonly HubNote[], owner: string | null): string[] {
    const t = this.now().toISOString();
    return this.change((f) => {
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
          if (mutedIn(f.mutes, n.subject, scope, t)) continue;
          f.items.push({
            id,
            source: "hub",
            kind: n.kind,
            subject: n.subject,
            scope,
            ...(n.scopeName ? { scopeName: n.scopeName } : {}),
            text: plain(n.text),
            ...(n.msg ? { msg: cleanMsg(n.msg) } : {}),
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
          const msg = cleanMsg(n.msg);
          if (msg) x.msg = msg;
          else delete x.msg;
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
      }
      return { out: push, changed };
    });
  }

  /** NT-6: Hub took Den's read for these (Hub's ids). */
  hubMarked(ids: readonly string[]): void {
    if (!ids.length) return;
    const want = new Set(ids.map((i) => `hub:${i}`));
    this.change((f) => {
      let n = 0;
      for (const x of f.items)
        if (want.has(x.id) && !x.hubRead) {
          x.hubRead = true;
          n++;
        }
      return { out: undefined, changed: n > 0 };
    });
  }

  /** The agent is busy again, or was answered: its waiting item goes. */
  withdraw(subject: string, kind: NotificationKind = "waiting"): boolean {
    return this.change((f) => {
      const before = f.items.length;
      f.items = f.items.filter(
        (x) => !(x.subject === subject && x.kind === kind && !x.read),
      );
      const changed = f.items.length !== before;
      return { out: changed, changed };
    });
  }

  /**
   * Issue 1008: a question is settled: it stays, read, with why, who and
   * when, and the text and key that say so. False when there is no such
   * row, or it was settled already.
   */
  settle(
    id: string,
    s: { reason: string; by: string },
    say: { text: string; msg: NoteMsg },
  ): Notification | null {
    const at = this.now().toISOString();
    return this.change((f) => {
      const x = f.items.find((n) => n.id === id);
      if (!x || x.settled) return { out: null, changed: false };
      x.settled = { reason: plain(s.reason), by: s.by, at };
      x.read = true;
      x.at = at;
      x.text = plain(say.text);
      const msg = cleanMsg(say.msg);
      if (msg) x.msg = msg;
      f.items.sort((a, b) => a.at.localeCompare(b.at));
      return { out: { ...x } as Notification | null, changed: true };
    });
  }

  /** Issue 1008: an answer came after the question was settled. */
  settledLate(id: string, say: { text: string; msg: NoteMsg }): boolean {
    return this.change((f) => {
      const x = f.items.find((n) => n.id === id);
      if (!x?.settled || x.settled.late) return { out: false, changed: false };
      x.settled.late = true;
      x.text = plain(say.text);
      const msg = cleanMsg(say.msg);
      if (msg) x.msg = msg;
      return { out: true, changed: true };
    });
  }

  /**
   * #142: take items out whether read or not (opening an agent clears its
   * updates; a newer update ask replaces the older ones). How many went.
   */
  remove(match: (n: Notification) => boolean): number {
    return this.change((f) => {
      const before = f.items.length;
      f.items = f.items.filter((x) => !match(x));
      const n = before - f.items.length;
      return { out: n, changed: n > 0 };
    });
  }

  /** Mark read; how many changed. */
  /**
   * Issue 1371 Part 2: an Undo used (or no longer possible): the rows for
   * that held write lose their Undo, and are read. How many changed.
   */
  dropUndo(approval: string): number {
    return this.change((f) => {
      let n = 0;
      for (const x of f.items)
        if (x.undo?.approval === approval) {
          delete x.undo;
          x.read = true;
          n++;
        }
      return { out: n, changed: n > 0 };
    });
  }

  markRead(w: Which): number {
    return this.change((f) => {
      let n = 0;
      for (const x of f.items)
        if (!x.read && matches(x, w)) {
          x.read = true;
          n++;
        }
      return { out: n, changed: n > 0 };
    });
  }

  /**
   * Issue 1339: mark these ids read in one read and one write (Mark all
   * read marked each entry with its own whole-file rewrite). Ids that
   * aren't there are skipped; how many changed.
   */
  markReadMany(ids: Iterable<string>): number {
    const want = new Set(ids);
    if (!want.size) return 0;
    return this.change((f) => {
      let n = 0;
      for (const x of f.items)
        if (!x.read && want.has(x.id)) {
          x.read = true;
          n++;
        }
      return { out: n, changed: n > 0 };
    });
  }

  /** Remove the read ones (of `w`, default all); how many went. */
  clearRead(w: Which = { all: true }): number {
    return this.change((f) => {
      const before = f.items.length;
      f.items = f.items.filter((x) => !(x.read && matches(x, w)));
      const n = before - f.items.length;
      return { out: n, changed: n > 0 };
    });
  }

  /** Mute an agent (`agent:<id>`) or a project (`workspace/<ws>`) for `minutes`. */
  mute(target: string, minutes: number): Mute {
    const until = new Date(
      this.now().getTime() + Math.max(1, minutes) * 60_000,
    ).toISOString();
    const t = this.now().toISOString();
    const m = { target, until };
    this.change((f) => {
      f.mutes = f.mutes.filter((x) => x.target !== target && x.until > t);
      f.mutes.push({ ...m });
      return { out: undefined, changed: true };
    });
    return m;
  }

  unmute(target: string): void {
    this.change((f) => {
      f.mutes = f.mutes.filter((m) => m.target !== target);
      return { out: undefined, changed: true };
    });
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

/**
 * Bell v6 (0.4.45): the seven switches a person turns kinds on and off
 * with. Each notification kind belongs to one; pr and shared have none
 * producing yet (its switch is ready); shared comes from Hub (issue 581).
 */
export const BELL_SWITCHES = [
  "waiting",
  "finished",
  "hub",
  "pr",
  "release",
  "pick",
  "shared",
] as const;
export type BellSwitch = (typeof BELL_SWITCHES)[number];

/** The switch a kind of notification is shown or hidden by. */
export function switchOf(kind: NotificationKind): BellSwitch {
  switch (kind) {
    case "waiting":
      return "waiting";
    case "finished":
      return "finished";
    case "answer":
    case "mention":
      return "hub";
    case "decision":
      return "pick";
    case "service":
      return "release";
    case "shared":
      return "shared";
  }
}

/** Fold items older than this many days: the choices, and the default. */
export const BELL_FOLD_DAYS = [3, 7, 14, 30] as const;
export const BELL_FOLD_DAYS_DEFAULT = 7;

/** A person's bell: the switches that are off, and how old is "older". */
export interface BellPrefs {
  off: BellSwitch[];
  foldDays: number;
}

/**
 * The prefs from user.yml's `notifications.kinds` ({switch: true|false})
 * and `notifications.fold_days`. Unset: every switch on but finished (off
 * by default, also for anyone who never set it), 7 days. A hand-broken
 * value is its default.
 */
export function bellPrefs(user: unknown): BellPrefs {
  const n = (user as { notifications?: Record<string, unknown> } | null)
    ?.notifications;
  const kinds = (n?.kinds ?? {}) as Record<string, unknown>;
  const off = BELL_SWITCHES.filter((s) =>
    typeof kinds[s] === "boolean" ? kinds[s] === false : s === "finished",
  );
  const d = n?.fold_days;
  const foldDays = (BELL_FOLD_DAYS as readonly unknown[]).includes(d)
    ? (d as number)
    : BELL_FOLD_DAYS_DEFAULT;
  return { off, foldDays };
}

/**
 * ATTN-5 (den#142): the kinds that need the person: a wait (a permission
 * prompt, a question), a pick or an approval, a mention. The rest (a
 * finished turn, a reply, a release) are updates: listed, never counted.
 */
export function needsYou(kind: NotificationKind): boolean {
  return kind === "waiting" || kind === "decision" || kind === "mention";
}

/** What the bell shows: switches on only, and the old ones folded apart. */
export interface BellView {
  /** The badge: unread items that need you, shown and not folded as old. */
  unread: number;
  /** Items that need you, shown, newer than foldDays (first in the panel). */
  recent: Notification[];
  /** ATTN-5: updates, shown, newer than foldDays (one collapsed list). */
  updates: Notification[];
  /** Items shown, older than foldDays (one "Older" row). */
  older: Notification[];
  /** The switches that are off (the empty panel says which). */
  off: BellSwitch[];
  foldDays: number;
}

export function bellView(
  items: Notification[],
  prefs: BellPrefs,
  now = Date.now(),
): BellView {
  const off = new Set(prefs.off);
  const shown = items.filter((n) => !off.has(switchOf(n.kind)));
  const from = now - prefs.foldDays * 86_400_000;
  const old = (n: Notification) => Date.parse(n.at) < from;
  const fresh = shown.filter((n) => !old(n));
  // Issue 1008: a settled question no longer needs the person.
  const needs = (n: Notification) => needsYou(n.kind) && !n.settled;
  const recent = fresh.filter(needs);
  return {
    unread: recent.filter((n) => !n.read).length,
    recent,
    updates: fresh.filter((n) => !needs(n)),
    older: shown.filter(old),
    off: prefs.off,
    foldDays: prefs.foldDays,
  };
}
