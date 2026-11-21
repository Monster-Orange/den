/**
 * Issue 810: the fixture person, for live checks on a test install.
 *
 * Live checks need a browser signed in, and they are run by an agent,
 * which Den never lets in as the person. The fixture person is neither:
 *
 *  - The test-install mark, `web.test_install: true`, is read from the
 *    distribution config only (readWebAuthConfig). A person sets it by
 *    hand, once. Settings shows it and never writes it; `config` and
 *    POST /api/settings refuse it; user.yml's copy is ignored.
 *  - The fixture person's secret (FIXTURE_PERSON_FILE, 0600, in the state
 *    dir) is made by a signed-in person (Settings › Set up test person) or
 *    in their own terminal (`web fixture-person`), on a test install only.
 *    Its value is never printed or returned.
 *  - With it, the gate runner mints a one-time code (`web fixture-login`)
 *    and opens `/auth?fixture=<code>`: a session whose `via` is "fixture",
 *    named "fixture person" in the log and the audit trail (principal
 *    FIXTURE_PRINCIPAL), never the human. Off a test install it is refused.
 *  - A fixture session never approves a held write, never lets another
 *    browser in, never makes the fixture person, and never reaches Hub
 *    (fixtureScopeRefusal).
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { LOGIN_CODE_TTL_MS, safeNext } from "./web-session.js";

/** The fixture person's secret, in the state dir (0600). */
export const FIXTURE_PERSON_FILE = "fixture-person.key";
/** The fixture session's principal in the audit trail. */
export const FIXTURE_PRINCIPAL = "fixture:person";
/** What logs and pages call it. */
export const FIXTURE_LABEL = "fixture person";
/** The sign-in link's query parameter. */
export const FIXTURE_LINK_PARAM = "fixture";

const CONTEXT = "den-fixture-v1:";
const SKEW_MS = 5_000;
const MAX_TTL_MS = 60 * 60_000;

export function fixturePersonPath(stateDir: string): string {
  return path.join(stateDir, FIXTURE_PERSON_FILE);
}

/**
 * The fixture person's secret, or null: missing, unreadable, malformed,
 * or readable by others (then it is no secret, and nothing signs in).
 */
export function readFixtureSecret(stateDir: string): Buffer | null {
  const f = fixturePersonPath(stateDir);
  try {
    const st = fs.statSync(f);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    const v = fs.readFileSync(f, "utf-8").trim();
    if (!/^[A-Za-z0-9_-]{43,}$/.test(v)) return null;
    return Buffer.from(v, "utf-8");
  } catch {
    return null;
  }
}

// Red-first stubs (issue 810 review): the real binding follows.
export const FIXTURE_SESSION_MINUTES = 0;
export function fixtureSessionExpired(
  createdAt: number,
  now: number,
  minutes: number,
): boolean {
  void createdAt;
  void now;
  void minutes;
  return false;
}
export function readFixtureKey(stateDir: string): Buffer | null {
  return readFixtureSecret(stateDir);
}
export function verifiedFixtureKey(
  stateDir: string,
  webSecret: Buffer | null,
): Buffer | null {
  void webSecret;
  return readFixtureSecret(stateDir);
}
export function testInstallBinding(o: {
  mark: boolean;
  launchFlag: boolean;
  defaultStateDir: boolean;
  owned: boolean;
}): { ok: true } | { ok: false; why: string } {
  return o.mark ? { ok: true } : { ok: false, why: "no_mark" };
}

/** Whether the fixture person is set up here (Settings shows it). */
export function fixturePersonReady(stateDir: string): boolean {
  return readFixtureSecret(stateDir) !== null;
}

/** Why the fixture person is refused on this install. */
export function notTestInstallRefusal(configFile = "config/den.yml"): string {
  return (
    "This install isn't marked a test install, so the fixture person is refused. " +
    `A person marks one by hand: web.test_install: true in ${configFile}.`
  );
}

/** Why the test-install mark can't be set here (Settings, `config`). */
export function testInstallByHandRefusal(
  configFile = "config/den.yml",
): string {
  return (
    "The test install mark is set by hand, by a person, in the distribution config " +
    `(web.test_install in ${configFile}); never through Settings, an agent or this command.`
  );
}

export type FixtureSetup =
  | { ok: true }
  | {
      ok: false;
      code: "not_test_install" | "person_only";
      error: string;
    };

/**
 * Make (or replace) the fixture person's secret: a person's, on a test
 * install only. `agent`: the caller is an agent (an actor token, a claimed
 * agent, or a fixture session), refused first. Never returns the value.
 */
