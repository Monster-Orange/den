/**
 * Issue 1369: the audit file (<state>/audit.jsonl) has one writer, the web
 * server. A process outside it (the CLI, a script, an agent's `den`
 * command) sends each entry to the running server over its own
 * authenticated call (the CLI's sender, set at its start): the server
 * records who the credential says sent it, at its own time, and ignores
 * any "who" or "when" in the body.
 *
 * So that an entry outlives a server that's down (or a process that
 * exits before its send finishes), each entry is first queued as a file
 * in <state>/audit/cli-queue, the one state folder an agent's sandbox may
 * write (issue 936). The sender removes its own file once the server has
 * recorded it. What is left, the server takes in later as a report:
 * marked unverified, with no principal of its own (the writer's word,
 * its OS user and the file's times are kept as what it reported), at the
 * server's time. Anyone who can write the folder can queue one, an agent
 * included, so a queued entry is never taken as the person's or the
 * server's word; doctor counts them.
 *
 * Intake (the server): the queue folder is first moved, whole, into the
 * server's own <state>/audit-intake (out of an agent's reach), its entries
 * into audit-intake/pending, and read only there; nothing is ever moved or
 * written back where an agent may write, so a link put in the queue's
 * place reads, removes and receives nothing. A pass takes at most MAX_PER_PASS entries and
 * MAX_BYTES_PER_PASS bytes; startAuditQueueIntake sweeps every 5 s and
 * caps an hour at MAX_PER_HOUR. A queued copy is left SETTLE_MS first (its
 * send may still remove it), and one whose id the server took when it was
 * sent is dropped as a duplicate. What passes drop is summed into one
 * entry of the server's own a window (10 minutes). One principal's sent
 * entries are capped an hour too (sentAuditBudget).
 */
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AUDIT_FILE } from "./audit-file.js";
import { writeFileAtomic } from "./atomic-write.js";

/** The queue an agent's sandbox may write (its one writable state folder). */
export const AUDIT_QUEUE_DIR = path.join("audit", "cli-queue");
/**
 * The person's CLI's own queue: in the state folder, which an agent's
 * sandbox makes read-only, so an agent can't change or remove what's in
 * it. A process that can't write it (a sandboxed one) queues in
 * AUDIT_QUEUE_DIR instead.
 */
export const AUDIT_PERSON_QUEUE_DIR = "audit-person-queue";
/** The server's own folder a queue is moved into to be read. */
export const AUDIT_INTAKE_DIR = "audit-intake";
/** In AUDIT_INTAKE_DIR: queues moved in whole, read a part a pass. */
const BATCHES = "batches";
/** In AUDIT_INTAKE_DIR: entries in the order they arrived, to take in. */
export const AUDIT_PENDING_DIR = "pending";
/** In AUDIT_INTAKE_DIR: what isn't an entry, removed a part a pass. */
const TRASH = "trash";

/** The verbs a process outside the server records (ConfigAuditRow's). */
export const QUEUED_VERBS: readonly string[] = [
  "config-write",
  "hub-link",
  "agents",
  "web-url",
  "hub-den-url",
  "test-person-setup",
];

/** The server's own entry naming what an intake pass dropped. */
export const QUEUE_DROPPED_VERB = "audit-queue-dropped";

const ENTRY_MAX_BYTES = 8192;
const DETAIL_MAX = 4000;
export const MAX_PER_PASS = 200;
export const MAX_BYTES_PER_PASS = 256 * 1024;
export const MAX_PER_HOUR = 600;
const ID = /^\d{15}-\d{1,10}-\d{9}-[0-9a-f]{8}$/;
/** This process's entries in the order written, within one millisecond. */
let seq = 0;

/** What a process outside the server sends, or queues. */
export interface CliAuditRow {
  verb: string;
  detail: string;
  outcome?: "refused";
  reason?: string;
  /** Issue 636: the test-person path, as the writer says. */
  via?: string;
  /** Its queued copy's id, sent so the server drops that copy later. */
  id?: string;
}

/** A queued entry: the row, and what its writer reported about itself. */
export interface QueuedAuditRow extends CliAuditRow {
  /** All of it the writer's word, or the file's, never checked. */
  reported: {
    principal?: string;
    at?: string;
    /** The queue file's owner and modification time. */
    uid: number;
    written: string;
  };
}

