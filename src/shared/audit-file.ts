/**
 * The audit's persisted ring, by name, in the state folder. Shared so the
 * CLI (doctor, issue 1131) reads the file the server writes without
 * importing a server module; server/audit.ts re-exports it.
 */
export const AUDIT_FILE = "audit.jsonl";

/**
 * Issue 1391: where the trail written before redaction is kept, once it
 * is set aside at the first start that redacts. Denied to agents in every
 * mode (a credential folder in their deny rules; outside the sandbox's
 * read list), as its rows may hold a value never redacted.
 */
export const AUDIT_SET_ASIDE_DIR = "audit-before-redaction";

/** Issue 1391: the set-aside's marker, written once it is done. */
export const AUDIT_SET_ASIDE_MARK = "set-aside.json";
