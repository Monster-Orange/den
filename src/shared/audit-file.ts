/**
 * The audit's persisted ring, by name, in the state folder. Shared so the
 * CLI (doctor, issue 1131) reads the file the server writes without
 * importing a server module; server/audit.ts re-exports it.
 */
import * as fs from "fs";
import * as path from "path";

export const AUDIT_FILE = "audit.jsonl";

/**
 * Issue 1300: one activity-trail row written by a process other than the
 * server (`web logout` with no server running), appended to the file the
 * server reads at start. The same shape as the server's row; 0600.
 */
export function appendAuditRow(
  stateDir: string,
  row: { verb: string; detail: string; principal?: string },
  now: () => Date = () => new Date(),
): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, AUDIT_FILE);
  const entry = {
    ts: now().toISOString(),
    actor: "user" as const,
    ...(row.principal ? { principal: row.principal } : {}),
    verb: row.verb,
    detail: row.detail,
  };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
