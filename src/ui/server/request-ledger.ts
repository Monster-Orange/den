/**
 * BUSY-1 / UK-2: the request ledger. The working pop-up sends each write with
 * an id of its own (X-Den-Request-Id). Den remembers how that request ended,
 * per signed-in person, so:
 *  - Try again with the same id runs the action once: a repeat while the
 *    first runs waits for it; a later repeat gets its answer again;
 *  - Check again asks GET /requests/<id> how it ended, and never resends.
 *
 * Finished requests are kept for `ttlMs` (requests.keep_minutes), at most
 * `maxEntries` of them, and on disk when `file` is set, so a restart keeps
 * them; a running one is never dropped, and never written.
 *
 * Never a secret: a sign-in, sign-out, link or token route keeps only its
 * state and code, and any field named token, secret, code or password is
 * [redacted] before an answer is kept.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "./request-guard.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { readStateJson } from "../../shared/state-backup.js";
import { getStateDir } from "../../shared/paths.js";

export interface LedgerAnswer {
  status: number;
  contentType?: string;
  /** The answer's body; absent when it was larger than the ledger keeps. */
  body?: Buffer;
}

export type LedgerBegin =
  | { kind: "new"; finish(answer: LedgerAnswer): void }
  | { kind: "wait"; done: Promise<LedgerAnswer> };

/** UK-2 Settled 1: how a request ended, as GET /requests/<id> says it. */
export type LedgerStatus =
  | { state: "running" }
  | { state: "done"; result?: unknown; finishedAt: string }
  | {
      state: "failed";
      error: { code: number; message: string };
      finishedAt: string;
    }
  | { state: "unknown" };

export interface RequestLedger {
  begin(
    owner: string,
    id: string,
    opts?: { secret?: boolean; action?: string },
  ): LedgerBegin;
  status(owner: string, id: string): LedgerStatus;
}

/** What the ledger keeps of a finished request (and writes to disk). */
interface Kept {
  status: number;
  contentType?: string;
  /** The answer, parsed and redacted; absent for a secret route or a big one. */
  json?: unknown;
  /** A failure's own words, when not a secret route. */
  message?: string;
  finishedAt: number;
}

interface Entry {
  done: Promise<LedgerAnswer>;
  kept?: Kept;
}

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** A request id the browser may choose: 8 to 64 letters, digits and dashes. */
export function validRequestId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

/**
 * A route whose answer may carry a sign-in, a session, a link or a token:
 * the ledger keeps only its state and code.
 */
export function secretRoute(pathname: string): boolean {
  return /(^|\/)(auth|attest|sign-?in|sign-?out|log-?in|log-?out|logins?|sessions?|pair|claim)(\/|$)|token|secret|password|link/i.test(
    pathname,
  );
}

const SECRET_KEY = /token|secret|password|^code$/i;

/** A copy of `v` with every field named like a secret replaced. */
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        SECRET_KEY.test(k) ? "[redacted]" : redact(x),
      ]),
    );
  return v;
}

/** A failure's own words: the answer's error or message, if it has one. */
function wordsOf(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const o = v as Record<string, unknown>;
  for (const k of ["error", "message"]) {
    if (typeof o[k] === "string") return o[k] as string;
    const inner = o[k] as Record<string, unknown> | undefined;
    if (inner && typeof inner.message === "string") return inner.message;
  }
  return "";
}

function keep(
  answer: LedgerAnswer,
  secret: boolean,
  maxBytes: number,
  at: number,
): Kept {
  const kept: Kept = {
    status: answer.status,
    contentType: answer.contentType,
    finishedAt: at,
  };
  if (secret || !answer.body || answer.body.length > maxBytes) return kept;
  if (!/json/i.test(answer.contentType ?? "")) return kept;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body.toString("utf8"));
  } catch {
    return kept;
  }
  if (answer.status >= 400) kept.message = wordsOf(parsed);
  kept.json = redact(parsed);
  return kept;
}

/** The answer a repeat gets: what was kept, never more. */
function replayOf(k: Kept): LedgerAnswer {
  return {
    status: k.status,
    contentType: k.json === undefined ? "application/json" : k.contentType,
    body:
      k.json === undefined
        ? Buffer.from(JSON.stringify({ ok: k.status < 400, replayed: true }))
        : Buffer.from(JSON.stringify(k.json)),
  };
}

