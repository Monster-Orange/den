/**
 * Issue 810: the fixture person, for live checks on a test install.
 *
 * Live checks need a browser signed in, and they are run by an agent,
 * which Den never lets in as the person. The fixture person is neither:
 *
 *  - A test install (testInstallBinding) needs ALL of: the mark,
 *    `web.test_install: true`, in the distribution config (set by hand;
 *    never through Settings, `config` or an agent); the launcher's
 *    test-only flag, `<PREFIX>_TEST_INSTALL=1`, in the server's own start
 *    environment (never a file); a state dir that isn't the product's
 *    default; and no owner or paired person. Anything less: not a test
 *    install, and every fixture path is refused.
 *  - The fixture person's key (FIXTURE_PERSON_FILE, 0600, in the state
 *    dir) is made by the server for a person's browser session (Settings ›
 *    Set up test person; never a CLI bearer). It is sealed
 *    with the install's own web secret, so a key the server didn't write
 *    is refused (verifiedFixtureKey). Its value is never printed.
 *  - With it, the gate runner mints a one-time code (`web fixture-login`)
 *    and opens `/auth?fixture=<code>`: a session whose `via` is "fixture",
 *    named "fixture person" in the log and the audit trail (principal
 *    FIXTURE_PRINCIPAL), never the human. It lasts
 *    `web.fixture_session_minutes`, and ends at once when the install
 *    stops being a test install, or the key it signed in with goes or is
 *    replaced (fixtureKeyFingerprint).
 *  - A fixture session reaches only its allow-list (fixtureScopeRefusal),
 *    and counts as an agent at every person-only check.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  FIXTURE_SESSION_MINUTES,
  FIXTURE_SESSION_RANGE,
  fixtureSessionPastTime,
  LOGIN_CODE_TTL_MS,
  safeNext,
} from "./web/web-session.js";
import { writeFileAtomic } from "./atomic-write.js";

export { FIXTURE_SESSION_MINUTES, FIXTURE_SESSION_RANGE };

/** The fixture person's key, in the state dir (0600). */
export const FIXTURE_PERSON_FILE = "fixture-person.key";
/** The fixture session's principal in the audit trail. */
export const FIXTURE_PRINCIPAL = "fixture:person";
/** What logs and pages call it. */
export const FIXTURE_LABEL = "fixture person";
/** The sign-in link's query parameter. */
export const FIXTURE_LINK_PARAM = "fixture";
/** The launcher's flag, `<PREFIX>_TEST_INSTALL` (profile readEnv). */
export const TEST_INSTALL_ENV_KEY = "TEST_INSTALL";

const CONTEXT = "den-fixture-v1:";
const SEAL_CONTEXT = "den-fixture-key-v1:";
const SKEW_MS = 5_000;
const MAX_TTL_MS = 60 * 60_000;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export function fixturePersonPath(stateDir: string): string {
  return path.join(stateDir, FIXTURE_PERSON_FILE);
}

export type TestInstallWhy =
  | "no_mark"
  | "no_launch_flag"
  | "default_state_dir"
  | "owned";

/** Whether this install is a test install, and if not, the first reason. */
export function testInstallBinding(o: {
  mark: boolean;
  launchFlag: boolean;
  defaultStateDir: boolean;
  owned: boolean;
}): { ok: true } | { ok: false; why: TestInstallWhy } {
  if (!o.mark) return { ok: false, why: "no_mark" };
  if (!o.launchFlag) return { ok: false, why: "no_launch_flag" };
  if (o.defaultStateDir) return { ok: false, why: "default_state_dir" };
  if (o.owned) return { ok: false, why: "owned" };
  return { ok: true };
}

/** The key file's two parts, or null (missing, others can read it, malformed). */
function readKeyFile(stateDir: string): { key: string; seal: string } | null {
  const f = fixturePersonPath(stateDir);
  try {
    const st = fs.lstatSync(f);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    const [key, seal = ""] = fs.readFileSync(f, "utf-8").trim().split(".");
    return KEY_RE.test(key) ? { key, seal } : null;
  } catch {
    return null;
  }
}

function sealOf(key: string, webSecret: Buffer): Buffer {
  return createHmac("sha256", webSecret)
    .update(SEAL_CONTEXT + key)
    .digest();
}

/**
 * The fixture key as the CLI reads it, to mint a code (unverified: the
 * server checks its seal). Null when missing, readable by others, or
 * malformed.
 */
export function readFixtureKey(stateDir: string): Buffer | null {
  const k = readKeyFile(stateDir);
  return k ? Buffer.from(k.key, "utf-8") : null;
}

