/**
 * SEC-2a: approve this computer with a code (reverse pairing). The
 * signed-out page asks for a request; the server keeps it in memory and
 * hands that page two things:
 *
 *  - a short code (`K7Q-42M`: six Crockford base32 characters, 30 bits)
 *    that a person in a browser already signed in types to approve it
 *    (issue 819: read off the new device's own screen; the waiting list
 *    never shows it, so approving needs that screen). The code is never a
 *    credential by itself: it only names a request to someone already
 *    trusted;
 *  - a public handle (`ref`) the waiting list names it by;
 *  - a separate poll id (192 bits) that only that page holds. Once the
 *    request is approved, the page's poll with this id gets the session
 *    cookie, once.
 *
 * A request lasts 10 minutes and is single-use: claiming it (the cookie),
 * denying it, or its expiry ends it. At most `max` are pending at once; a
 * new one beyond that drops the oldest one no sign-in link opened (issue
 * 819: a link's request is never dropped for one without), and each
 * client address may make `perClient` a minute. Approve and deny attempts
 * are rate-limited: a wrong code typed for a live request, or a code that
 * names none, costs one; a request that ended, expired or was already
 * decided doesn't (a person's own stale dialog). Past `maxAttempts` in
 * the window, every attempt is refused until the window passes.
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
/** Approve or deny attempts allowed per window (web.approve_attempts). */
export const MAX_APPROVE_ATTEMPTS = 10;
/** The approve limit's window (web.approve_window_seconds): short. */
export const APPROVE_WINDOW_MS = 30_000;
/** New requests a minute from one client address (web.pair_requests_per_minute). */
export const MAX_PAIRS_PER_CLIENT_MINUTE = 30;

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
  /** Issue 819: the public handle the waiting list names it by (never the code). */
  ref: string;
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
  /** Issue 819: when the `web login` run whose link opened it began. */
  linkAt?: number;
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
      error:
        | "malformed"
        | "unknown"
        | "expired"
        | "ended"
        | "wrong"
        | "rate_limited";
    };

/** What a person typed (the code), for the request they chose (its ref). */
export type Decision = string | { code?: string; ref?: string };

export type CreateResult =
  | { ok: true; id: string; ref: string; code: string; expiresAt: number }
  | { ok: false; error: "rate_limited" | "full" };

/** A limit read when it is used (a Setting), or a fixed number. */
type Live = number | (() => number);
const live = (v: Live): number => (typeof v === "function" ? v() : v);

export class PairRequests {
  private readonly byId = new Map<string, PairRequest>();
  private readonly now: () => number;
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly maxAttempts: Live;
  private readonly windowMs: Live;
  private readonly perClient: Live;
  private readonly unseenMs: number;
  private attempts: number[] = [];
  private madeBy = new Map<string, number[]>();