export function createRequestLedger(opts: {
  ttlMs: () => number;
  maxEntries?: number | (() => number);
  maxAnswerBytes?: () => number;
  /** Where finished requests are kept across restarts (0600). */
  file?: string;
  /** The state folder `file` is in (default: Den's), for issue 786's backup. */
  stateDir?: string;
  /** One line per finished write: req=<id>, the action, the outcome. */
  log?: (line: string) => void;
  now?: () => number;
}): RequestLedger {
  const now = opts.now ?? Date.now;
  const max = (): number => {
    const m =
      typeof opts.maxEntries === "function"
        ? opts.maxEntries()
        : (opts.maxEntries ?? 2000);
    return Number.isFinite(m) && m > 0 ? m : 2000;
  };
  const maxBytes = (): number => {
    const m = opts.maxAnswerBytes?.() ?? 256 * 1024;
    return Number.isFinite(m) && m >= 0 ? m : 256 * 1024;
  };
  const entries = new Map<string, Entry>();
  const keyOf = (owner: string, id: string) => `${owner}\0${id}`;

  function prune(): boolean {
    const cutoff = now() - opts.ttlMs();
    let finished = 0;
    let dropped = false;
    for (const e of entries.values()) if (e.kept) finished++;
    // Map order is insertion order: the oldest first.
    for (const [k, e] of entries) {
      if (!e.kept) continue;
      if (e.kept.finishedAt < cutoff || finished > max()) {
        entries.delete(k);
        finished--;
        dropped = true;
      }
    }
    return dropped;
  }

  function save(): void {
    if (!opts.file) return;
    const rows = [...entries]
      .filter(([, e]) => e.kept)
      .map(([k, e]) => {
        const [owner, id] = k.split("\0");
        return { owner, id, ...e.kept };
      });
    try {
      fs.mkdirSync(path.dirname(opts.file), { recursive: true });
      writeFileAtomic(opts.file, JSON.stringify({ v: 1, rows }), {
        mode: 0o600,
      });
      fs.chmodSync(opts.file, 0o600);
    } catch {
      /* the ledger still works in memory */
    }
  }

  function load(): void {
    if (!opts.file) return;
    let rows: unknown;
    try {
      // Issue 786: a file that can't be parsed is kept in backup, not reset.
      const r = readStateJson(opts.stateDir ?? getStateDir(), opts.file);
      if (!r.ok) return;
      rows = ((r.value ?? {}) as { rows?: unknown }).rows;
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    for (const r of rows as (Kept & { owner?: unknown; id?: unknown })[]) {
      if (typeof r?.owner !== "string" || !validRequestId(r.id)) continue;
      if (typeof r.status !== "number" || typeof r.finishedAt !== "number")
        continue;
      const kept: Kept = {
        status: r.status,
        contentType: r.contentType,
        json: r.json,
        message: typeof r.message === "string" ? r.message : undefined,
        finishedAt: r.finishedAt,
      };
      entries.set(keyOf(r.owner, r.id), {
        kept,
        done: Promise.resolve(replayOf(kept)),
      });
    }
    if (prune()) save();
  }
  load();

  return {
    begin(owner, id, o = {}) {
      if (prune()) save();
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
          if (entry.kept) return;
          entry.kept = keep(answer, !!o.secret, maxBytes(), now());
          resolve(replayOf(entry.kept));
          if (o.action)
            opts.log?.(`req=${id} ${o.action} ${entry.kept.status}`);
          prune();
          save();
        },
      };
    },
    status(owner, id) {
      if (prune()) save();
      const e = entries.get(keyOf(owner, id));
      if (!e) return { state: "unknown" };
      if (!e.kept) return { state: "running" };
      const k = e.kept;
      const finishedAt = new Date(k.finishedAt).toISOString();
      if (k.status >= 400)
        return {
          state: "failed",
          error: { code: k.status, message: k.message ?? "" },
          finishedAt,
        };
      return k.json === undefined
        ? { state: "done", finishedAt }
        : { state: "done", result: k.json, finishedAt };
    },
  };
}

// ── HTTP glue ────────────────────────────────────────────────────────────────

/** The header the working pop-up sends its id in. */
export const REQUEST_ID_HEADER = "x-den-request-id";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Past this, the gate stops copying an answer (the ledger's own limit is a setting). */
const MAX_BODY = 16 * 1024 * 1024;

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
  const pathname = (req.url ?? "/").split("?")[0];
  const b = ledger.begin(owner, id, {
    secret: secretRoute(pathname),
    action: `${req.method} ${pathname}`,
  });
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
