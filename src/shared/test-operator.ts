/**
 * Issue 814 (option B): the test operator.
 *
 * Live checks sign in on a test install as the fixture person (issue 810),
 * who counts as an agent at every person-only check. A few checks need a
 * person's act: start, use and close a terminal, message an agent,
 * relaunch one. The test operator is that, and no more:
 *
 *  - Not a new sign-in. It is a fixture session making one of OPERATOR_ACTS,
 *    on an operator install, reached on loopback. For that one request it
 *    passes that route's person-only check (request-guard.ts
 *    personOrOperator), and the audit names it OPERATOR_PRINCIPAL, never
 *    the human. Every other request of the session is the fixture person's.
 *  - An operator install is a test install (testInstallBinding) that was
 *    CREATED as one: its state folder was missing or empty when the server
 *    first started on it with the launch flag, and the server claimed it
 *    then (claimAtBirth) and wrote the creation record, sealed with the
 *    install's new secret for that folder. A mark added later by a config
 *    edit never makes one. It binds to loopback only, and an operator act
 *    that came through a proxy (forwarded headers) is refused.
 *  - At that same first start the server gives the install its fixture
 *    person, so a new test install needs no person's click.
 *
 * The seal stops a config edit or a copied folder; it is no barrier to a
 * process of the same OS user that can read the install's secret. That
 * user's processes already have the reach a shell gives: what the role
 * guards is Den's own person-only checks and audit trail.
 */
