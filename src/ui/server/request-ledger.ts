/**
 * BUSY-1: the request ledger. The working pop-up sends each write with an id
 * of its own (X-Den-Request-Id). Den remembers how that request ended, per
 * signed-in person, so:
 *  - Try again resends the same id and Den runs the action once: a repeat
 *    while the first runs waits for it; a later repeat gets its answer again;
 *  - Check again asks GET /api/requests/<id> how it ended, and never resends.
 *
 * Finished requests are kept for `ttlMs` (ui.request_memory_seconds) and at
 * most `maxEntries` of them; a running one is never dropped.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "./request-guard.js";

export interface LedgerAnswer {
  status: number;
  contentType?: string;
  /** The answer's body; absent when it was larger than the ledger keeps. */
  body?: Buffer;
}

export type LedgerBegin =
  | { kind: "new"; finish(answer: LedgerAnswer): void }
  | { kind: "wait"; done: Promise<LedgerAnswer> };

export type LedgerStatus =
  | { state: "running" }
  | { state: "done"; status: number }
  | { state: "unknown" };

export interface RequestLedger {
  begin(owner: string, id: string): LedgerBegin;
  status(owner: string, id: string): LedgerStatus;
}

interface Entry {
  done: Promise<LedgerAnswer>;
  answer?: LedgerAnswer;
  finishedAt?: number;
}

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** A request id the browser may choose: 8 to 64 letters, digits and dashes. */
export function validRequestId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

export function createRequestLedger(opts: {
  ttlMs: () => number;
  maxEntries?: number;
  now?: () => number;
}): RequestLedger {
  const now = opts.now ?? Date.now;
  const max = opts.maxEntries ?? 2000;
  const entries = new Map<string, Entry>();
  const keyOf = (owner: string, id: string) => `${owner}\0${id}`;

  function prune(): void {
    const cutoff = now() - opts.ttlMs();
    let finished = 0;
    for (const e of entries.values())
      if (e.finishedAt !== undefined) finished++;
    // Map order is insertion order: the oldest first.
    for (const [k, e] of entries) {
      if (e.finishedAt === undefined) continue;
      if (e.finishedAt < cutoff || finished > max) {
        entries.delete(k);
        finished--;
      }
    }
  }

  return {
    begin(owner, id) {
      prune();
      const key = keyOf(owner, id);
      const hit = entries.get(key);
      if (hit) return { kind: "wait", done: hit.done };
      let resolve!: (a: LedgerAnswer) => void;
      const entry: Entry = {
        done: new Promise<LedgerAnswer>((r) => (resolve = r)),
      };
      entries.set(key, entry);
      return {
        kind: "new",
        finish(answer) {
          if (entry.answer) return;
          entry.answer = answer;
          entry.finishedAt = now();
          resolve(answer);
          prune();
        },
      };
    },
    status(owner, id) {
      prune();
      const e = entries.get(keyOf(owner, id));
      if (!e) return { state: "unknown" };
      if (!e.answer) return { state: "running" };
      return { state: "done", status: e.answer.status };
    },
  };
}

// ── HTTP glue ────────────────────────────────────────────────────────────────

/** The header the working pop-up sends its id in. */
export const REQUEST_ID_HEADER = "x-den-request-id";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** The largest answer the ledger keeps to replay (a bigger one replays as ok). */
const MAX_BODY = 256 * 1024;

/** The browser's own id for this request, when it sent a valid one. */
export function clientRequestId(req: IncomingMessage): string | undefined {
  const v = req.headers[REQUEST_ID_HEADER];
  return validRequestId(v) ? v : undefined;
}

/**
 * Whose ids these are: a signed-in browser's session (hashed: the ledger
 * never holds the key itself), else the credential's actor, else this
 * computer's own browser.
 */
export function ledgerOwner(p: Principal | null | undefined): string {
  if (p?.kind === "person-browser" && p.session)
    return `s:${createHash("sha256").update(p.session).digest("hex").slice(0, 32)}`;
  if (p && "actor" in p && p.actor) return `a:${p.actor}`;
  return "local";
}

/**
 * Before a write's route runs. Without an id (or for a read) it returns
 * false and the route runs as before. With an id seen before, it answers
 * with the first request's answer (waiting for it if it still runs) and
 * returns true. With a new id it records the route's answer when the route
 * ends it, and returns false.
 */
export async function ledgerGate(
  ledger: RequestLedger,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
): Promise<boolean> {
  if (!WRITES.has(req.method ?? "")) return false;
  const id = clientRequestId(req);
  if (!id) return false;
  const b = ledger.begin(owner, id);
  if (b.kind === "wait") {
    const a = await b.done;
    req.resume();
    if (!res.headersSent)
      res.writeHead(a.status, {
        "Content-Type": a.contentType ?? "application/json",
        "Cache-Control": "no-store",
        "X-Den-Replayed": "1",
      });
    res.end(a.body ?? JSON.stringify({ ok: a.status < 400, replayed: true }));
    return true;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let kept = true;
  const keep = (c: unknown, enc?: unknown) => {
    if (!kept || c == null || typeof c === "function") return;
    const buf = Buffer.isBuffer(c)
      ? c
      : Buffer.from(
          c as string,
          typeof enc === "string" ? (enc as BufferEncoding) : "utf8",
        );
    size += buf.length;
    if (size > MAX_BODY) {
      kept = false;
      chunks.length = 0;
    } else chunks.push(buf);
  };
  // The route may name its type in writeHead's headers, which getHeader
  // never sees.
  let type: string | undefined;
  const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => unknown;
  (res as { writeHead: unknown }).writeHead = (...a: unknown[]) => {
    const h = a.find((x) => x && typeof x === "object" && !Array.isArray(x));
    if (h)
      for (const [k, v] of Object.entries(h as Record<string, unknown>))
        if (k.toLowerCase() === "content-type" && typeof v === "string")
          type = v;
    return writeHead(...a);
  };
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
  (res as { write: unknown }).write = (...a: unknown[]) => {
    keep(a[0], a[1]);
    return write(...a);
  };
  (res as { end: unknown }).end = (...a: unknown[]) => {
    keep(a[0], a[1]);
    const out = end(...a);
    const ct = type ?? res.getHeader("content-type");
    b.finish({
      status: res.statusCode,
      contentType: typeof ct === "string" ? ct : undefined,
      body: kept ? Buffer.concat(chunks) : undefined,
    });
    return out;
  };
  return false;
}
