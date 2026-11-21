/**
 * `<cli> web login` waits (SEC-2a; issue 819). The CLI mints the one-time
 * link and a confirmation code, registers both with the running server
 * (its bearer, from the person's own terminal: personCallerRefusal): the
 * link's nonce and a hash of the code. It polls the wait by its own id.
 * Then:
 *
 *  - first run (first-run.ts: no person has ever signed in here), the link
 *    signs in a browser on this computer at once ("used"). Opened anywhere
 *    else, its page asks for the confirmation code the CLI printed (the
 *    person's terminal proves it is theirs): the right code signs in, five
 *    wrong ones end the link ("refused");
 *  - from then on, the link opens the pairing screen (pair-requests.ts):
 *    the wait is "pairing" (with the device and address, never the code:
 *    that stays on the new device's screen, where the person reads it),
 *    until a signed-in browser approves the device and it signs in
 *    ("used"), or denies it ("denied"), or the request runs out
 *    ("expired").
 *
 * In memory only. The confirmation code is kept as a hash and never
 * logged; the nonce alone (without the link's mac) signs nothing in.
 * Clock injected.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { normalizeConfirmCode } from "../../shared/confirm-code.js";

/** The most waits at once; a new one drops the oldest. */
export const MAX_LOGIN_WAITS = 10;
/** How long an ended wait still answers the CLI. */
const ENDED_KEEP_MS = 5 * 60_000;
/** First run, away from this computer: how long an opened link's page waits for its code. */
export const CONFIRM_WINDOW_MS = 5 * 60_000;
/** Wrong confirmation codes before a link is ended. */
export const MAX_WRONG_PER_LINK = 5;
/** Wrong confirmation codes a minute, all links together, before every attempt waits. */
export const MAX_WRONG_PER_MINUTE = 20;

const hash = (s: string) => createHash("sha256").update(s).digest();

export type LoginWaitState =
  | "waiting"
  /** First run, opened away from this computer: its page asks for the code. */
  | "opened"
  /** Issue 819: opened; its device waits for a signed-in browser's approval. */
  | "pairing"
  | "used"
  | "denied"
  /** Too many wrong confirmation codes: the link no longer works. */
  | "refused"
  | "expired";

export interface LoginWaitView {
  state: LoginWaitState;
  /** pairing, used: the browser and OS that opened it, its address. */
  device?: string;
  client?: string;
  /** used: when it signed in. */
  usedAt?: number;
  /** When the CLI registered it (the `web login` run began). */
  startedAt: number;
  /** opened: when its page first asked for the code (the link is checked as of then). */
  openedAt?: number;
  expiresAt: number;
  /** Whether a confirmation code was registered with it. */
  confirmable: boolean;
}

interface LoginWait {
  id: string;
  nonce: string;
  state: LoginWaitState;
  device?: string;
  client?: string;
  usedAt?: number;
  openedAt?: number;
  codeHash?: Buffer;
  wrong: number;
  createdAt: number;
  expiresAt: number;
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
   * A wait for the link with this nonce (it must be opened by
   * `linkExpiresAt`). Its id is the CLI's to poll. `code`: the
   * confirmation code the CLI printed, kept as a hash (an older or
   * minimal caller may leave it off: then a first-run link opened away
   * from this computer can't be finished there).
   */
  register(
    nonce: string,
    code: string | undefined,
    linkExpiresAt: number,
  ): string | null {
    const norm = code === undefined ? null : normalizeConfirmCode(code);
    if (code !== undefined && !norm) return null;
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return null;
    this.sweep();
    if (this.find(nonce)) return null;
    const live = [...this.byId.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    while (live.length >= MAX_LOGIN_WAITS) this.byId.delete(live.shift()!.id);
    const id = randomBytes(24).toString("base64url");
    this.byId.set(id, {
      id,
      nonce,
      ...(norm ? { codeHash: hash(norm) } : {}),
      state: "waiting",
      wrong: 0,
      createdAt: this.now(),
      expiresAt: linkExpiresAt,
    });
    return id;
  }

  /** A wait by its id (the CLI's poll). */
  get(id: string): LoginWaitView | null {
    this.sweep();
    const w = this.byId.get(id);
    return w ? view(w) : null;
  }

  /** The wait for a link's nonce (any state), or null. */
  forNonce(nonce: string): LoginWaitView | null {
    this.sweep();
    const w = this.find(nonce);
    return w ? view(w) : null;
  }

  /** First run, away from this computer: its page asks for the code (the window starts once). */
  open(nonce: string): void {
    this.sweep();
    const w = this.find(nonce);
    if (!w || w.state !== "waiting") return;
    w.state = "opened";
    w.openedAt = this.now();
    // Opened in time: the code window runs from now (the link is checked
    // as of the moment it was opened).
    w.expiresAt = this.now() + CONFIRM_WINDOW_MS;
  }

  /** The page's confirmation code for this link (constant time). */
  confirm(nonce: string, typed: string): ConfirmResult {
    this.sweep();
    const now = this.now();
    const w = this.find(nonce);
    if (!w || w.state === "expired" || w.state === "used")
      return { ok: false, error: "expired" };
    if (w.state === "refused") return { ok: false, error: "refused" };
    if (w.state !== "opened" || !w.codeHash)
      return { ok: false, error: "expired" };
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

  /** Issue 819: the link was opened on the pairing screen, until `until`. */
  pairing(
    nonce: string,
    until: number,
    meta: { device: string; client?: string },
  ): void {
    const w = this.find(nonce);
    if (!w || (w.state !== "waiting" && w.state !== "opened")) return;
    w.state = "pairing";
    w.device = meta.device;
    if (meta.client) w.client = meta.client;
    w.expiresAt = until;
  }

  /** The link signed a browser in: the CLI is told who. */
  used(nonce: string, meta: { device: string; client?: string }): void {
    const w = this.find(nonce);
    if (
      !w ||
      (w.state !== "waiting" && w.state !== "opened" && w.state !== "pairing")
    )
      return;
    w.device = meta.device;
    if (meta.client) w.client = meta.client;
    w.usedAt = this.now();
    this.end(w, "used");
  }

  /** Issue 819: a signed-in browser denied the device the link opened. */
  denied(nonce: string): void {
    const w = this.find(nonce);
    if (!w || w.state !== "pairing") return;
    this.end(w, "denied");
  }

  private find(nonce: string): LoginWait | undefined {
    for (const w of this.byId.values()) if (w.nonce === nonce) return w;
    return undefined;
  }

  private end(
    w: LoginWait,
    state: "used" | "denied" | "refused" | "expired",
  ): void {
    w.state = state;
    w.forgetAt = this.now() + ENDED_KEEP_MS;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, w] of this.byId) {
      if (
        (w.state === "waiting" ||
          w.state === "opened" ||
          w.state === "pairing") &&
        now >= w.expiresAt
      ) {
        this.end(w, "expired");
      }
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
    startedAt: w.createdAt,
    ...(w.openedAt ? { openedAt: w.openedAt } : {}),
    expiresAt: w.expiresAt,
    confirmable: !!w.codeHash,
  };
}
