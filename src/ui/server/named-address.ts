/**
 * Whether Den's own named https address works, so the session lives only
 * there (session-cookie.ts): a loopback name then gets no session, and a
 * session cookie presented on one doesn't count (request-guard.ts).
 *
 * It works when the address (web.url) is https and either:
 *  - the address check (address-check.ts, the identity probe through the
 *    address) found this Den there, or
 *  - the edge just brought a proven https request for that host here.
 * Each counts for web.address_check_cache_seconds; a stale answer is
 * checked again in the background, one check at a time. Before the first
 * check: a prediction from the config (the address is an https edge route
 * here). Anything else, it doesn't work: sign-in stays where the person
 * is, so an install with no working https address is never locked out.
 */

/** How the address answered the check (address-check.ts's WantedAnswer). */
export type NamedAnswer = "den" | "other" | "nothing" | "unknown";

export interface NamedWatchDeps {
  /** web.url now, or null. */
  webUrl: () => string | null;
  /** Before any check: whether the config says it should work. */
  predict: (url: string) => boolean;
  /** Check the address now. */
  probe: (url: string) => Promise<NamedAnswer>;
  /** web.address_check_cache_seconds, in ms. */
  cacheMs: () => number;
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
  private checked: { url: string; at: number; answer: NamedAnswer } | null =
    null;
  private seen: { host: string; at: number } | null = null;
  private running = false;

  constructor(private readonly d: NamedWatchDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** The named https address's origin when it works now; else null. */
  address(): string | null {
    const u = httpsAddress(this.d.webUrl());
    if (!u) return null;
    const url = u.origin;
    const now = this.now();
    const ttl = this.d.cacheMs();
    const c = this.checked?.url === url ? this.checked : null;
    if (!c || now - c.at > ttl) this.check(url);
    if (
      this.seen?.host === u.hostname.toLowerCase() &&
      now - this.seen.at <= ttl
    )
      return url;
    if (c) return c.answer === "den" ? url : null;
    return this.d.predict(url) ? url : null;
  }

  /** Whether the named https address works now. */
  works(): boolean {
    return this.address() !== null;
  }

  /** The edge brought a proven https request for `host` (its Host header). */
  saw(host: string): void {
    const u = httpsAddress(this.d.webUrl());
    const h = host.toLowerCase().replace(/:\d+$/, "");
    if (u && u.hostname.toLowerCase() === h)
      this.seen = { host: h, at: this.now() };
  }

  private check(url: string): void {
    if (this.running) return;
    this.running = true;
    const done = (answer: NamedAnswer) => {
      this.checked = { url, at: this.now(), answer };
      this.running = false;
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
