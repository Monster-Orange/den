/**
 * SEC-1a: the web server's secret and the person token derived from it.
 *
 * `web.secret` is 32 random bytes in the distribution's state dir, mode
 * 0600 (the dir 0700 when Den creates it). Reading it is the proof that a
 * caller is the OS user, the same proof as the session host's socket. It is
 * never printed, never logged and never served.
 *
 * The person token is HMAC-SHA256(secret, "den-person-v1:" + os user),
 * sent as `Authorization: Bearer den_pt_<b64url>`. The server recomputes it
 * and compares in constant time; its actor is `person:<os user>`.
 *
 * SEC-1b's `web logout --all` rotates the secret (rotateWebSecret).
 * SEC-1c's agent tokens (`den_at_…`) are actor-token.ts's: random, not
 * derived from the secret.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ACTOR_TOKEN_ENV, isActorTokenShape } from "./actor-token.js";
import { getStateDir } from "./paths.js";
import { AGENT_ACTOR_ENV } from "./sessions/env.js";

export const WEB_SECRET_FILE = "web.secret";
const SECRET_BYTES = 32;
export const PERSON_TOKEN_PREFIX = "den_pt_";
const PERSON_CONTEXT = "den-person-v1:";

/** `<state dir>/web.secret`. */
export function webSecretPath(stateDir: string = getStateDir()): string {
  return path.join(stateDir, WEB_SECRET_FILE);
}

/** The OS user the process runs as (the person-token actor's name). */
export function osUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? "unknown";
  }
}

/** The secret, or null when it is missing, unreadable or malformed. */
export function readWebSecret(stateDir: string = getStateDir()): Buffer | null {
  try {
    const b = fs.readFileSync(webSecretPath(stateDir));
    return b.length === SECRET_BYTES ? b : null;
  } catch {
    return null;
  }
}

/**
 * The secret, created when missing: the state dir 0700 when it is made
 * here, the file 0600, written exclusively so two starts never race to two
 * secrets. An existing file looser than 0600 is tightened.
 */
export function ensureWebSecret(stateDir: string = getStateDir()): Buffer {
  const file = webSecretPath(stateDir);
  const existing = readWebSecret(stateDir);
  if (existing) {
    tighten(file);
    return existing;
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const fresh = randomBytes(SECRET_BYTES);
  try {
    // A malformed file (wrong length) is replaced; a missing one created.
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.writeFileSync(file, fresh, { mode: 0o600, flag: "wx" });
  } catch (e) {
    // Another process created it first: use theirs.
    const won = readWebSecret(stateDir);
    if (won) return won;
    throw e;
  }
  tighten(file);
  return fresh;
}

/**
 * SEC-1b (`web logout --all`): a fresh secret in place of the old one,
 * written to a temp file (0600) and renamed over it, so a reader sees one
 * or the other, never half. Every person token and every browser session
 * derived from the old one stops verifying; the CLI re-reads the file on
 * each call, so it keeps working.
 */
export function rotateWebSecret(stateDir: string = getStateDir()): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = webSecretPath(stateDir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, randomBytes(SECRET_BYTES), { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
  tighten(file);
}

function tighten(file: string): void {
  try {
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
  } catch {
    /* gone or not ours: the read already decided */
  }
}

/** `den_pt_<b64url(HMAC-SHA256(secret, "den-person-v1:" + user))>`. */
export function personToken(secret: Buffer, user: string = osUser()): string {
  const mac = createHmac("sha256", secret)
    .update(PERSON_CONTEXT + user)
    .digest("base64url");
  return PERSON_TOKEN_PREFIX + mac;
}

/**
 * The actor a presented person token proves (`person:<user>`), or null.
 * Constant time: both sides are hashed to one length before comparing.
 */
export function verifyPersonToken(
  presented: string,
  secret: Buffer,
  user: string = osUser(),
): `person:${string}` | null {
  const expected = personToken(secret, user);
  const a = createHmac("sha256", "den-cmp").update(presented).digest();
  const b = createHmac("sha256", "den-cmp").update(expected).digest();
  return timingSafeEqual(a, b) ? `person:${user}` : null;
}

/**
 * The headers every CLI and stdio-MCP call to the web server carries:
 *  - inside an agent's session (SEC-1c): its DEN_ACTOR_TOKEN, never the
 *    person's; an agent (DEN_AGENT set) without one sends no credential
 *    rather than fall back to the person token;
 *  - otherwise the person token, or none when there is no secret yet (a
 *    server that predates SEC-1, or none started).
 */
export function cliAuthHeaders(
  stateDir: string = getStateDir(),
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const actorToken = env[ACTOR_TOKEN_ENV];
  if (isActorTokenShape(actorToken))
    return { Authorization: `Bearer ${actorToken}` };
  if (env[AGENT_ACTOR_ENV] !== undefined || actorToken !== undefined) return {};
  const secret = readWebSecret(stateDir);
  return secret ? { Authorization: `Bearer ${personToken(secret)}` } : {};
}

/**
 * The server's view of the secret: read once, re-read when the file changes
 * (SEC-1b's rotation), created at start.
 */
export class WebSecretStore {
  private cached: { key: string; secret: Buffer } | null = null;
  constructor(private readonly stateDir: () => string = getStateDir) {}

  /** Create the secret if needed (at server start). */
  ensure(): void {
    const secret = ensureWebSecret(this.stateDir());
    this.cached = { key: this.key() ?? "", secret };
  }

  /** The current secret, or null when it is missing. */
  current(): Buffer | null {
    const key = this.key();
    if (key === null) return null;
    if (this.cached?.key === key) return this.cached.secret;
    const secret = readWebSecret(this.stateDir());
    this.cached = secret ? { key, secret } : null;
    return secret;
  }

  private key(): string | null {
    try {
      const s = fs.statSync(webSecretPath(this.stateDir()));
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }
}