/**
 * The fixture key the server trusts: the file's, only when its seal is
 * this install's web secret's (so the server wrote it). Null otherwise.
 */
export function verifiedFixtureKey(
  stateDir: string,
  webSecret: Buffer | null,
): Buffer | null {
  const k = readKeyFile(stateDir);
  if (!k || !webSecret) return null;
  let given: Buffer;
  try {
    given = Buffer.from(k.seal, "base64url");
  } catch {
    return null;
  }
  const want = sealOf(k.key, webSecret);
  if (given.length !== want.length || !timingSafeEqual(given, want))
    return null;
  return Buffer.from(k.key, "utf-8");
}

/** Why the fixture person is refused on this install. */
export function notTestInstallRefusal(configFile = "config/den.yml"): string {
  return (
    "This install isn't a test install, so the fixture person is refused. A test install is " +
    `marked by hand (web.test_install: true in ${configFile}) and started by the test launcher ` +
    "on its own state folder, with no owner."
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
      code: "not_test_install" | "person_only" | "no_secret";
      error: string;
    };

/**
 * Make (or replace) the fixture person's key, sealed with `webSecret`:
 * the server's, for a person, on a test install only. `agent`: the
 * caller isn't a person (an agent, a claimed agent, a process inside an
 * agent's session, or a fixture session), refused first. Never returns
 * the value.
 */
export function setupFixturePerson(
  stateDir: string,
  o: {
    testInstall: boolean;
    agent: boolean;
    webSecret: Buffer | null;
    configFile?: string;
  },
): FixtureSetup {
  if (o.agent)
    return {
      ok: false,
      code: "person_only",
      error:
        "Only a person sets up the test person, in their browser (Settings › Access › Set up test " +
        "person): an agent, a command-line call or the fixture person itself can't.",
    };
  if (!o.testInstall)
    return {
      ok: false,
      code: "not_test_install",
      error: notTestInstallRefusal(o.configFile),
    };
  if (!o.webSecret)
    return {
      ok: false,
      code: "no_secret",
      error: "This install has no web secret yet: start it first.",
    };
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const f = fixturePersonPath(stateDir);
  const key = randomBytes(32).toString("base64url");
  const seal = sealOf(key, o.webSecret).toString("base64url");
  writeFileAtomic(f, `${key}.${seal}\n`, { mode: 0o600 });
  return { ok: true };
}

/** Whether a fixture session made at `createdAt` has outlived its minutes. */
export function fixtureSessionExpired(
  createdAt: number,
  now: number,
  minutes: number,
): boolean {
  return fixtureSessionPastTime(createdAt, now, minutes);
}

function mac(secret: Buffer, body: string): Buffer {
  return createHmac("sha256", secret)
    .update(CONTEXT + body)
    .digest();
}

/** A one-time fixture sign-in code: `f1.<nonce>.<expiry>.<mac>`. */
export function mintFixtureCode(
  key: Buffer,
  now: number = Date.now(),
  ttlMs: number = LOGIN_CODE_TTL_MS,
): string {
  const nonce = randomBytes(16).toString("base64url");
  const body = `f1.${nonce}.${(now + ttlMs).toString(36)}`;
  return `${body}.${mac(key, body).toString("base64url")}`;
}

export type FixtureCodeCheck =
  | { ok: true; nonce: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "bad_mac" | "expired" };

/** Whether `code` is one this fixture key minted, still in its time. */
export function checkFixtureCode(
  code: string,
  key: Buffer,
  now: number = Date.now(),
): FixtureCodeCheck {
  const m =
    /^(f1\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,11}))\.([A-Za-z0-9_-]{43})$/.exec(
      code,
    );
  if (!m) return { ok: false, reason: "malformed" };
  const given = Buffer.from(m[4], "base64url");
  const want = mac(key, m[1]);
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
 * `<origin>/auth?fixture=<code>[&next=<path>]`. Refused when the server
 * says this isn't a test install, and when no fixture person is set up.
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
  const key = readFixtureKey(stateDir);
  if (!key)
    return {
      ok: false,
      code: "no_fixture_person",
      error:
        "No fixture person on this install yet. A person presses Set up test person in Settings " +
        "(Access), in their browser.",
    };
  const now = Date.now();
  const ttl = o.ttlMs ?? LOGIN_CODE_TTL_MS;
  const code = mintFixtureCode(key, now, ttl);
  const n = safeNext(o.next ?? "/");
  return {
    ok: true,
    url:
      `${o.origin.replace(/\/+$/, "")}/auth?${FIXTURE_LINK_PARAM}=${encodeURIComponent(code)}` +
      (n === "/" ? "" : `&next=${encodeURIComponent(n)}`),
    expiresAt: now + ttl,
  };
}