  constructor(
    opts: {
      now?: () => number;
      max?: number;
      ttlMs?: number;
      maxAttempts?: Live;
      windowMs?: Live;
      /** New requests a minute from one client address. */
      perClient?: Live;
      unseenMs?: number;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.max = opts.max ?? MAX_PENDING_PAIRS;
    this.ttlMs = opts.ttlMs ?? PAIR_TTL_MS;
    this.maxAttempts = opts.maxAttempts ?? MAX_APPROVE_ATTEMPTS;
    this.windowMs = opts.windowMs ?? APPROVE_WINDOW_MS;
    this.perClient = opts.perClient ?? MAX_PAIRS_PER_CLIENT_MINUTE;
    this.unseenMs = opts.unseenMs ?? PAIR_UNSEEN_MS;
  }

  /** A new request: its poll id (the page's only), handle, code and expiry. */
  create(meta: {
    userAgent?: string;
    client?: string;
    link?: string;
    linkAt?: number;
  }): { id: string; ref: string; code: string; expiresAt: number } {
    const r = this.tryCreate(meta);
    if (!r.ok) throw new Error(`no request: ${r.error}`);
    return r;
  }

  /**
   * A new request, unless its client address made too many this minute
   * ("rate_limited"), or every pending slot holds a request a sign-in link
   * opened and this one has none ("full"). Issue 819: past the cap, the
   * oldest without a link goes first; a link's request goes only for
   * another link's.
   */
  tryCreate(meta: {
    userAgent?: string;
    client?: string;
    link?: string;
    linkAt?: number;
  }): CreateResult {
    this.sweep();
    const now = this.now();
    const who = String(meta.client ?? "");
    const made = (this.madeBy.get(who) ?? []).filter((t) => now - t < 60_000);
    if (made.length >= live(this.perClient)) {
      this.madeBy.set(who, made);
      return { ok: false, error: "rate_limited" };
    }
    const pending = [...this.byId.values()]
      .filter((r) => r.state === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
    while (pending.length >= this.max) {
      const i = pending.findIndex((r) => !r.link);
      if (i < 0 && !meta.link) return { ok: false, error: "full" };
      const [gone] = pending.splice(i < 0 ? 0 : i, 1);
      this.byId.delete(gone.id);
    }
    made.push(now);
    this.madeBy.set(who, made);
    if (this.madeBy.size > 1000)
      for (const [k, v] of this.madeBy)
        if (!v.some((t) => now - t < 60_000)) this.madeBy.delete(k);
    const liveCodes = new Set([...this.byId.values()].map((r) => r.code));
    let code = newPairCode();
    while (liveCodes.has(code)) code = newPairCode();
    const ua = String(meta.userAgent ?? "").slice(0, 300);
    const r: PairRequest = {
      id: randomBytes(24).toString("base64url"),
      ref: randomBytes(12).toString("base64url"),
      code,
      state: "pending",
      device: deviceName(ua),
      userAgent: ua,
      ...(meta.client ? { client: String(meta.client).slice(0, 64) } : {}),
      ...(meta.link ? { link: String(meta.link).slice(0, 64) } : {}),
      ...(meta.link && meta.linkAt ? { linkAt: meta.linkAt } : {}),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      seenAt: now,
    };
    this.byId.set(r.id, r);
    return {
      ok: true,
      id: r.id,
      ref: r.ref,
      code: formatPairCode(code),
      expiresAt: r.expiresAt,
    };
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
   * The requests waiting for approval: pending, so its page is still
   * asking (D67, issue 320: sweep ended any a closed tab left, the same
   * rule decide() goes by). Issue 819: those a sign-in link opened first,
   * then the newest first.
   */
  waiting(): PairView[] {
    this.sweep();
    return [...this.byId.values()]
      .filter((r) => r.state === "pending")
      .sort(
        (a, b) =>
          Number(!!b.link) - Number(!!a.link) || b.createdAt - a.createdAt,
      )
      .map(view);
  }

  /**
   * Approve the pending request with this code (as typed), or (issue 819)
   * the one with this handle when the typed code is its own.
   */
  approve(input: Decision): ApproveResult {
    return this.decide(input, "approved");
  }

  /**
   * Deny the pending request with this code, or this handle (no code
   * needed: denying lets nothing in). Its page offers a new one.
   */
  deny(input: Decision): ApproveResult {
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

  private decide(input: Decision, state: "approved" | "denied"): ApproveResult {
    const now = this.now();
    const windowMs = live(this.windowMs);
    this.attempts = this.attempts.filter((t) => now - t < windowMs);
    if (this.attempts.length >= live(this.maxAttempts))
      return { ok: false, error: "rate_limited" };
    const typed = typeof input === "string" ? { code: input } : input;
    const r =
      typed.ref !== undefined
        ? this.byRef(String(typed.ref), typed.code, state === "denied")
        : this.match(String(typed.code ?? ""));
    if (!r.ok) {
      // A guess costs an attempt: a wrong code for a live request, or a
      // code that names none. A request that ended (a stale dialog) or a
      // malformed entry doesn't.
      if (r.error === "wrong" || (r.error === "unknown" && !typed.ref))
        this.attempts.push(now);
      return r;
    }
    r.request.state = state;
    if (state === "denied") r.request.forgetAt = now + PAIR_ENDED_KEEP_MS;
    return { ok: true, request: view(r.request) };
  }

  /**
   * Issue 819: the request with this handle, when the typed code is its
   * own (constant time). `codeOptional`: deny needs no code.
   */
  private byRef(
    ref: string,
    input: string | undefined,
    codeOptional: boolean,
  ):
    | { ok: true; request: PairRequest }
    | {
        ok: false;
        error: "malformed" | "unknown" | "expired" | "ended" | "wrong";
      } {
    const code =
      input === undefined && codeOptional
        ? ""
        : normalizePairCode(String(input ?? ""));
    if (code === null) return { ok: false, error: "malformed" };
    this.sweep();
    const r = [...this.byId.values()].find((x) => x.ref === ref);
    if (!r) return { ok: false, error: "unknown" };
    if (r.state === "expired") return { ok: false, error: "expired" };
    if (r.state === "withdrawn") return { ok: false, error: "ended" };
    if (r.state !== "pending") return { ok: false, error: "ended" };
    if (code) {
      const want = Buffer.from(code);
      const have = Buffer.from(r.code);
      if (have.length !== want.length || !timingSafeEqual(have, want))
        return { ok: false, error: "wrong" };
    }
    return { ok: true, request: r };
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
    ref: r.ref,
    state: r.state,
    device: r.device,
    ...(r.client ? { client: r.client } : {}),
    ...(r.link ? { link: r.link } : {}),
    ...(r.linkAt ? { linkAt: r.linkAt } : {}),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}
