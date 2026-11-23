/**
 * The audit's persisted ring, by name, in the state folder. Shared so the
 * CLI (doctor, issue 1131) reads the file the server writes without
 * importing a server module; server/audit.ts re-exports it.
 */
export const AUDIT_FILE = "audit.jsonl";
