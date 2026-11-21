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
 * rate-limited (a miss, as a guess of a code, costs one; issue 819: a
 * pending request decided doesn't): past `maxAttempts` in the window,
 * every attempt is refused until the window passes.
 *
 * Nothing is written to disk. Clock injected, so a test drives expiry.
 */
import { randomBytes, randomInt, timingSafeEqual } from "crypto";
import { PAIR_ALPHABET } from "../../shared/confirm-code.js";
import { deviceName } from "../../shared/web-session.js";

/** How long a request waits for its approval. */
export const PAIR_TTL_MS = 10 * 60_000;
/**
 * D67: a pending request whose page hasn't polled for this long isn't
 * waiting for anyone (its tab closed, or signed in another way). Issue
 * 320: it has ended, as if its page withdrew it: Safari drops the
 * keepalive DELETE a closing page sends, and a closed tab may send
 * nothing, so the server can't wait to be told. The signed-in browsers'
 * "Allow this computer?" never shows it, and approving its code says it
 * ended. The page polls every 1.5 s; a background tab, at worst once a
 * minute after five: its late poll gets "gone", and it makes a new code by
 * itself. DEN_PAIR_UNSEEN_MS (ms, > 0) sets it (pairUnseenMs).
 */
export const PAIR_UNSEEN_MS = 15_000;

/** The unseen bound: DEN_PAIR_UNSEEN_MS (ms, > 0), else PAIR_UNSEEN_MS. */
export function pairUnseenMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DEN_PAIR_UNSEEN_MS);
  return Number.isFinite(n) && n > 0 ? n : PAIR_UNSEEN_MS;
}
/** The most pending requests at once; a new one drops the oldest. */
export const MAX_PENDING_PAIRS = 5;
/**
 * #320: the most withdrawn requests kept to say "ended" (a signed-out page
 * can make and withdraw many); past it, the oldest is forgotten.
 */
export const MAX_WITHDRAWN_KEPT = 20;
/** How long an ended request still answers its page (denied, expired). */
export const PAIR_ENDED_KEEP_MS = 60_000;
/** Approve or deny attempts allowed per window. */
export const MAX_APPROVE_ATTEMPTS = 10;
export const APPROVE_WINDOW_MS = 60_000;

export { PAIR_ALPHABET };
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

export type PairState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  /** #320: its page withdrew it (closed, or signed in another way). */
  | "withdrawn";

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
  /**
   * Issue 819: the sign-in link this request came from (its nonce), when a
   * link opened it. Den's own: never sent to a page or the approver.
   */
  link?: string;
}

interface PairRequest extends PairView {
  id: string;
  userAgent: string;
  /** When an ended request is forgotten. */
  forgetAt?: number;
  /** D67: when its page last asked for it (create, poll). */
  seenAt: number;
}

export type ApproveResult =
  | { ok: true; request: PairView }
  | {
      ok: false;
      error: "malformed" | "unknown" | "expired" | "ended" | "rate_limited";
    };

export class PairRequests {
  private readonly byId = new Map<string, PairRequest>();
  private readonly now: () => number;
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly unseenMs: number;
  private attempts: number[] = [];

  constructor(
    opts: {
      now?: () => number;
      max?: number;
      ttlMs?: number;
      maxAttempts?: number;
      windowMs?: number;
      unseenMs?: number;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.max = opts.max ?? MAX_PENDING_PAIRS;
    this.ttlMs = opts.ttlMs ?? PAIR_TTL_MS;
    this.maxAttempts = opts.maxAttempts ?? MAX_APPROVE_ATTEMPTS;
    this.windowMs = opts.windowMs ?? APPROVE_WINDOW_MS;
    this.unseenMs = opts.unseenMs ?? PAIR_UNSEEN_MS;
  }

  /** A new request: its poll id (the page's only), code and expiry. */
  create(meta: { userAgent?: string; client?: string; link?: string }): {
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
      ...(meta.link ? { link: String(meta.link).slice(0, 64) } : {}),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      seenAt: now,
    };
    this.byId.set(r.id, r);
    return { id: r.id, code: formatPairCode(code), expiresAt: r.expiresAt };
  }

  /** A request's view by its poll id, or null (unknown, or forgotten). */
  get(id: string): PairView | null {
    this.sweep();
    const r = this.byId.get(id);
    if (!r || r.state === "withdrawn") return null;
    r.seenAt = this.now();
    return view(r);
  }

  /**
   * D67: its page is going (closed, or signed in another way): a pending
   * request ends at once, by its poll id. Whether there was one. #320: it
   * is kept a minute as withdrawn, so an Allow on it (a dialog opened just
   * before) says it ended instead of "no such code".
   */
  withdraw(id: string): boolean {
    this.sweep();
    const r = this.byId.get(id);
    if (!r || r.state !== "pending") return false;
    this.end(r);
    return true;
  }

  /** A pending request ends as withdrawn: kept a minute, at most so many. */
  private end(r: PairRequest): void {
    const kept = [...this.byId.values()]
      .filter((x) => x.state === "withdrawn")
      .sort((x, y) => (x.forgetAt ?? 0) - (y.forgetAt ?? 0));
    while (kept.length >= MAX_WITHDRAWN_KEPT)
      this.byId.delete(kept.shift()!.id);
    r.state = "withdrawn";
    r.forgetAt = this.now() + PAIR_ENDED_KEEP_MS;
  }

  /**
   * The requests waiting for approval, oldest first: pending, so its page
   * is still asking (D67, issue 320: sweep ended any a closed tab left,
   * the same rule decide() goes by).
   */
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
    const r = this.match(input);
    // Issue 819: a miss costs an attempt (a guess of a code is one); a
    // pending request decided doesn't.
    if (!r.ok) {
      this.attempts.push(now);
      return r;
    }
    r.request.state = state;
    if (state === "denied") r.request.forgetAt = now + PAIR_ENDED_KEEP_MS;
    return { ok: true, request: view(r.request) };
  }

  /** The pending request with this code (as typed), or why there is none. */
  private match(
    input: string,
  ):
    | { ok: true; request: PairRequest }
    | { ok: false; error: "malformed" | "unknown" | "expired" | "ended" } {
    const code = normalizePairCode(input);
    if (!code) return { ok: false, error: "malformed" };
    this.sweep();
    // Constant time, whichever request it is (issue 819).
    const want = Buffer.from(code);
    let r: PairRequest | undefined;
    for (const x of this.byId.values()) {
      const have = Buffer.from(x.code);
      if (have.length === want.length && timingSafeEqual(have, want) && !r)
        r = x;
    }
    if (!r) return { ok: false, error: "unknown" };
    if (r.state === "expired") return { ok: false, error: "expired" };
    if (r.state === "withdrawn") return { ok: false, error: "ended" };
    if (r.state !== "pending") return { ok: false, error: "unknown" };
    return { ok: true, request: r };
  }

  /**
   * Expire requests past their time; end pending ones their page stopped
   * asking for (issue 320: PAIR_UNSEEN_MS); forget ended ones.
   */
  private sweep(): void {
    const now = this.now();
    for (const r of this.byId.values())
      if (
        r.state === "pending" &&
        now < r.expiresAt &&
        now - r.seenAt >= this.unseenMs
      )
        this.end(r);
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
    ...(r.link ? { link: r.link } : {}),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}
