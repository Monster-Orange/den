/**
 * 0.4.44: config changes leave a trace. Every write of workspaces.yml is
 * an audit row naming its writer, and a Hub project link that changes
 * (linked, unlinked, replaced) is its own row with old → new. Found when
 * every project on an install lost its Hub link and the trail said
 * nothing.
 *
 * The web server routes rows through its own audit (recordAction, the
 * activity trail and audit.jsonl); any other process (the CLI, a script)
 * queues its row for the server to take in (issue 1369: audit-queue.ts),
 * so audit.jsonl has one writer. Words only: a link is an id, slug and
 * name, never a secret.
 */
import * as os from "os";
import * as path from "path";
import { getStateDir } from "./paths.js";
import { queueAuditRow } from "./audit-queue.js";
import { auditVia } from "./test-person.js";

export interface ConfigAuditRow {
  /** issue 216: "agents" is a restart, stop or resume from the CLI. */
  /** issue 816: "test-person-setup", a test install set up from this Den. */
  verb:
    | "config-write"
    | "hub-link"
    | "agents"
    | "web-url"
    | "hub-den-url"
    | "test-person-setup";
  detail: string;
  /** Set when it never happened: refused, or still busy. */
  outcome?: "refused";
  /** Why (first line). */
  reason?: string;
}

/** `stateDir`: the audit's own state dir, when the caller has one. */
type Sink = (row: ConfigAuditRow, stateDir?: string) => void;

/** Outside the server: who runs this process, and what it was asked. */
function processWho(): string {
  let user = "?";
  try {
    user = os.userInfo().username;
  } catch {
    /* unknown */
  }
  const args = process.argv.slice(2, 4).join(" ");
  return `person:${user} (${path.basename(process.argv[1] ?? "node")}${args ? ` ${args}` : ""}, pid ${process.pid})`;
}

/**
 * Issue 1369: outside the server, the entry is queued for the server to
 * take in (the audit file has one writer; an agent's sandbox can write
 * the queue).
 */
const appendRow: Sink = (row, stateDir) => {
  try {
    queueAuditRow(stateDir ?? getStateDir(), {
      ts: new Date().toISOString(),
      principal: processWho(),
      // Issue 636: a CLI on a test bed's test-person path.
      ...(auditVia() ? { via: auditVia() } : {}),
      verb: row.verb,
      detail: row.detail,
      ...(row.outcome ? { outcome: row.outcome } : {}),
      ...(row.reason
        ? { reason: row.reason.split(/[\r\n]/)[0].slice(0, 300) }
        : {}),
    });
  } catch {
    /* best effort: a write never fails for want of its audit row */
  }
};

let sink: Sink = appendRow;

/** The server sends rows to its own audit; null puts the default back. */
export function setConfigAuditSink(fn: Sink | null): void {
  sink = fn ?? appendRow;
}

export function auditConfig(row: ConfigAuditRow, stateDir?: string): void {
  try {
    sink(row, stateDir);
  } catch {
    /* best effort */
  }
}

/**
 * The function that called the writer (from the stack), for "by": what
 * changed the file when nobody said. `skip` frames above the caller.
 */
export function callerName(skip = 2): string {
  const lines = (new Error().stack ?? "").split("\n").slice(1);
  for (const l of lines.slice(skip)) {
    const m = /at (?:async )?([\w$.<>]+) \(([^)]+)\)/.exec(l);
    if (!m) continue;
    const file = m[2].replace(/:\d+:\d+$/, "");
    const where = file.includes("/src/")
      ? file.slice(file.lastIndexOf("/src/") + 1)
      : path.basename(file);
    return `${m[1].replace(/^Object\./, "")} (${where})`;
  }
  return "unknown";
}
