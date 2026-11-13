/**
 * 0.4.44: config changes leave a trace. Every write of workspaces.yml is
 * an audit row naming its writer, and a Hub project link that changes
 * (linked, unlinked, replaced) is its own row with old → new. Found when
 * every project on an install lost its Hub link and the trail said
 * nothing.
 *
 * The web server routes rows through its own audit (recordAction, the
 * activity trail and audit.jsonl); any other process (the CLI, a script)
 * appends to <state>/audit.jsonl itself. Words only: a link is an id,
 * slug and name, never a secret.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getStateDir } from "./paths.js";

export interface ConfigAuditRow {
  verb: "config-write" | "hub-link";
  detail: string;
}

type Sink = (row: ConfigAuditRow) => void;

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

const appendRow: Sink = (row) => {
  try {
    const file = path.join(getStateDir(), "audit.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      file,
      JSON.stringify({
        ts: new Date().toISOString(),
        actor: "user",
        principal: processWho(),
        verb: row.verb,
        detail: row.detail,
      }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* best effort: a write never fails for want of its audit row */
  }
};

let sink: Sink = appendRow;

/** The server sends rows to its own audit; null puts the default back. */
export function setConfigAuditSink(fn: Sink | null): void {
  sink = fn ?? appendRow;
}

export function auditConfig(row: ConfigAuditRow): void {
  try {
    sink(row);
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