/**
 * The writes a fixture session may make (what live checks drive through the
 * page); person-only fields inside them are refused, as for an agent.
 */
export const FIXTURE_WRITES: readonly [method: string, path: RegExp][] = [
  ["POST", /^\/api\/session\/logout$/],
  ["POST", /^\/api\/settings$/],
  ["POST", /^\/api\/scope$/],
  ["POST", /^\/api\/notifications\/(?:read|clear)$/],
  ["POST", /^\/api\/report\/drafts$/],
  ["DELETE", /^\/api\/report\/drafts\/[^/]+$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/agents\/[^/]+\/(?:start|stop|resume)$/],
  // A restart or a mode: agent-routes.ts lets each reach only agents Den
  // marked testBed, never the server agent's; an unknown id answers the
  // same 403. A mode is one of FIXTURE_MODES.
  ["POST", /^\/api\/workspaces\/[^/]+\/agents\/[^/]+\/restart$/],
  ["POST", /^\/api\/workspaces\/[^/]+\/agents\/[^/]+\/mode$/],
  // Issue 1215: a live check's own project (fixture-projects.ts narrows
  // these to create, activate, deactivate and delete, on its own projects,
  // on a test install).
  ["POST", /^\/api\/workspaces\/create$/],
  ["POST", /^\/api\/workspaces$/],
  ["DELETE", /^\/api\/workspaces$/],
  // Issue 1391 (the bed's 573): checks posted manifest text; writes
  // nothing (route-classes.ts: "validates posted content (no write)").
  ["POST", /^\/api\/manifest\/validate$/],
];

/** A security bound, not a Setting: a live check never picks auto or all. */
export const FIXTURE_MODES: readonly string[] = ["ask", "edits"];

/**
 * Issue 1391 (the bed's 542): GETs a fixture session may make though the
 * route table doesn't class them readonly. /api/github/repos reads the
 * person's repo list through gh (classed for gh's sign-in and quota); it
 * writes nothing. /api/manifest/validate?path= (the bed's 573, Vision's
 * ruling) validates a manifest by path; the route reads only inside a
 * project's repos and quotes nothing it refuses. A fixture session exists
 * only on a test install.
 */
export const FIXTURE_GETS: readonly RegExp[] = [
  /^\/api\/github\/repos$/,
  /^\/api\/manifest\/validate$/,
];

/**
 * Reads never open to a fixture session (or, issue 796, an agent's view),
 * whatever their route class.
 */
export const FIXTURE_READ_DENY: readonly RegExp[] = [
  // Hub: only Den's own view of it (the rail).
  /\/hub(?:[-_][^/]*)?\/./,
  /\/hub[-_][^/]*$/,
  // Who may sign in, and the person's own records.
  /^\/api\/web\//,
  /^\/api\/sessions\//,
];

/**
 * Why a fixture session may not make this request, or null when it may.
 * An allow-list: a page or asset (a GET off /api/), a /api/ GET the route
 * table classes `readonly` and FIXTURE_READ_DENY doesn't name, or one of
 * FIXTURE_WRITES. Everything else (shell-grade and mutating GETs,
 * unclassified routes, every other write) is refused. `cls` is the
 * route's class (route-classes.ts routeClass), null when unclassified.
 */
export function fixtureScopeRefusal(
  method: string,
  pathname: string,
  cls: string | null,
): string | null {
  const m = method.toUpperCase();
  const refused =
    "The fixture person can only use the pages and the few writes live checks need: not this.";
  if (m === "GET" || m === "HEAD") {
    // A page or an asset; a page route that streams or starts something
    // (a mutating GET) only when it is the sign-in itself.
    if (!pathname.startsWith("/api/"))
      return cls === "mutating" || cls === "shell-grade"
        ? pathname === "/auth"
          ? null
          : refused
        : null;
    if (cls !== "readonly" && !FIXTURE_GETS.some((re) => re.test(pathname)))
      return refused;
    if (FIXTURE_READ_DENY.some((re) => re.test(pathname))) return refused;
    return null;
  }
  return FIXTURE_WRITES.some(([wm, re]) => wm === m && re.test(pathname))
    ? null
    : refused;
}

const FINGERPRINT_CONTEXT = "den-fixture-fp-v1:";

/**
 * The fixture key's fingerprint, kept on a fixture session when it is
 * minted (never the key): the session stands only while the key it signed
 * in with is the install's current one, so setting the test person up
 * again ends every older fixture session.
 */
export function fixtureKeyFingerprint(key: Buffer): string {
  return createHash("sha256")
    .update(FINGERPRINT_CONTEXT)
    .update(key)
    .digest("base64url");
}
