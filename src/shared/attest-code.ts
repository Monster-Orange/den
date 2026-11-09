/**
 * "This is my computer" (D17, fix A): how a browser on the machine Den runs
 * on proves it, when the edge can't tell (Docker Desktop, OrbStack or a TCP
 * passthrough hand the edge a gateway's address, so edgeClient says
 * `unattested`).
 *
 * The signed-out edge page navigates the top level to
 * `http://localhost:<port>/attest?return=<its own edge URL>`. Only a browser
 * on this machine reaches this server there: a browser elsewhere reaches
 * nothing, or its own machine's Den, whose web.secret doesn't verify here.
 * The server answers 303 to the edge URL with the code in the fragment
 * (`#den-attest=<code>`: never sent to a server, never in a log), and the
 * page starts Sign in with GitHub with it.
 *
 * The proof alone never makes a session. Any program running as this OS
 * user (an agent with a shell, too) can reach localhost, so a session from
 * it would let an agent approve its own changes. It only lets a GitHub
 * sign-in claim a Den that has no owner, for a member of
 * web.allowed_github_org (github-routes.ts decideFlow): the person still
 * approves on github.com.
 *
 *  - `a1.<nonce>.<expiry>.<mac>`, the mac HMAC-SHA256(web.secret, context +
 *    the rest + the edge host it is for), its context its own: never a
 *    login or a claim code. A code minted for one host fails on another.
 *  - Valid for ATTEST_CODE_TTL_MS (2 minutes): the page uses it at once.
 *  - Single use: its nonce is spent when the sign-in starts (ClaimNonces,
 *    a file, so a restart can't revive one).
 *  - `return` must be one of this server's own edge hosts (attestReturn).
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const ATTEST_CODE_TTL_MS = 2 * 60_000;
const SKEW_MS = 5_000;
const CONTEXT = "den-attest-v1:";
/** Where the spent attest nonces are kept (ClaimNonces' format). */
export const ATTEST_NONCES_FILE = "attest-nonces.json";

function mac(secret: Buffer, body: string, host: string): Buffer {
  return createHmac("sha256", secret)
    .update(`${CONTEXT}${body}\n${host.toLowerCase()}`)
    .digest();
}

/** A fresh attest code for `host` (the edge hostname, no port). */
export function mintAttestCode(
  secret: Buffer,
  host: string,
  now: number = Date.now(),
): string {
  const nonce = randomBytes(16).toString("base64url");
  const body = `a1.${nonce}.${(now + ATTEST_CODE_TTL_MS).toString(36)}`;
  return `${body}.${mac(secret, body, host).toString("base64url")}`;
}

export type AttestCodeCheck =
  | { ok: true; nonce: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "bad_mac" | "expired" };

/**
 * Whether `code` is an attest code this secret minted for `host`, still in
 * its time. Constant-time mac. Single use is the caller's.
 */
export function checkAttestCode(
  code: string,
  secret: Buffer,
  host: string,
  now: number = Date.now(),
): AttestCodeCheck {
  const m =
    /^(a1\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,11}))\.([A-Za-z0-9_-]{43})$/.exec(
      code,
    );
  if (!m) return { ok: false, reason: "malformed" };
  const given = Buffer.from(m[4], "base64url");
  const want = mac(secret, m[1], host);
  if (given.length !== want.length || !timingSafeEqual(given, want))
    return { ok: false, reason: "bad_mac" };
  const expiresAt = parseInt(m[3], 36);
  if (
    !Number.isFinite(expiresAt) ||
    now >= expiresAt ||
    expiresAt - now > ATTEST_CODE_TTL_MS + SKEW_MS
  )
    return { ok: false, reason: "expired" };
  return { ok: true, nonce: m[2], expiresAt };
}

/**
 * `/attest`'s `return`, checked: an http(s) URL whose host is one of
 * `edgeHosts` (this server's own edge hostnames), no credentials in it.
 * Its origin and same-origin path, or null for anything else.
 */
export function attestReturn(
  raw: string | null | undefined,
  edgeHosts: readonly string[],
): { origin: string; host: string; next: string } | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!edgeHosts.map((h) => h.toLowerCase()).includes(host)) return null;
  const next = `${u.pathname}${u.search}`;
  return {
    origin: u.origin,
    host,
    next: next.startsWith("/auth") ? "/" : next,
  };
}

/** The fragment key the code rides in back to the edge page. */
export const ATTEST_FRAGMENT = "den-attest";

/** Where /attest sends the browser: the edge page, the code in the fragment. */
export function attestRedirect(
  ret: { origin: string; next: string },
  code: string,
): string {
  return `${ret.origin}${ret.next}#${ATTEST_FRAGMENT}=${encodeURIComponent(code)}`;
}
