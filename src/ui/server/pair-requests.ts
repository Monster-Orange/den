/**
 * SEC-2a: approve this computer with a code (reverse pairing). The
 * signed-out page asks for a request; the server keeps it in memory and
 * hands that page two things:
 *
 *  - a short code (`K7Q-42M`: six Crockford base32 characters, 30 bits)
 *    that a person who is already in (the CLI's bearer, `<cli> web approve
 *    <code>`, or a signed-in Settings › Access › Waiting devices) types or
 *    clicks to approve it. The code is never a credential by itself: it
 *    only names a request to someone already trusted;
 *  - a separate poll id (192 bits) that only that page holds. Once the
 *    request is approved, the page's poll with this id gets the session
 *    cookie, once.
 *
 * A request lasts 10 minutes and is single-use: claiming it (the cookie),
 * denying it, or its expiry ends it. At most `max` are pending at once; a
 * new one beyond that drops the oldest. Approve and deny attempts are
 * rate-limited (a guess of a code costs one): past `maxAttempts` in
 * `attemptWindowMs`, every attempt is refused until the window passes.
 *
 * Nothing is written to disk. Clock injected, so a test drives expiry.
 */
import { randomBytes, randomInt } from "crypto";
import { deviceName } from "../../shared/web-session.js";

/** How long a request waits for its approval. */
export const PAIR_TTL_MS = 10 * 60_000;
/** The most pending requests at once; a new one drops the oldest. */
export const MAX_PENDING_PAIRS = 5;
/** How long an ended request still answers its page (denied, expired). */
export const PAIR_ENDED_KEEP_MS = 60_000;
/** Approve or deny attempts allowed per window. */
export const MAX_APPROVE_ATTEMPTS = 10;
export const APPROVE_WINDOW_MS = 60_000;

/** Crockford's base32: no I, L, O or U. */
export const PAIR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN = 6;

/** A fresh code, unformatted (six characters of PAIR_ALPHABET). */
export function newPairCode(rand: (n: number) => number = randomInt): string {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += PAIR_ALPHABET[rand(32)];
  return s;
}

/** `K7Q42M` → `K7Q-42M`. */
export function formatPairCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/**
 * What a person typed, as a code: case-insensitive, dashes and spaces
 * ignored, and Crockford's look-alikes read as what they look like (O as
 * 0, I and L as 1). Null when it can't be a code.
 */
export function normalizePairCode(input: string): string | null {
  const s = String(input ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== CODE_LEN) return null;
  for (const c of s) if (!PAIR_ALPHABET.includes(c)) return null;
  return s;
}

export type PairState = "pending" | "approved" | "denied" | "expired";

/** What the approver sees of a request (and the page, of its own). */
export interface PairView {
  code: string;
  state: PairState;
  /** "Chrome on macOS", from the User-Agent. */
  device: string;
  /** The client's address, when Den knows it. */
  client?: string;
  createdAt: number;
  expiresAt: number;
}

interface PairRequest extends PairView {
  id: string;
  userAgent: string;
  /** When an ended request is forgotten. */
  forgetAt?: number;
}

export type ApproveResult =
  | { ok: true; request: PairView }
  | { ok: false; error: "malformed" | "unknown" | "expired" | "rate_limited" };

export class PairRequests {
  private readonly byId = new Map<string, PairRequest>();
  private readonly now: () => number;
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private attempts: number[] = [];

  constructor(
    opts: {
      now?: () => number;
      max?: number;
      ttlMs?: number;
      maxAttempts?: number;
      windowMs?: number;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.max = opts.max ?? MAX_PENDING_PAIRS;
    this.ttlMs = opts.ttlMs ?? PAIR_TTL_MS;
    this.maxAttempts = opts.maxAttempts ?? MAX_APPROVE_ATTEMPTS;
    this.windowMs = opts.windowMs ?? APPROVE_WINDOW_MS;
  }

  /** A new request: its poll id (the page's only), code and expiry. */
  create(meta: { userAgent?: string; client?: string }): {
    id: string;
    code: string;
    expiresAt: number;
  } {
    this.sweep();
    const pending = [...this.byId.values()]
      .filter((r) => r.state === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
    while (pending.length >= this.max) {
      const oldest = pending.shift()!;
      this.byId.delete(oldest.id);
    }
    const live = new Set([...this.byId.values()].map((r) => r.code));
    let code = newPairCode();
    while (live.has(code)) code = newPairCode();
    const now = this.now();
    const ua = String(meta.userAgent ?? "").slice(0, 300);
    const r: PairRequest = {
      id: randomBytes(24).toString("base64url"),
      code,
      state: "pending",
      device: deviceName(ua),
      userAgent: ua,
      ...(meta.client ? { client: String(meta.client).slice(0, 64) } : {}),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.byId.set(r.id, r);
    return { id: r.id, code: formatPairCode(code), expiresAt: r.expiresAt };
  }

  /** A request's view by its poll id, or null (unknown, or forgotten). */
  get(id: string): PairView | null {
    this.sweep();
    const r = this.byId.get(id);
    return r ? view(r) : null;
  }

  /** The requests waiting for approval, oldest first. */
  waiting(): PairView[] {
    this.sweep();
    return [...this.byId.values()]
      .filter((r) => r.state === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(view);
  }

  /** Approve the pending request with this code (as typed). */
  approve(input: string): ApproveResult {
    return this.decide(input, "approved");
  }

  /** Deny the pending request with this code: its page offers a new one. */
  deny(input: string): ApproveResult {
    return this.decide(input, "denied");
  }

  /**
   * An approved request, once, by its poll id: it is consumed, so a second
   * claim gets null (an approval makes one session).
   */
  claim(id: string): PairView | null {
    this.sweep();
    const r = this.byId.get(id);
    if (!r || r.state !== "approved") return null;
    this.byId.delete(id);
    return view(r);
  }

  /** Forget every request (the server is stopping). */
  clear(): void {
    this.byId.clear();
  }

  private decide(input: string, state: "approved" | "denied"): ApproveResult {
    const now = this.now();
    this.attempts = this.attempts.filter((t) => now - t < this.windowMs);
    if (this.attempts.length >= this.maxAttempts)
      return { ok: false, error: "rate_limited" };
    this.attempts.push(now);
    const code = normalizePairCode(input);
    if (!code) return { ok: false, error: "malformed" };
    this.sweep();
    const r = [...this.byId.values()].find((x) => x.code === code);
    if (!r) return { ok: false, error: "unknown" };
    if (r.state === "expired") return { ok: false, error: "expired" };
    if (r.state !== "pending") return { ok: false, error: "unknown" };
    r.state = state;
    if (state === "denied") r.forgetAt = now + PAIR_ENDED_KEEP_MS;
    return { ok: true, request: view(r) };
  }

  /** Expire requests past their time; forget ended ones. */
  private sweep(): void {
    const now = this.now();
    for (const [id, r] of this.byId) {
      if (
        (r.state === "pending" || r.state === "approved") &&
        now >= r.expiresAt
      ) {
        r.state = "expired";
        r.forgetAt = r.expiresAt + PAIR_ENDED_KEEP_MS;
      }
      if (r.forgetAt !== undefined && now >= r.forgetAt) this.byId.delete(id);
    }
  }
}

function view(r: PairRequest): PairView {
  return {
    code: formatPairCode(r.code),
    state: r.state,
    device: r.device,
    ...(r.client ? { client: r.client } : {}),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}
