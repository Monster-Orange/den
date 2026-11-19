/**
 * Whether Den's own named https address works, so the session lives only
 * there (session-cookie.ts): a loopback name then gets no session, and a
 * session made on one counts on no host (request-guard.ts).
 *
 * The address (web.url) must be https. It is proven when:
 *  - the address check (address-check.ts, the identity probe through the
 *    address) finds this Den there, or
 *  - the edge brings a proven https request for that host here.
 * Proven is sticky. A check that can't tell (a timeout) keeps it, so a
 * stalled check can't reopen loopback. Only a definite failure (another
 * server, or nothing, answers), seen web.address_check_drop_after times in
 * a row, moves it back. The check runs again in the background every
 * web.address_check_cache_seconds, one at a time.
 *
 * Never proven: it doesn't work, and sign-in stays where the person is,
 * so an install with no working https address (or one whose first check
 * hasn't answered yet) is never locked out. What was signed in on a
 * loopback name meanwhile ends at the proof (onProven).
 *
 * onProven runs each time it becomes proven: the server ends every
 * session made on a loopback name then.
 */

/** How the address answered the check (address-check.ts's WantedAnswer). */
export type NamedAnswer = "den" | "other" | "nothing" | "unknown";

export interface NamedWatchDeps {
  /** web.url now, or null. */
  webUrl: () => string | null;
  /** Check the address now. */
  probe: (url: string) => Promise<NamedAnswer>;
  /** web.address_check_cache_seconds, in ms. */
  cacheMs: () => number;
  /** web.address_check_drop_after. */
  dropAfter: () => number;
  /** It just became proven. */
  onProven?: () => void;
  now?: () => number;
}

/** `url` when it is an https origin; else null (unset, http, not a URL). */
export function httpsAddress(url: string | null): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

export class NamedAddressWatch {
  /** The address this state is about (a new web.url starts over). */
  private url: string | null = null;
  private proven = false;
  private failures = 0;
  /** When the last check completed, or null before the first. */
  private checkedAt: number | null = null;
  private running = false;

  constructor(private readonly d: NamedWatchDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** The current https address, its state reset when it changed. */
  private current(): URL | null {
    const u = httpsAddress(this.d.webUrl());
    const url = u?.origin ?? null;
    if (url !== this.url) {
      this.url = url;
      this.proven = false;
      this.failures = 0;
      this.checkedAt = null;
    }
    return u;
  }

  /** The named https address's origin when it works now; else null. */
  address(): string | null {
    const u = this.current();
    if (!u) return null;
    const url = u.origin;
    if (
      this.checkedAt === null ||
      this.now() - this.checkedAt > this.d.cacheMs()
    )
      this.check(url);
    return this.proven ? url : null;
  }

  /** Whether the named https address works now. */
  works(): boolean {
    return this.address() !== null;
  }

  /** The edge brought a proven https request for `host` (its Host header). */
  saw(host: string): void {
    const u = this.current();
    const h = host.toLowerCase().replace(/:\d+$/, "");
    if (u && u.hostname.toLowerCase() === h) this.prove();
  }

  private prove(): void {
    this.failures = 0;
    if (this.proven) return;
    this.proven = true;
    try {
      this.d.onProven?.();
    } catch {
      /* the caller logs its own */
    }
  }

  private answer(url: string, a: NamedAnswer): void {
    if (url !== this.url) return; // web.url changed meanwhile
    this.checkedAt = this.now();
    if (a === "den") return this.prove();
    if (a === "unknown") return;
    this.failures++;
    if (this.proven && this.failures >= Math.max(1, this.d.dropAfter())) {
      this.proven = false;
      this.failures = 0;
    }
  }

  private check(url: string): void {
    if (this.running) return;
    this.running = true;
    const done = (a: NamedAnswer) => {
      this.running = false;
      this.answer(url, a);
    };
    let p: Promise<NamedAnswer>;
    try {
      p = this.d.probe(url);
    } catch {
      done("unknown");
      return;
    }
    p.then(done, () => done("unknown"));
  }
}