/** One line, printable characters only, at most `max` long. */
export function cleanLine(v: unknown, max: number): string {
  const line = String(v ?? "").split(/[\r\n\u0085\u2028\u2029]/)[0];
  // Controls (C0, C1), format and bidi marks, line and paragraph breaks.
  return line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").slice(0, max);
}

/** A row's fields as the server keeps them, or null when it isn't one. */
export function cliAuditRowOf(v: Record<string, unknown>): CliAuditRow | null {
  if (typeof v.verb !== "string" || !QUEUED_VERBS.includes(v.verb)) return null;
  if (typeof v.detail !== "string" || v.detail.length > DETAIL_MAX) return null;
  if (v.outcome !== undefined && v.outcome !== "refused") return null;
  for (const k of ["reason", "via"] as const)
    if (v[k] !== undefined && typeof v[k] !== "string") return null;
  return {
    verb: v.verb,
    detail: cleanLine(v.detail, DETAIL_MAX),
    ...(v.outcome ? { outcome: "refused" as const } : {}),
    ...(typeof v.reason === "string"
      ? { reason: cleanLine(v.reason, 300) }
      : {}),
    ...(v.via === "test-person" ? { via: "test-person" } : {}),
  };
}

/**
 * Queue one entry (0600, in a 0700 folder) and return its id, for the
 * sender to remove once the server has it. Throws when it can't.
 */
export function queueAuditRow(
  stateDir: string,
  row: CliAuditRow & { principal?: string; at?: string },
): string {
  // Sorted by name in the order written: the time, then a tie-breaker.
  const id = `${Date.now().toString().padStart(15, "0")}-${process.pid}-${String(seq++ % 1e9).padStart(9, "0")}-${randomBytes(4).toString("hex")}`;
  const write = (rel: string) => {
    const dir = path.join(stateDir, rel);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(path.join(dir, `${id}.json`), JSON.stringify(row) + "\n", {
      mode: 0o600,
    });
  };
  const tryBoth = () => {
    try {
      write(AUDIT_PERSON_QUEUE_DIR);
    } catch {
      // Not writable here (an agent's sandbox): the queue it may write.
      write(AUDIT_QUEUE_DIR);
    }
  };
  try {
    tryBoth();
  } catch {
    // The server may have just moved the folder in for its intake.
    tryBoth();
  }
  return id;
}

/** Remove a queued entry the server has recorded (the sender's own). */
export function unqueueAuditRow(stateDir: string, id: string): void {
  if (!ID.test(id)) return;
  for (const rel of [AUDIT_PERSON_QUEUE_DIR, AUDIT_QUEUE_DIR])
    try {
      fs.unlinkSync(path.join(stateDir, rel, `${id}.json`));
    } catch {
      /* not this queue's, or taken in already */
    }
}

/** One queued entry, or null when it isn't one. Never follows a link. */
function readQueued(file: string): QueuedAuditRow | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > ENTRY_MAX_BYTES)
      return null;
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    const v = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
    const row = cliAuditRowOf(v);
    if (!row) return null;
    return {
      ...row,
      reported: {
        ...(typeof v.principal === "string"
          ? { principal: cleanLine(v.principal, 300) }
          : {}),
        ...(typeof v.at === "string" ? { at: cleanLine(v.at, 40) } : {}),
        uid: st.uid,
        written: st.mtime.toISOString(),
      },
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** A folder's entry files, oldest first (a write in progress left out). */
function entryNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

export interface IntakeCounts {
  taken: number;
  /** Not entries (a name not an id, bad JSON, another verb, too big, a link), removed. */
  dropped: number;
  /** Copies of entries the server already took when they were sent. */
  duplicate: number;
  /** Younger than the settle time, left for a later pass. */
  waiting: number;
  /** Past this pass's cap, left pending for a later pass (never removed). */
  deferred: number;
  /** Queue folders that weren't one (a link put in its place), removed. */
  refused: number;
  /** Passes that left a queue where it was: the intake was full. */
  full: number;
  /** Of `taken`, the person's queue's. */
  takenPerson: number;
}

const uid = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

/** Whether `id` is a queue entry's id (queueAuditRow's shape). */
export function isQueueId(id: unknown): id is string {
  return typeof id === "string" && ID.test(id);
}

/**
 * The entries the server took when they were sent (its memory, the last
 * RECENT_IDS): each id with who sent it and its words' hash. A queued
 * copy of one, left by a sender that ended before removing it, is dropped
 * as a duplicate, but only when its own words hash the same and, for a
 * copy from the person's queue, the sender was the person: an id alone
 * (anyone who can read a queue can learn one) never drops an entry.
 */
const RECENT_IDS = 4096;
const sent = new Map<string, { principal: string; hash: string }>();

/** A row's words (verb, detail, outcome, reason), as a hash. */
export function auditRowHash(row: CliAuditRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.verb,
        row.detail,
        row.outcome ?? null,
        row.reason ?? null,
      ]),
    )
    .digest("hex");
}

