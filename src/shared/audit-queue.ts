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
 * server's own <state>/audit-intake (out of an agent's reach), and read
 * only there, so a link put in its place reads and removes nothing
 * outside it. A pass takes at most MAX_PER_PASS entries and
 * MAX_BYTES_PER_PASS bytes; startAuditQueueIntake caps an hour at
 * MAX_PER_HOUR. What it drops is counted, for an entry of the server's own.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AUDIT_FILE } from "./audit-file.js";
import { writeFileAtomic } from "./atomic-write.js";

export const AUDIT_QUEUE_DIR = path.join("audit", "cli-queue");
/** The server's own folder a queue is moved into to be read. */
export const AUDIT_INTAKE_DIR = "audit-intake";

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
  const line = String(v ?? "").split(/[\r\n]/)[0];
  return [...line]
    .filter((c) => c >= " " && c !== "\u007f")
    .join("")
    .slice(0, max);
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
  const dir = path.join(stateDir, AUDIT_QUEUE_DIR);
  // Sorted by name in the order written: the time, then a tie-breaker.
  const id = `${Date.now().toString().padStart(15, "0")}-${process.pid}-${String(seq++ % 1e9).padStart(9, "0")}-${randomBytes(4).toString("hex")}`;
  const write = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(path.join(dir, `${id}.json`), JSON.stringify(row) + "\n", {
      mode: 0o600,
    });
  };
  try {
    write();
  } catch {
    // The server may have just moved the folder in for its intake.
    write();
  }
  return id;
}

/** Remove a queued entry the server has recorded (the sender's own). */
export function unqueueAuditRow(stateDir: string, id: string): void {
  if (!ID.test(id)) return;
  try {
    fs.unlinkSync(path.join(stateDir, AUDIT_QUEUE_DIR, `${id}.json`));
  } catch {
    /* taken in already */
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
  /** Not entries: bad JSON, another verb, too big, a link. */
  dropped: number;
  /** Entries past this pass's cap. */
  overCap: number;
  /** A queue folder that wasn't one (a link put in its place). */
  refused: boolean;
}

const uid = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

/**
 * The server's intake pass: the queue folder moved whole into its own
 * intake folder, each entry, oldest first, to `record` (at most `max`
 * entries and MAX_BYTES_PER_PASS bytes), then the moved folder removed.
 */
export function takeQueuedAuditRows(
  stateDir: string,
  record: (row: QueuedAuditRow) => void,
  max: number = MAX_PER_PASS,
): IntakeCounts {
  const out: IntakeCounts = {
    taken: 0,
    dropped: 0,
    overCap: 0,
    refused: false,
  };
  const queue = path.join(stateDir, AUDIT_QUEUE_DIR);
  const isOwnDir = (p: string) => {
    const st = fs.lstatSync(p);
    return st.isDirectory() && (uid() === null || st.uid === uid());
  };
  try {
    if (!isOwnDir(queue)) {
      // A link (or a file) in the queue's place: removed itself, never
      // followed.
      fs.unlinkSync(queue);
      out.refused = true;
      return out;
    }
  } catch {
    return out;
  }
  const intake = path.join(stateDir, AUDIT_INTAKE_DIR);
  const moved = path.join(
    intake,
    `${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  try {
    fs.mkdirSync(intake, { recursive: true, mode: 0o700 });
    // A rename moves a link itself, never what it points at.
    fs.renameSync(queue, moved);
  } catch {
    return out;
  }
  try {
    if (!isOwnDir(moved)) {
      out.refused = true;
      return out;
    }
    let bytes = 0;
    for (const n of entryNames(moved)) {
      const file = path.join(moved, n);
      let size = 0;
      try {
        size = fs.lstatSync(file).size;
      } catch {
        continue;
      }
      if (out.taken >= max || bytes + size > MAX_BYTES_PER_PASS) {
        out.overCap++;
        continue;
      }
      const row = readQueued(file);
      if (!row) {
        out.dropped++;
        continue;
      }
      try {
        record(row);
      } catch {
        out.dropped++;
        continue;
      }
      bytes += size;
      out.taken++;
    }
    return out;
  } finally {
    // The moved folder, whatever it holds (rm never follows a link in it).
    fs.rmSync(moved, { recursive: true, force: true });
  }
}

/**
 * The running server's intake: a pass now, then on each sweep
 * (`intervalMs`) and, with `watch`, when the folder changes; at most
 * `perHour` entries an hour. `onDropped` hears of each pass that dropped
 * or capped something, or found a link for its folder. Returns what
 * stops it; neither timer nor watcher keeps the process up.
 */
export function startAuditQueueIntake(
  stateDir: string,
  record: (row: QueuedAuditRow) => void,
  o: {
    intervalMs?: number;
    watch?: boolean;
    perHour?: number;
    now?: () => number;
    onDropped?: (c: IntakeCounts) => void;
  } = {},
): () => void {
  const now = o.now ?? Date.now;
  const perHour = o.perHour ?? MAX_PER_HOUR;
  let hourStart = now();
  let thisHour = 0;
  let busy = false;
  const pass = () => {
    if (busy) return;
    busy = true;
    try {
      if (now() - hourStart >= 3_600_000) {
        hourStart = now();
        thisHour = 0;
      }
      const c = takeQueuedAuditRows(
        stateDir,
        record,
        Math.max(0, Math.min(MAX_PER_PASS, perHour - thisHour)),
      );
      thisHour += c.taken;
      if (c.dropped || c.overCap || c.refused) o.onDropped?.(c);
    } catch {
      /* the next sweep tries again */
    } finally {
      busy = false;
    }
  };
  pass();
  const timer = setInterval(pass, o.intervalMs ?? 5000);
  timer.unref?.();
  let watcher: fs.FSWatcher | null = null;
  if (o.watch ?? true) {
    try {
      const dir = path.join(stateDir, "audit");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      watcher = fs.watch(dir, () => pass());
      watcher.unref?.();
      watcher.on("error", () => watcher?.close());
    } catch {
      watcher = null;
    }
  }
  return () => {
    clearInterval(timer);
    watcher?.close();
  };
}

/** The intake's own entry, in words, for what a pass dropped. */
export function droppedDetail(c: IntakeCounts): string {
  const parts = [
    ...(c.dropped ? [`${c.dropped} that weren't entries`] : []),
    ...(c.overCap ? [`${c.overCap} over the intake's cap`] : []),
    ...(c.refused ? ["a link in the queue folder's place, removed"] : []),
  ];
  return `queued audit entries dropped: ${parts.join(", ")}`;
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
  const dir = path.join(stateDir, AUDIT_QUEUE_DIR);
  try {
    if (!fs.lstatSync(dir).isDirectory()) return rows;
  } catch {
    return rows;
  }
  for (const n of entryNames(dir)) {
    const row = readQueued(path.join(dir, n));
    if (row) rows.push(queuedEntryOf(row, row.reported.written));
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
