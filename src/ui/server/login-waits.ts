/**
 * SEC-2a: `<cli> web login` waits, and its link asks for a code (SEC-2
 * spec, "Seeing that you're signed in"). The CLI mints the one-time link
 * as before, makes an 8-character confirmation code, and registers both
 * with the running server (its bearer): the link's nonce and a hash of the
 * code. Then:
 *
 *  - the link (GET /auth) no longer signs in by itself: it opens a page
 *    that asks for the code, so a leaked link alone is useless. Opening it
 *    starts a 5-minute window to type the code;
 *  - the page posts the code; the right one signs the browser in (the link
 *    is consumed: still single-use), a wrong one is refused. Five wrong
 *    codes burn the link; past 20 wrong codes a minute (any link), every
 *    attempt waits;
 *  - the CLI polls the wait by its own id and prints who signed in, or
 *    that nobody did.
 *
 * In memory only. The code is kept as a hash and never logged; the nonce
 * alone (without the link's mac) signs nothing in. Clock injected.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { normalizeConfirmCode } from "../../shared/confirm-code.js";

export {
  newConfirmCode,
  normalizeConfirmCode,
} from "../../shared/confirm-code.js";

/** How long an opened link's page waits for its code. */
export const CONFIRM_WINDOW_MS = 5 * 60_000;
/** Wrong codes before a link is burned. */
export const MAX_WRONG_PER_LINK = 5;
/** Wrong codes a minute, all links together, before every attempt waits. */
export const MAX_WRONG_PER_MINUTE = 20;
/** The most waits at once; a new one drops the oldest. */
export const MAX_LOGIN_WAITS = 10;
/** How long an ended wait still answers the CLI. */
const ENDED_KEEP_MS = 5 * 60_000;

const hash = (s: string) => createHash("sha256").update(s).digest();

export type LoginWaitState =
  | "waiting"
  | "opened"
  | "used"
  | "expired"
  | "refused";

export interface LoginWaitView {
  state: LoginWaitState;
  /** used: the browser and OS that signed in, its address, and when. */
  device?: string;
  client?: string;
  usedAt?: number;
  expiresAt: number;
}

interface LoginWait extends LoginWaitView {
  id: string;
  nonce: string;
  codeHash: Buffer;
  createdAt: number;
  openedAt?: number;
  wrong: number;
  forgetAt?: number;
}

export type ConfirmResult =
  | { ok: true }
  | {
      ok: false;
      error: "wrong" | "refused" | "expired" | "rate_limited";
      left?: number;
    };

export class LoginWaits {
  private readonly byId = new Map<string, LoginWait>();
  private readonly now: () => number;
  private wrongAt: number[] = [];

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * A wait for the link with this nonce (it must be opened by `linkExpiresAt`),
   * confirmed by `code`. Its id is the CLI's to poll.
   */
  register(nonce: string, code: string, linkExpiresAt: number): string | null {
    const norm = normalizeConfirmCode(code);
    if (!norm || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return null;
    this.sweep();
    const live = [...this.byId.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    while (live.length >= MAX_LOGIN_WAITS) this.byId.delete(live.shift()!.id);
    const id = randomBytes(24).toString("base64url");
    this.byId.set(id, {
      id,
      nonce,
      codeHash: hash(norm),
      state: "waiting",
      createdAt: this.now(),
      expiresAt: linkExpiresAt,
      wrong: 0,
    });
    return id;
  }

  /** A wait by its id (the CLI's poll). */
  get(id: string): LoginWaitView | null {
    this.sweep();
    const w = this.byId.get(id);
    return w ? view(w) : null;
  }

  /** The wait for a link's nonce, still open to use, or null. */
  forNonce(nonce: string): (LoginWaitView & { openedAt?: number }) | null {
    this.sweep();
    const w = this.find(nonce);
    return w
      ? { ...view(w), ...(w.openedAt ? { openedAt: w.openedAt } : {}) }
      : null;
  }

  /** Whether a link with this nonce has a wait at all (any state). */
  has(nonce: string): boolean {
    return !!this.find(nonce);
  }

  /** The link was opened: its code window starts (once). */
  open(nonce: string): void {
    this.sweep();
    const w = this.find(nonce);
    if (!w || w.state !== "waiting") return;
    const now = this.now();
    w.state = "opened";
    w.openedAt = now;
    w.expiresAt = now + CONFIRM_WINDOW_MS;
  }

  /** The page's code for this link. */
  confirm(nonce: string, typed: string): ConfirmResult {
    this.sweep();
    const now = this.now();
    const w = this.find(nonce);
    if (!w || w.state === "used") return { ok: false, error: "expired" };
    if (w.state === "expired") return { ok: false, error: "expired" };
    if (w.state === "refused") return { ok: false, error: "refused" };
    this.wrongAt = this.wrongAt.filter((t) => now - t < 60_000);
    if (this.wrongAt.length >= MAX_WRONG_PER_MINUTE)
      return { ok: false, error: "rate_limited" };
    const norm = normalizeConfirmCode(typed);
    const given = hash(norm ?? `\u0000${typed}`);
    if (norm && timingSafeEqual(given, w.codeHash)) return { ok: true };
    this.wrongAt.push(now);
    w.wrong++;
    if (w.wrong >= MAX_WRONG_PER_LINK) {
      this.end(w, "refused");
      return { ok: false, error: "refused" };
    }
    return { ok: false, error: "wrong", left: MAX_WRONG_PER_LINK - w.wrong };
  }

  /** The link signed a browser in: the CLI is told who. */
  used(nonce: string, meta: { device: string; client?: string }): void {
    const w = this.find(nonce);
    if (!w) return;
    w.device = meta.device;
    if (meta.client) w.client = meta.client;
    w.usedAt = this.now();
    this.end(w, "used");
  }

  private find(nonce: string): LoginWait | undefined {
    for (const w of this.byId.values()) if (w.nonce === nonce) return w;
    return undefined;
  }

  private end(w: LoginWait, state: "used" | "expired" | "refused"): void {
    w.state = state;
    w.forgetAt = this.now() + ENDED_KEEP_MS;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, w] of this.byId) {
      if ((w.state === "waiting" || w.state === "opened") && now >= w.expiresAt)
        this.end(w, "expired");
      if (w.forgetAt !== undefined && now >= w.forgetAt) this.byId.delete(id);
    }
  }
}

function view(w: LoginWait): LoginWaitView {
  return {
    state: w.state,
    ...(w.device ? { device: w.device } : {}),
    ...(w.client ? { client: w.client } : {}),
    ...(w.usedAt ? { usedAt: w.usedAt } : {}),
    expiresAt: w.expiresAt,
  };
}