export function rememberSentAuditCopy(
  id: string,
  principal: string,
  hash: string,
): void {
  if (!isQueueId(id)) return;
  sent.delete(id);
  sent.set(id, { principal, hash });
  while (sent.size > RECENT_IDS) sent.delete(sent.keys().next().value!);
}

export function wasSentAuditCopy(
  id: string,
  hash: string,
  fromPerson: boolean,
): boolean {
  const s = sent.get(id);
  if (!s || s.hash !== hash) return false;
  return !fromPerson || s.principal.startsWith("person:");
}

/**
 * Issue 1369: a cap on one principal's sent entries an hour (`perHour`):
 * true while it may send another. Its entries are its own, so this is
 * against noise, not forgery.
 */
export function sentAuditBudget(
  perHour: number = MAX_PER_HOUR,
): (principal: string, now?: number) => boolean {
  const seen = new Map<string, { start: number; n: number }>();
  return (principal, now = Date.now()) => {
    let b = seen.get(principal);
    if (!b || now - b.start >= 3_600_000) {
      b = { start: now, n: 0 };
      seen.set(principal, b);
      if (seen.size > RECENT_IDS) seen.delete(seen.keys().next().value!);
    }
    if (b.n >= perHour) return false;
    b.n++;
    return true;
  };
}

/** How long a queued copy is left for its send to remove it. */
export const SETTLE_MS = 15_000;
/** At most this many entries wait pending; past it, queues wait where they are. */
const MAX_PENDING = 2 * MAX_PER_HOUR;
/** At most this many queues moved in and not read through yet. */
const MAX_BATCHES = 8;
/** Names a pass reads from moved-in queues, and removals it makes. */
const SCAN_PER_PASS = 2000;
const NAME = /^(\d{15}-\d{1,10}-\d{9}-[0-9a-f]{8})\.json$/;
/** Arrival order of what this server moves pending. */
let arrived = 0;
const arrival = () =>
  `${Date.now().toString().padStart(15, "0")}-${String(arrived++ % 1e9).padStart(9, "0")}`;

/** At most `max` names in `dir` (a directory read, never all of it). */
function someNames(dir: string, max: number): fs.Dirent[] {
  const out: fs.Dirent[] = [];
  let d: fs.Dir | null = null;
  try {
    d = fs.opendirSync(dir);
    for (let e = d.readSync(); e && out.length < max; e = d.readSync())
      out.push(e);
  } catch {
    /* gone */
  } finally {
    d?.closeSync();
  }
  return out;
}

/**
 * Removes at most `budget` of what's in `trash`, never more than one
 * component deep into a folder that came from a queue: under a sandbox
 * that grants writes by mount, an agent holding one open can change what's
 * in it (never the folder itself: trash is the server's). So in a trashed
 * folder X, each entry is lstat'd and a file or link unlinked as X/name
 * (unlink never follows the last component), a subfolder renamed up into
 * trash for a later pass (a rename never follows it either), and X removed
 * once it's empty. No recursive remove, and a deep tree costs one pass a
 * level, never a wedge.
 */
function clearTrash(
  trash: string,
  budget: number,
  toTrash: (p: string) => void,
): void {
  let ops = 0;
  for (const e of someNames(trash, budget)) {
    if (ops >= budget) return;
    const x = path.join(trash, e.name);
    ops++;
    try {
      if (!fs.lstatSync(x).isDirectory()) {
        fs.unlinkSync(x);
        continue;
      }
      const inner = someNames(x, budget - ops);
      if (!inner.length) {
        fs.rmdirSync(x);
        continue;
      }
      for (const i of inner) {
        ops++;
        const p = path.join(x, i.name);
        try {
          if (fs.lstatSync(p).isDirectory()) toTrash(p);
          else fs.unlinkSync(p);
        } catch {
          /* the next pass */
        }
      }
    } catch {
      /* the next pass */
    }
  }
}