export function setupFixturePerson(
  stateDir: string,
  o: {
    testInstall: boolean;
    agent: boolean;
    configFile?: string;
    webSecret?: Buffer | null;
  },
): FixtureSetup {
  if (o.agent)
    return {
      ok: false,
      code: "person_only",
      error:
        "Only a person sets up the test person: an agent, or the fixture person itself, can't.",
    };
  if (!o.testInstall)
    return {
      ok: false,
      code: "not_test_install",
      error: notTestInstallRefusal(o.configFile),
    };
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const f = fixturePersonPath(stateDir);
  const tmp = `${f}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${randomBytes(32).toString("base64url")}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, f);
  return { ok: true };
}

function mac(secret: Buffer, body: string): Buffer {
  return createHmac("sha256", secret)
    .update(CONTEXT + body)
    .digest();
}

/** A one-time fixture sign-in code: `f1.<nonce>.<expiry>.<mac>`. */
export function mintFixtureCode(
  secret: Buffer,
  now: number = Date.now(),
  ttlMs: number = LOGIN_CODE_TTL_MS,
): string {
  const nonce = randomBytes(16).toString("base64url");
  const body = `f1.${nonce}.${(now + ttlMs).toString(36)}`;
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

export type FixtureCodeCheck =
  | { ok: true; nonce: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "bad_mac" | "expired" };

/** Whether `code` is one this fixture secret minted, still in its time. */
export function checkFixtureCode(
  code: string,
  secret: Buffer,
  now: number = Date.now(),
): FixtureCodeCheck {
  const m =
    /^(f1\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,11}))\.([A-Za-z0-9_-]{43})$/.exec(
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
    expiresAt - now > MAX_TTL_MS + SKEW_MS
  )
    return { ok: false, reason: "expired" };
  return { ok: true, nonce: m[2], expiresAt };
}

export type FixtureLink =
  | { ok: true; url: string; expiresAt: number }
  | {
      ok: false;
      code: "not_test_install" | "no_fixture_person";
      error: string;
    };

/**
 * The gate runner's sign-in link as the fixture person:
 * `<origin>/auth?fixture=<code>[&next=<path>]`. Refused off a test
 * install, and when no person has set the fixture person up.
 */
export function fixtureLoginLink(
  stateDir: string,
  o: {
    testInstall: boolean;
    origin: string;
    next?: string;
    ttlMs?: number;
    configFile?: string;
    cli?: string;
  },
): FixtureLink {
  if (!o.testInstall)
    return {
      ok: false,
      code: "not_test_install",
      error: notTestInstallRefusal(o.configFile),
    };
  const secret = readFixtureSecret(stateDir);
  if (!secret)
    return {
      ok: false,
      code: "no_fixture_person",
      error:
        "No fixture person on this install yet. A person presses Set up test person in Settings " +
        `(Access), or runs \`${o.cli ?? "den"} web fixture-person\` in their own terminal.`,
    };
  const now = Date.now();
  const ttl = o.ttlMs ?? LOGIN_CODE_TTL_MS;
  const code = mintFixtureCode(secret, now, ttl);
  const n = safeNext(o.next ?? "/");
  return {
    ok: true,
    url:
      `${o.origin.replace(/\/+$/, "")}/auth?${FIXTURE_LINK_PARAM}=${encodeURIComponent(code)}` +
      (n === "/" ? "" : `&next=${encodeURIComponent(n)}`),
    expiresAt: now + ttl,
  };
}

/** Routes that let another browser in, or approve: a person's alone. */
const PERSON_ONLY_PATHS: readonly RegExp[] = [
  /^\/api\/web\/(?:pair|approve|deny|owner(?:\/.*)?|fixture-person)$/,
  /^\/api\/approvals\/[^/]+\/decide$/,
];
/** Any path with a `hub` segment (or one starting `hub-`): Hub's. */
const HUB_PATH = /\/hub(?:[-_][^/]*)?(?:\/|$)/;

/**
 * Why a fixture session may not make this request, or null when it may.
 * Reads pass; writes to Hub, to who may sign in, and to approvals don't.
 */
export function fixtureScopeRefusal(
  method: string,
  pathname: string,
  cls?: string | null,
): string | null {
  void cls;
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return null;
  if (PERSON_ONLY_PATHS.some((re) => re.test(pathname)))
    return "The fixture person can't approve, let a browser in, or set up the test person: that is a person's.";
  if (HUB_PATH.test(pathname))
    return "The fixture person stays on this install: it can't reach Hub.";
  return null;
}
