/**
 * The audit's persisted ring, by name, in the state folder. Shared so the
 * CLI (doctor, issue 1131) reads the file the server writes without
 * importing a server module; server/audit.ts re-exports it.
 */
import * as fs from "fs";
import * as path from "path";
import { redactSecrets } from "./redact.js";

export const AUDIT_FILE = "audit.jsonl";

export function appendAuditRowWhenNoServer(
  stateDir: string,
  row: { verb: string; detail: string; principal?: string },
  now: () => Date = () => new Date(),
): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, AUDIT_FILE);
  const entry = {
    ts: now().toISOString(),
    actor: "user" as const,
    ...(row.principal ? { principal: redactSecrets(row.principal) } : {}),
    verb: redactSecrets(row.verb),
    detail: redactSecrets(row.detail),
  };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * Issue 1391: where the trail written before redaction is kept, once it
 * is set aside at the first start that redacts. Denied to agents in every
 * mode (a credential folder in their deny rules; outside the sandbox's
 * read list), as its rows may hold a value never redacted.
 */
export const AUDIT_SET_ASIDE_DIR = "audit-before-redaction";

/** Issue 1391: the set-aside's marker, written once it is done. */
export const AUDIT_SET_ASIDE_MARK = "set-aside.json";
