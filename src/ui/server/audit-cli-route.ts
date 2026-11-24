/**
 * Issue 1369: POST /api/audit/cli, a CLI's audit entry sent over its own
 * authenticated call. The credential says who sent it; the body gives
 * only what happened (cliAuditRowOf). At most 8 KB of a body is read: past
 * it the entry is refused, never parsed.
 */
import type * as http from "http";
import {
  cliAuditRowOf,
  isQueueId,
  type CliAuditRow,
} from "../../shared/audit-queue.js";
import { readBodyCapped } from "./http-helpers.js";

export const CLI_AUDIT_BODY_MAX = 8192;

export interface CliAuditDeps<A> {
  /** The credential's principal, or null without one. */
  principal: string | null | undefined;
  /** Its audit actor (an agent's id, or the person). */
  actor: A;
  /** True while this principal may send another entry this hour. */
  budget: (principal: string) => boolean;
  record: (actor: A, row: CliAuditRow, principal: string) => { ts: string };
  /** Its queued copy's id, so a copy left behind is dropped. */
  remember: (id: string) => void;
}

export async function cliAuditRequest<A>(
  req: http.IncomingMessage,
  d: CliAuditDeps<A>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const principal = d.principal;
  if (!principal) return { status: 401, body: { error: "sign in first" } };
  const raw = await readBodyCapped(req, CLI_AUDIT_BODY_MAX).catch(() => "");
  if (raw === null) return { status: 413, body: { error: "entry too large" } };
  let body: unknown;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }
  const v =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const row = v ? cliAuditRowOf(v) : null;
  if (!v || !row) return { status: 400, body: { error: "not an audit entry" } };
  if (!d.budget(principal))
    return { status: 429, body: { error: "too many audit entries this hour" } };
  const entry = d.record(d.actor, row, principal);
  if (isQueueId(v.id)) d.remember(v.id);
  return { status: 200, body: { recorded: true, ts: entry.ts } };
}
