/**
 * The claim code (0.4.15, Ward 2026-11-07): how the browser the person
 * opens at the end of the install signs in without a sign-in step, so that
 * approving an agent's changes (which needs a signed-in browser session,
 * even on localhost) works from the first page.
 *
 *  - `c1.<nonce>.<expiry>.<mac>`, the mac HMAC-SHA256(web.secret, context +
 *    the rest), its context its own: a login code (web-session.ts) is never
 *    a claim code, and the other way round.
 *  - Valid for 30 minutes: an install hands it over, and the person may take
 *    a while to open it. An expiry further out than that is refused.
 *  - Single use. Used nonces are kept in `<state dir>/claim-nonces.json`
 *    (0600) until they expire, so a server restart can't revive one. The
 *    file holds nonces only, never a code. A file that won't parse refuses
 *    every claim (fail closed); the sign-in flows still work.
 *  - Minted by the CLI (`<cli> web claim-link`), which reads web.secret as
 *    the same OS user. The CLI refuses inside an agent's session
 *    (claimRefusalForAgent): an agent must never hold one.
 *
 * Limit: an agent running as the same OS user could, in principle, read
 * web.secret or the browser's cookie store from disk. That is the strength
 * of Den's other person-only routes too; only an OS boundary is stronger.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ACTOR_TOKEN_ENV } from "./actor-token.js";
import { AGENT_ACTOR_ENV } from "./sessions/env.js";

export const CLAIM_CODE_TTL_MS = 30 * 60_000;
const SKEW_MS = 5_000;
const CONTEXT = "den-claim-v1:";
export const CLAIM_NONCES_FILE = "claim-nonces.json";

function mac(secret: Buffer, body: string): Buffer {
  return createHmac("sha256", secret)
    .update(CONTEXT + body)
    .digest();
}

/** A fresh claim code, valid for 30 minutes from `now`. */
export function mintClaimCode(
  secret: Buffer,
  now: number = Date.now(),
): string {
  const nonce = randomBytes(16).toString("base64url");
  const body = `c1.${nonce}.${(now + CLAIM_CODE_TTL_MS).toString(36)}`;
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

export type ClaimCodeCheck =
  | { ok: true; nonce: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "bad_mac" | "expired" };

/**
 * Whether `code` is a claim code this secret minted, still in its 30
 * minutes. Constant-time mac. Single use is ClaimNonces'.
 */
export function checkClaimCode(
  code: string,
  secret: Buffer,
  now: number = Date.now(),
): ClaimCodeCheck {
  const m =
    /^(c1\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,11}))\.([A-Za-z0-9_-]{43})$/.exec(
      code,
    );
  if (!m) return { ok: false, reason: "malformed" };
  const given = Buffer.from(m[4], "base64url");
  const want = mac(secret, m[1]);
  if (given.length !== want.length || !timingSafeEqual(given, want))
    return { ok: false, reason: "bad_mac" };
  const expiresAt = parseInt(m[3], 36);
  if (
    !Number.isFinite(expiresAt) ||
    now >= expiresAt ||
    expiresAt - now > CLAIM_CODE_TTL_MS + SKEW_MS
  )
    return { ok: false, reason: "expired" };
  return { ok: true, nonce: m[2], expiresAt };
}

/**
 * `<origin>/auth?claim=<code>`: the sign-in route, so it is classed as one
 * (a mutating GET: another site can't open it; an agent's token can't).
 */
export function claimLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/auth?claim=${encodeURIComponent(code)}`;
}

/**
 * Why the CLI won't let a browser in from here (a claim link, a sign-in
 * link, pairing a device, the GitHub owner), or null when it may: inside
 * an agent's session (DEN_AGENT or DEN_ACTOR_TOKEN set) it never does.
 */
export function personGrantRefusal(env: NodeJS.ProcessEnv): string | null {
  if (env[AGENT_ACTOR_ENV] !== undefined || env[ACTOR_TOKEN_ENV] !== undefined)
    return "An agent can't do this: it lets a browser in as you. Run it in your own terminal.";
  return null;
}

/** Why the CLI won't mint a claim code here, or null when it may. */
export function claimRefusalForAgent(env: NodeJS.ProcessEnv): string | null {
  return personGrantRefusal(env)
    ? "An agent can't make a claim link: it signs a browser in as the person. Run it in your own terminal."
    : null;
}

/** The used claim nonces, kept until they expire (a file, 0600). */
export class ClaimNonces {
  constructor(
    private readonly stateDir: string,
    /** The file's name (D17: the attest codes keep their own). */
    private readonly fileName: string = CLAIM_NONCES_FILE,
  ) {}

  private file(): string {
    return path.join(this.stateDir, this.fileName);
  }

  /** The used nonces; null when the file is there but won't parse (fail closed). */
  private read(): Record<string, number> | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(), "utf-8");
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
    }
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>))
      if (/^[A-Za-z0-9_-]{22}$/.test(k) && typeof v === "number") out[k] = v;
    return out;
  }

  private write(used: Record<string, number>): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const tmp = `${this.file()}.${process.pid}.${randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, JSON.stringify(used) + "\n", { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file());
  }

  /**
   * Use `nonce` (its code expires at `expiresAt`): true the first time,
   * false once used. Expired entries are pruned on the way.
   */
  consume(nonce: string, expiresAt: number, now: number = Date.now()): boolean {
    const used = this.read();
    // Unreadable: refuse every claim rather than forget which were used.
    if (!used) return false;
    for (const [k, exp] of Object.entries(used)) if (exp <= now) delete used[k];
    if (nonce in used) {
      this.write(used);
      return false;
    }
    used[nonce] = expiresAt;
    this.write(used);
    return true;
  }
}