/**
 * The server's intake pass. Every path it reads, moves or removes is in
 * its own AUDIT_INTAKE_DIR, but for the one lstat and one rename that
 * move each queue in; nothing is ever written back to a queue's path.
 *
 * 1. What isn't an entry is removed, a part a pass (SCAN_PER_PASS).
 * 2. Each queue (the person's, then the agents') is moved in whole, while
 *    there is room (pending under `maxPending`, under MAX_BATCHES queues
 *    not read through); else it waits where it is (`full`).
 * 3. Moved-in queues are read a part a pass (`scanPerPass` names): each
 *    entry named by an id, a plain file of one link and at most 8 KB,
 *    goes pending under its arrival (the server's order, never the
 *    writer's names); anything else goes to be removed (`dropped`).
 * 4. Pending entries, in arrival order: one younger than `settleMs` waits;
 *    a copy of one `seen` says the server took when sent (its sender and
 *    words matching) is removed as a
 *    duplicate; past `max` entries or MAX_BYTES_PER_PASS bytes the rest
 *    wait for a later pass (`deferred`); the others go to `record`.
 *    Only what was read is removed.
 */
export function takeQueuedAuditRows(
  stateDir: string,
  record: (row: QueuedAuditRow) => void,
  max: number = MAX_PER_PASS,
  o: {
    settleMs?: number;
    now?: number;
    seen?: (id: string, hash: string, fromPerson: boolean) => boolean;
    maxPending?: number;
    scanPerPass?: number;
    /** The person's queue's own cap this pass (default `max`). */
    personMax?: number;
  } = {},
): IntakeCounts {
  const out: IntakeCounts = {
    taken: 0,
    dropped: 0,
    duplicate: 0,
    waiting: 0,
    deferred: 0,
    refused: 0,
    full: 0,
    takenPerson: 0,
  };
  const settleMs = o.settleMs ?? 0;
  const now = o.now ?? Date.now();
  const maxPending = o.maxPending ?? MAX_PENDING;
  const scan = o.scanPerPass ?? SCAN_PER_PASS;
  const isOwnDir = (p: string) => {
    const st = fs.lstatSync(p);
    return st.isDirectory() && (uid() === null || st.uid === uid());
  };
  const intake = path.join(stateDir, AUDIT_INTAKE_DIR);
  const [batches, pending, trash] = [BATCHES, AUDIT_PENDING_DIR, TRASH].map(
    (d) => path.join(intake, d),
  );
  try {
    for (const d of [batches, pending, trash])
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    if (![intake, batches, pending, trash].every(isOwnDir)) return out;
  } catch {
    return out;
  }
  const toTrash = (p: string) => {
    try {
      fs.renameSync(
        p,
        path.join(trash, `${arrival()}-${randomBytes(4).toString("hex")}`),
      );
    } catch {
      /* gone */
    }
  };

  // 1. What isn't an entry, removed a part a pass.
  clearTrash(trash, scan, toTrash);

  // 2. The queues in, each while its own part has room: the person's
  // queue ("p") and the agents' ("a") have their own room in pending and
  // in moved-in queues, so one never waits behind the other.
  const SOURCES = [
    { tag: "p", rel: AUDIT_PERSON_QUEUE_DIR },
    { tag: "a", rel: AUDIT_QUEUE_DIR },
  ] as const;
  const tagOf = (n: string) => /^\d{15}-\d{9}-([pa])/.exec(n)?.[1] ?? "a";
  const count = (dir: string, tag: string, max: number) =>
    someNames(dir, 2 * max + 2).filter((e) => tagOf(e.name) === tag).length;
  const room: Record<string, number> = {};
  for (const { tag } of SOURCES)
    room[tag] = maxPending - count(pending, tag, maxPending);
  for (const { tag, rel } of SOURCES) {
    const queue = path.join(stateDir, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(queue);
    } catch {
      continue;
    }
    if (!st.isDirectory() || (uid() !== null && st.uid !== uid())) {
      // A link (or a file) in the queue's place: moved away itself (a
      // rename never follows a link), then removed.
      toTrash(queue);
      out.refused++;
      continue;
    }
    if (room[tag] <= 0 || count(batches, tag, MAX_BATCHES) >= MAX_BATCHES) {
      out.full++;
      continue;
    }
    try {
      fs.renameSync(queue, path.join(batches, `${arrival()}-${tag}`));
    } catch {
      /* the next pass */
    }
  }

  // 3. Moved-in queues, a part a pass, to pending in arrival order (the
  // person's first).
  const byPersonFirst = (x: string, y: string) =>
    tagOf(x) === tagOf(y)
      ? x < y
        ? -1
        : x > y
          ? 1
          : 0
      : tagOf(x) === "p"
        ? -1
        : 1;
  let budget = scan;
  for (const b of someNames(batches, 2 * MAX_BATCHES + 2)
    .map((e) => e.name)
    .sort(byPersonFirst)) {
    if (budget <= 0) break;
    const tag = tagOf(b);
    if (room[tag] <= 0) continue;
    const dir = path.join(batches, b);
    try {
      if (!isOwnDir(dir)) {
        toTrash(dir);
        continue;
      }
    } catch {
      continue;
    }
    const names = someNames(dir, budget)
      .map((e) => e.name)
      .sort();
    budget -= names.length;
    for (const n of names) {
      const file = path.join(dir, n);
      const id = NAME.exec(n)?.[1];
      let st: fs.Stats | null = null;
      try {
        st = fs.lstatSync(file);
      } catch {
        continue;
      }
      if (!id || !st.isFile() || st.nlink !== 1 || st.size > ENTRY_MAX_BYTES) {
        toTrash(file);
        out.dropped++;
        continue;
      }
      if (room[tag] <= 0) break;
      try {
        const to = path.join(pending, `${arrival()}-${tag}--${id}.json`);
        fs.renameSync(file, to);
        // Swapped between the check and the move: not a plain file, out.
        if (!fs.lstatSync(to).isFile()) {
          toTrash(to);
          out.dropped++;
          continue;
        }
        room[tag]--;
      } catch {
        /* the next pass */
      }
    }
    // Read through: the emptied folder goes.
    if (someNames(dir, 1).length === 0) {
      try {
        fs.rmdirSync(dir);
      } catch {
        toTrash(dir);
      }
    }
  }

  // 4. Pending, the person's first, each in arrival order.
  let bytes = 0;
  for (const n of someNames(pending, 2 * maxPending + 2)
    .map((e) => e.name)
    .sort(byPersonFirst)) {
    const file = path.join(pending, n);
    const id = n.slice(n.indexOf("--") + 2, -".json".length);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue;
    }
    // Young: written within the settle time. A time more than a second
    // ahead (the writer sets it; a clock's own jitter is less) counts as
    // settled, so nothing waits forever.
    if (!st.isFile()) {
      toTrash(file);
      out.dropped++;
      continue;
    }
    const age = now - st.mtimeMs;
    if (settleMs > 0 && age >= -1000 && age < settleMs) {
      out.waiting++;
      continue;
    }
    const fromPerson = tagOf(n) === "p";
    const cap = fromPerson ? (o.personMax ?? max) : max;
    const takenHere = fromPerson
      ? out.takenPerson
      : out.taken - out.takenPerson;
    if (takenHere >= cap || bytes + st.size > MAX_BYTES_PER_PASS) {
      out.deferred++;
      continue;
    }
    const row = readQueued(file);
    try {
      fs.unlinkSync(file);
    } catch {
      toTrash(file);
    }
    if (!row) {
      out.dropped++;
      continue;
    }
    // A copy of one sent and taken: dropped only when the sender is one
    // who may (the person, for the person's queue) and its words are
    // this copy's own, so no one can erase another's entry by its id.
    if (o.seen?.(id, auditRowHash(row), fromPerson)) {
      out.duplicate++;
      continue;
    }
    try {
      record(row);
      bytes += st.size;
      out.taken++;
      if (fromPerson) out.takenPerson++;
    } catch {
      out.dropped++;
    }
  }
  return out;
}

