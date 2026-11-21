/**
 * `<cli> web login` waits (SEC-2a; issue 819). The CLI mints the one-time
 * link, registers its nonce with the running server (its bearer, from the
 * person's own terminal: personCallerRefusal), and polls the wait by its
 * own id. Then:
 *
 *  - first run (first-run.ts: no person has ever signed in here), the link
 *    signs the browser that opens it in: the CLI is told who ("used");
 *  - from then on, the link opens the pairing screen (pair-requests.ts):
 *    the wait is "pairing" until a signed-in browser approves the device
 *    (Settings › Access) and it signs in ("used"), or denies it
 *    ("denied"), or the request runs out ("expired").
 *
 * A registered link is the only kind that signs in on first run from
 * another computer: registering needs the person's terminal, which a link
 * alone doesn't prove. In memory only; the nonce alone (without the link's
 * mac) signs nothing in. Clock injected.
 */
import { randomBytes } from "crypto";
import { normalizeConfirmCode } from "../../shared/confirm-code.js";

/** The most waits at once; a new one drops the oldest. */
export const MAX_LOGIN_WAITS = 10;
/** How long an ended wait still answers the CLI. */
const ENDED_KEEP_MS = 5 * 60_000;

export type LoginWaitState =
  | "waiting"
  /** Issue 819: opened; its device waits for a signed-in browser's approval. */
  | "pairing"
  | "used"
  | "denied"
  | "expired";

export interface LoginWaitView {
  state: LoginWaitState;
  /** pairing, used: the browser and OS that opened it, its address. */
  device?: string;
  client?: string;
  /** used: when it signed in. */
  usedAt?: number;
  expiresAt: number;
}

interface LoginWait extends LoginWaitView {
  id: string;
  nonce: string;
  createdAt: number;
  forgetAt?: number;
}

export class LoginWaits {
  private readonly byId = new Map<string, LoginWait>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * A wait for the link with this nonce (it must be opened by
   * `linkExpiresAt`). Its id is the CLI's to poll. `code`: an older CLI's
   * confirmation code, checked for shape and otherwise unused.
   */
  register(
    nonce: string,
    code: string | undefined,
    linkExpiresAt: number,
  ): string | null {
    if (code !== undefined && !normalizeConfirmCode(code)) return null;
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
      state: "waiting",
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

  /** Issue 819: the link was opened on the pairing screen, until `until`. */
  pairing(
    nonce: string,
    until: number,
    meta: { device: string; client?: string },
  ): void {
    const w = this.find(nonce);
    if (!w || w.state !== "waiting") return;
    w.state = "pairing";
    w.device = meta.device;
    if (meta.client) w.client = meta.client;
    w.expiresAt = until;
  }

  /** The link signed a browser in: the CLI is told who. */
  used(nonce: string, meta: { device: string; client?: string }): void {
    const w = this.find(nonce);
    if (!w || (w.state !== "waiting" && w.state !== "pairing")) return;
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

  private end(w: LoginWait, state: "used" | "denied" | "expired"): void {
    w.state = state;
    w.forgetAt = this.now() + ENDED_KEEP_MS;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, w] of this.byId) {
      if (
        (w.state === "waiting" || w.state === "pairing") &&
        now >= w.expiresAt
      )
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