import { createHmac, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";

/** The test operator's principal in the audit trail. */
export const OPERATOR_PRINCIPAL = "test:operator";
/** What logs call it. */
export const OPERATOR_LABEL = "test operator";
/** The creation record, in the state folder (0600). */
export const CREATION_RECORD_FILE = "test-install.created";
/** What the record holds until the server seals it, at its first start. */
export const CREATION_PENDING = "pending";
/** The env var an operator's shell gets, so Den's CLI in it sends no person credential. */
export const OPERATOR_SHELL_ACTOR = "test-operator";

const SEAL_CONTEXT = "den-test-created-v1:";
const RECORD_RE = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

export function creationRecordPath(stateDir: string): string {
  return path.join(stateDir, CREATION_RECORD_FILE);
}

/** Whether a state folder is new: missing, or an empty folder. */
export function stateDirIsEmpty(stateDir: string): boolean {
  try {
    const st = fs.lstatSync(stateDir);
    if (!st.isDirectory()) return false;
    return fs.readdirSync(stateDir).length === 0;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * At the server's first start on a state folder, before it writes
 * anything: when the launch flag is set and the folder isn't the
 * product's default, make the folder (an existing one only when empty)
 * and claim it with the pending creation record, made exclusively, as its
 * first file. True only when nothing else is in it after the claim.
 */
export function claimAtBirth(o: {
  stateDir: string;
  defaultStateDir: string;
  launchFlag: boolean;
}): boolean {
  if (!o.launchFlag) return false;
  if (realOrResolved(o.stateDir) === realOrResolved(o.defaultStateDir))
    return false;
  try {
    fs.mkdirSync(path.dirname(o.stateDir), { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(o.stateDir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      if (!stateDirIsEmpty(o.stateDir)) return false;
    }
    fs.writeFileSync(creationRecordPath(o.stateDir), `${CREATION_PENDING}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return (
      fs.readdirSync(o.stateDir).length === 1 &&
      !fs.lstatSync(o.stateDir).isSymbolicLink()
    );
  } catch {
    return false;
  }
}

function sealOf(stateDir: string, createdAt: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret)
    .update(`${SEAL_CONTEXT}${realOrResolved(stateDir)}:${createdAt}`)
    .digest();
}

/** Seal the creation record with the install's secret (0600). */
export function writeCreationRecord(
  stateDir: string,
  secret: Buffer,
  now: number = Date.now(),
): void {
  const at = String(now);
  const f = creationRecordPath(stateDir);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    `v1.${at}.${sealOf(stateDir, at, secret).toString("base64url")}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, f);
}

/** Drop a pending record (the first start turned out not to be a test install). */
export function dropPendingRecord(stateDir: string): void {
  try {
    const f = creationRecordPath(stateDir);
    if (fs.readFileSync(f, "utf-8").trim() === CREATION_PENDING)
      fs.rmSync(f, { force: true });
  } catch {
    /* none */
  }
}

/**
 * Whether the creation record is one this server sealed, for this folder,
 * with `secret`: 0600, a regular file, its seal matching. A rotated
 * secret (`web logout --all`) ends it.
 */
export function verifiedCreationRecord(
  stateDir: string,
  secret: Buffer | null,
): boolean {
  if (!secret) return false;
  try {
    const f = creationRecordPath(stateDir);
    const st = fs.lstatSync(f);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return false;
    const m = RECORD_RE.exec(fs.readFileSync(f, "utf-8").trim());
    if (!m) return false;
    const given = Buffer.from(m[2], "base64url");
    const want = sealOf(stateDir, m[1], secret);
    return given.length === want.length && timingSafeEqual(given, want);
  } catch {
    return false;
  }
}

export type OperatorAct =
  | "terminal-start"
  | "terminal-attach"
  | "terminal-close"
  | "agent-say"
  | "agent-relaunch";

/**
 * The person-only requests the test operator may make, and nothing else.
 * Each one: what live checks need it for (issue 814's table).
 *  - terminal-start: Terminal starts a shell; the cap's 429 (448, 503).
 *    No `cwd`; the shell's Den CLI sends no person credential.
 *  - terminal-attach, terminal-close: the operator's own shells only
 *    (448, 653; a check closes what it opened).
 *  - agent-say: a message to an agent, the 409 while it shows a dialog
 *    (629, 659).
 *  - agent-relaunch: Resume after a relaunch that exits early (658).
 */
const ACTS: readonly [OperatorAct, string, RegExp][] = [
  ["terminal-start", "POST", /^\/api\/workspaces\/[^/]+\/sessions$/],
  ["terminal-attach", "GET", /^\/api\/sessions\/[^/]+\/io$/],
  ["terminal-close", "POST", /^\/api\/sessions\/[^/]+\/close$/],
  ["agent-say", "POST", /^\/api\/workspaces\/[^/]+\/agents\/[^/]+\/say$/],
  [
    "agent-relaunch",
    "POST",
    /^\/api\/workspaces\/[^/]+\/agents\/[^/]+\/relaunch$/,
  ],
];

/** The act a request is, or null when it is none of them. */
export function operatorAct(
  method: string,
  pathname: string,
): OperatorAct | null {
  const m = method.toUpperCase();
  for (const [act, am, re] of ACTS)
    if (am === m && re.test(pathname)) return act;
  return null;
}

/** The session id an attach or close names. */
export function operatorShellTarget(pathname: string): string | null {
  const m = /^\/api\/sessions\/([^/]+)\/(?:io|close)$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** Shells the test operator started (ids and names), in this server's memory. */
const OWN_SHELLS = new Set<string>();
export function rememberOperatorShell(...keys: string[]): void {
  for (const k of keys) if (k) OWN_SHELLS.add(k);
}
export function isOperatorShell(key: string): boolean {
  return OWN_SHELLS.has(key);
}
export function forgetOperatorShell(...keys: string[]): void {
  for (const k of keys) OWN_SHELLS.delete(k);
}

export type OperatorRefusal =
  | "not_an_act"
  | "not_operator_install"
  | "not_loopback"
  | "forwarded"
  | "not_own_shell";

/**
 * Why a fixture session's request may not be a test operator's act, or
 * null when it may. `operatorInstall`: created as a test install, still
 * one, bound to loopback (index.ts operatorInstallNow).
 */
export function operatorRefusal(o: {
  operatorInstall: boolean;
  via: "loopback" | "edge" | "lan";
  beyond: boolean;
  method: string;
  pathname: string;
  forwarded?: boolean;
  ownShell?: (key: string) => boolean;
}): OperatorRefusal | null {
  const act = operatorAct(o.method, o.pathname);
  if (!act) return "not_an_act";
  if (!o.operatorInstall) return "not_operator_install";
  if (o.via !== "loopback" || o.beyond) return "not_loopback";
  if (o.forwarded) return "forwarded";
  if (act === "terminal-attach" || act === "terminal-close") {
    const t = operatorShellTarget(o.pathname);
    if (!t || !(o.ownShell ?? isOperatorShell)(t)) return "not_own_shell";
  }
  return null;
}

/** Whether a request carries a proxy's forwarding headers. */
export function hasForwardingHeaders(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return Object.keys(headers).some((k) => {
    const h = k.toLowerCase();
    return h === "forwarded" || h === "via" || h.startsWith("x-forwarded-");
  });
}