/**
 * The running server's intake: a pass now, then on each sweep
 * (`intervalMs`), at most `perHour` entries an hour, each queued copy left
 * `settleMs` first. What passes drop, refuse or leave for want of room is
 * summed and told to `onDropped` at most once a `windowMs`, when the
 * window ends. Returns what stops it; the timer never keeps the process
 * up.
 */
export function startAuditQueueIntake(
  stateDir: string,
  record: (row: QueuedAuditRow) => void,
  o: {
    intervalMs?: number;
    perHour?: number;
    settleMs?: number;
    windowMs?: number;
    now?: () => number;
    seen?: (id: string, hash: string, fromPerson: boolean) => boolean;
    onDropped?: (c: IntakeCounts) => void;
  } = {},
): () => void {
  const now = o.now ?? Date.now;
  const perHour = o.perHour ?? MAX_PER_HOUR;
  const windowMs = o.windowMs ?? 600_000;
  let hourStart = now();
  // Each queue's own hour: the agents' entries never use up the person's.
  let thisHour = 0;
  let thisHourPerson = 0;
  let windowStart: number | null = null;
  let sum: IntakeCounts | null = null;
  let busy = false;
  const pass = () => {
    if (busy) return;
    busy = true;
    try {
      if (now() - hourStart >= 3_600_000) {
        hourStart = now();
        thisHour = 0;
        thisHourPerson = 0;
      }
      const c = takeQueuedAuditRows(
        stateDir,
        record,
        Math.max(0, Math.min(MAX_PER_PASS, perHour - thisHour)),
        {
          personMax: Math.max(
            0,
            Math.min(MAX_PER_PASS, perHour - thisHourPerson),
          ),
          settleMs: o.settleMs ?? SETTLE_MS,
          now: now(),
          ...(o.seen ? { seen: o.seen } : {}),
        },
      );
      thisHour += c.taken - c.takenPerson;
      thisHourPerson += c.takenPerson;
      if (c.dropped || c.refused || c.full) {
        sum = sum
          ? {
              ...sum,
              dropped: sum.dropped + c.dropped,
              refused: sum.refused + c.refused,
              full: sum.full + c.full,
            }
          : {
              ...c,
              taken: 0,
              takenPerson: 0,
              duplicate: 0,
              waiting: 0,
              deferred: 0,
            };
        windowStart ??= now();
      }
      if (sum && windowStart !== null && now() - windowStart >= windowMs) {
        o.onDropped?.(sum);
        sum = null;
        windowStart = null;
      }
    } catch {
      /* the next sweep tries again */
    } finally {
      busy = false;
    }
  };
  pass();
  const timer = setInterval(pass, o.intervalMs ?? 5000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The intake's own entry, in words, for what a pass dropped. */
export function droppedDetail(c: IntakeCounts): string {
  const parts = [
    ...(c.dropped ? [`${c.dropped} that weren't entries`] : []),
    ...(c.full
      ? [
          `none: the intake was full, so queues waited where they were ${c.full} time${c.full === 1 ? "" : "s"}`,
        ]
      : []),
    ...(c.refused
      ? [
          `a link in the queue folder's place, removed ${c.refused} time${c.refused === 1 ? "" : "s"}`,
        ]
      : []),
  ];
  return `queued audit entries: ${parts.join(", ")}`;
}

/**
 * For readers outside the server: audit.jsonl's rows, then the queue's
 * entries not taken in yet, as reports (unverified, no principal). Lines
 * that don't parse are skipped.
 */
export function readAuditRows(stateDir: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  try {
    for (const line of fs
      .readFileSync(path.join(stateDir, AUDIT_FILE), "utf8")
      .split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* a torn line */
      }
    }
  } catch {
    /* no file yet */
  }
  // Then what waits in the queues, read only (a link is never followed).
  for (const rel of [AUDIT_PERSON_QUEUE_DIR, AUDIT_QUEUE_DIR]) {
    const dir = path.join(stateDir, rel);
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const n of entryNames(dir)) {
      const row = readQueued(path.join(dir, n));
      if (row) rows.push(queuedEntryOf(row, row.reported.written));
    }
  }
  return rows;
}

/** A queued row as an audit entry: a report, never anyone's word. */
export function queuedEntryOf(
  row: QueuedAuditRow,
  ts: string,
): Record<string, unknown> {
  return {
    ts,
    actor: "user",
    unverified: true,
    queued: true,
    reported: { ...row.reported, ...(row.via ? { via: row.via } : {}) },
    verb: row.verb,
    detail: row.detail,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}
