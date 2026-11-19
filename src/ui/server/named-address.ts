/**
 * Whether Den's own named https address works, so the session lives only
 * there (session-cookie.ts): a loopback name then gets no session, and a
 * session made on one counts on no host (request-guard.ts).
 *
 * The address (web.url) must be https. It is proven when:
 *  - the address check (address-check.ts, the identity probe through the
 *    address) finds this Den there, or
 *  - the edge brings a proven https request for that host here.
 * Proven is sticky for a while. A check that can't tell (a timeout) keeps
 * it within web.address_unknown_keep_seconds of the last answer as this
 * Den; past that window it counts as a failure. A failure (something else,
 * or nothing, answers; or can't-tell past the window), seen
 * web.address_check_drop_after times in a row, moves it back. The check runs again in the background every
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
  /** web.address_unknown_keep_seconds, in ms. */
  unknownKeepMs: () => number;
  /** Proven, or its last answer as this Den, changed (for doctor). */
  onChange?: (s: { proven: boolean; lastAnswered: number | null }) => void;
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
  /** The last answer as this Den (a check, or the edge's request). */
  private answeredAt: number | null = null;
  /** When onChange last ran. */
  private saidAt: number | null = null;
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
      this.answeredAt = null;
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

  /** When the address last answered as this Den (ms), or null. */
  lastAnswered(): number | null {
    this.current();
    return this.answeredAt;
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
    this.answeredAt = this.now();
    const was = this.proven;
    if (!this.proven) {
      this.proven = true;
      try {
        this.d.onProven?.();
      } catch {
        /* the caller logs its own */
      }
    }
    // Said again at most once a minute (every edge request proves).
    if (!was || this.saidAt === null || this.answeredAt - this.saidAt >= 60_000)
      this.changed();
  }

  private changed(): void {
    this.saidAt = this.now();
    try {
      this.d.onChange?.({
        proven: this.proven,
        lastAnswered: this.answeredAt,
      });
    } catch {
      /* doctor says nothing then */
    }
  }

  private answer(url: string, a: NamedAnswer): void {
    if (url !== this.url) return; // web.url changed meanwhile
    this.checkedAt = this.now();
    if (a === "den") return this.prove();
    // Can't tell: no change, within the window from the last answer.
    if (
      a === "unknown" &&
      (this.answeredAt === null ||
        this.now() - this.answeredAt <= this.d.unknownKeepMs())
    )
      return;
    this.failures++;
    if (this.proven && this.failures >= Math.max(1, this.d.dropAfter())) {
      this.proven = false;
      this.failures = 0;
      this.changed();
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
