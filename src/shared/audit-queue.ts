/**
 * Issue 1369: the audit file (<state>/audit.jsonl) has one writer, the web
 * server. A process outside it (the CLI, a script, an agent's `den`
 * command) queues each entry as its own file in <state>/audit/cli-queue,
 * the one state folder an agent's sandbox may write (issue 936), so an
 * agent's commands keep their entries. The server takes the queue in at
 * its start and while it runs; readers outside it (doctor, the CLI's
 * lists) read the file and the queue together.
 *
 * A queued entry is the writer's word: whoever can write the folder can
 * queue one. The server keeps only entries of the CLI's verbs, of bounded
 * size, read without following a link, and records each as the CLI would
 * have (actor "user", its principal as written).
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AUDIT_FILE } from "./audit-file.js";
import { writeFileAtomic } from "./atomic-write.js";

export const AUDIT_QUEUE_DIR = path.join("audit", "cli-queue");

/** The verbs a process outside the server records (ConfigAuditRow's). */
export const QUEUED_VERBS: readonly string[] = [
  "config-write",
  "hub-link",
  "agents",
  "web-url",
  "hub-den-url",
  "test-person-setup",
];

const ENTRY_MAX_BYTES = 8192;
const DETAIL_MAX = 4000;
const TAKE_MAX = 1000;

export interface QueuedAuditRow {
  ts: string;
  verb: string;
  detail: string;
  principal?: string;
  via?: string;
  outcome?: "refused";
  reason?: string;
}

/** Queue one entry (0600, in a 0700 folder). Throws when it can't. */
export function queueAuditRow(stateDir: string, row: QueuedAuditRow): void {
  const dir = path.join(stateDir, AUDIT_QUEUE_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Sorted by name in the order written: the time, then a tie-breaker.
  const name = `${Date.now().toString().padStart(15, "0")}-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  writeFileAtomic(path.join(dir, name), JSON.stringify(row) + "\n", {
    mode: 0o600,
  });
}

/** One queued entry, or null when it isn't one. Never follows a link. */
function readQueued(file: string): QueuedAuditRow | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > ENTRY_MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    const v = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
    const str = (x: unknown, max: number) =>
      typeof x === "string" && x.length <= max;
    if (!str(v.ts, 40) || Number.isNaN(Date.parse(v.ts as string))) return null;
    if (typeof v.verb !== "string" || !QUEUED_VERBS.includes(v.verb))
      return null;
    if (!str(v.detail, DETAIL_MAX)) return null;
    if (v.principal !== undefined && !str(v.principal, 300)) return null;
    if (v.via !== undefined && !str(v.via, 300)) return null;
    if (v.outcome !== undefined && v.outcome !== "refused") return null;
    if (v.reason !== undefined && !str(v.reason, 300)) return null;
    return {
      ts: v.ts as string,
      verb: v.verb,
      detail: v.detail as string,
      ...(v.principal !== undefined
        ? { principal: v.principal as string }
        : {}),
      ...(v.via !== undefined ? { via: v.via as string } : {}),
      ...(v.outcome ? { outcome: "refused" as const } : {}),
      ...(v.reason !== undefined ? { reason: v.reason as string } : {}),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** The queue's entry files, oldest first (a write in progress left out). */
function queuedNames(stateDir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(stateDir, AUDIT_QUEUE_DIR))
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The server's intake: each queued entry, oldest first, to `record`, then
 * removed. One that isn't an entry is removed unrecorded (`dropped`); one
 * whose record throws stays for the next pass. At most TAKE_MAX a pass.
 */
export function takeQueuedAuditRows(
  stateDir: string,
  record: (row: QueuedAuditRow) => void,
): { taken: number; dropped: number } {
  const dir = path.join(stateDir, AUDIT_QUEUE_DIR);
  let taken = 0;
  let dropped = 0;
  for (const n of queuedNames(stateDir).slice(0, TAKE_MAX)) {
    const file = path.join(dir, n);
    const row = readQueued(file);
    if (row) {
      try {
        record(row);
      } catch {
        return { taken, dropped };
      }
      taken++;
    } else dropped++;
    try {
      fs.unlinkSync(file);
    } catch {
      /* taken by another pass */
    }
  }
  return { taken, dropped };
}

/**
 * For readers outside the server: audit.jsonl's rows, then the queue's
 * entries not taken in yet (as rows: actor "user"). Lines that don't parse
 * are skipped.
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
  for (const n of queuedNames(stateDir)) {
    const row = readQueued(path.join(dir, n));
    if (row) rows.push({ actor: "user", ...row });
  }
  return rows;
}

/**
 * The running server's intake: takes the queue in now, then on each
 * sweep (`intervalMs`) and, with `watch`, as soon as the folder changes.
 * Returns what stops it. Neither timer nor watcher keeps the process up.
 */
export function startAuditQueueIntake(
  stateDir: string,
  record: (row: QueuedAuditRow) => void,
  o: { intervalMs?: number; watch?: boolean } = {},
): () => void {
  const pass = () => {
    try {
      takeQueuedAuditRows(stateDir, record);
    } catch {
      /* the next sweep tries again */
    }
  };
  pass();
  const timer = setInterval(pass, o.intervalMs ?? 5000);
  timer.unref?.();
  let watcher: fs.FSWatcher | null = null;
  if (o.watch ?? true) {
    try {
      const dir = path.join(stateDir, AUDIT_QUEUE_DIR);
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
