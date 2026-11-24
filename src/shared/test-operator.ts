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
 *    that came through a proxy (forwarded headers) is refused, with one
 *    exception (issue 1034): attaching or closing its own shell through
 *    the install's own proved edge, from this machine.
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
import { isServerScope } from "./agents/server-agent.js";
import { writeFileAtomic } from "./atomic-write.js";
import { WEB_SECRET_FILE } from "./web-secret.js";

/** The test operator's principal in the audit trail. */
export const OPERATOR_PRINCIPAL = "test:operator";
/** What logs call it. */
export const OPERATOR_LABEL = "test operator";
/** The creation record, in the state folder (0600). */
export const CREATION_RECORD_FILE = "test-install.created";
/** What the record holds until the server seals it, at its first start. */
export const CREATION_PENDING = "pending";

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
 * At the server's first start on a state folder (issue 814; issue 1407,
 * Vision's ruling): the birth of a test install is the start that has the
 * launcher's test flag and creates the install's secret. So: the flag,
 * a folder that isn't the product's default and isn't a link, and no
 * secret in it yet (no start has made one), and nothing else in it but
 * what `web up` wrote before the server started (its log) and a pending
 * record a start that died left. Then the folder
 * is claimed with the pending creation record, made exclusively (0600),
 * which this start seals with the secret it creates. An install that ran
 * before has its secret, so it is never claimed, and nothing in it is
 * touched.
 */
export function claimAtBirth(o: {
  stateDir: string;
  defaultStateDir: string;
  launchFlag: boolean;
  /** The product's CLI name: `web up`'s log is logs/<cli>/web.log. */
  cli?: string;
}): boolean {
  if (!o.launchFlag) return false;
  if (realOrResolved(o.stateDir) === realOrResolved(o.defaultStateDir))
    return false;
  try {
    try {
      const st = fs.lstatSync(o.stateDir);
      if (!st.isDirectory()) return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    // Any entry under the secret's name (a file, a link, a folder): an
    // install that ran, or something to stay away from. No claim.
    try {
      fs.lstatSync(path.join(o.stateDir, WEB_SECRET_FILE));
      return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    // Reviewer C and Builder 2: a real install that lost its secret (deleted
    // by hand) has no secret either. So before the claim, the folder may
    // hold only what the launcher writes before the server starts (`web
    // up`'s own log) and a pending record a start that died left.
    if (!onlyLauncherFiles(o.stateDir, o.cli)) return false;
    fs.mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    const f = creationRecordPath(o.stateDir);
    try {
      writeFileAtomic(f, `${CREATION_PENDING}\n`, {
        exclusive: true,
        mode: 0o600,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      // A first start that died before its secret left its claim.
      const st = fs.lstatSync(f);
      if (!st.isFile() || (st.mode & 0o077) !== 0) return false;
      if (fs.readFileSync(f, "utf-8").trim() !== CREATION_PENDING) return false;
    }
    return !fs.lstatSync(o.stateDir).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether `p` is a real folder (not a link) holding exactly `names`. */
function folderOf(p: string, names: readonly string[]): boolean {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return false;
  const have = fs.readdirSync(p).sort();
  return have.length === names.length && have.every((n, i) => n === names[i]);
}

/**
 * Whether the state folder (missing counts) holds nothing but what the
 * launcher writes before the server's first start: logs/<cli>/web.log, a
 * regular file, and the creation record. The record itself is judged by
 * claimAtBirth (a 0600 file holding exactly the pending mark).
 */
function onlyLauncherFiles(stateDir: string, cli: string | undefined): boolean {
  let top: string[];
  try {
    top = fs.readdirSync(stateDir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  for (const n of top) {
    if (n === CREATION_RECORD_FILE) continue;
    if (n !== "logs" || !cli) return false;
    const logs = path.join(stateDir, "logs");
    const own = path.join(logs, cli);
    if (!folderOf(logs, [cli]) || !folderOf(own, ["web.log"])) return false;
    if (!fs.lstatSync(path.join(own, "web.log")).isFile()) return false;
  }
  return true;
}

/**
 * The server's birth step: claim (claimAtBirth), or else drop a pending
 * record left there, so a pending record is only ever sealed by the start
 * that claimed it. A sealed record is left for verifiedCreationRecord to
 * judge: one copied in from another install fails there.
 */
export function birthClaim(o: {
  stateDir: string;
  defaultStateDir: string;
  launchFlag: boolean;
  cli?: string;
}): boolean {
  if (claimAtBirth(o)) return true;
  dropPendingRecord(o.stateDir);
  return false;
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
  writeFileAtomic(
    f,
    `v1.${at}.${sealOf(stateDir, at, secret).toString("base64url")}\n`,
    { mode: 0o600 },
  );
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
 *  - terminal-start: Terminal opens a test terminal, Den's fixed stub
 *    (never a shell); the cap's 429 (448, 503). No `cwd`.
 *  - terminal-attach, terminal-close: the operator's own shells only
 *    (448, 653; a check closes what it opened).
 *  - agent-say: a message to a project agent, the 409 while it shows a
 *    dialog (629, 659). Never the server agent.
 *  - agent-relaunch: Resume after a relaunch that exits early (658). A
 *    project agent only.
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

/**
 * The test terminals the test operator started, by their session host id
 * only (never a name: a name can be reused by an agent), in this server's
 * memory. Forgotten when closed or found ended.
 */
const OWN_SHELLS = new Set<string>();
export function rememberOperatorShell(hostId: string): void {
  if (hostId) OWN_SHELLS.add(hostId);
}
export function isOperatorShell(hostId: string): boolean {
  return OWN_SHELLS.has(hostId);
}
export function forgetOperatorShell(hostId: string): void {
  OWN_SHELLS.delete(hostId);
}

/**
 * The Builder's decision (a): the test operator's terminal is never a
 * shell. It runs Den's own node on this fixed script, which echoes what is
 * typed and does nothing else: it loads no module, reads no file, starts
 * no process and reads no environment. Live checks need a terminal that
 * opens, starts and takes focus; this is one.
 */
export const OPERATOR_STUB_SCRIPT =
  'process.stdin.on("data",(b)=>process.stdout.write(b));' +
  'process.stdin.on("end",()=>process.exit(0));';

/** The test terminal's command: nothing in it comes from a request. */
export function operatorStubArgv(): string[] {
  return [process.execPath, "-e", OPERATOR_STUB_SCRIPT];
}

/** The test terminal's whole env: no home, root, path or credential. */
export function operatorStubEnv(): Record<string, string> {
  return { TERM: "xterm-256color" };
}

export type OperatorRefusal =
  | "not_an_act"
  | "not_operator_install"
  | "not_loopback"
  | "forwarded"
  | "not_own_shell"
  | "server_agent";

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
  /**
   * Via the install's own edge, with its proof, from a client the edge
   * attests is this machine (request-guard: GuardResult.edgeLocal).
   */
  edgeLocal?: boolean;
  ownShell?: (key: string) => boolean;
}): OperatorRefusal | null {
  const act = operatorAct(o.method, o.pathname);
  if (!act) return "not_an_act";
  if (!o.operatorInstall) return "not_operator_install";
  // Issue 1034: attach and close of the operator's own shell may come through
  // the install's own edge (proved, and it attests this machine's client), so
  // a live check proves the terminal path through the edge (gate 653). Every
  // other act, and every other way in, stays loopback-only and unforwarded.
  const ownEdge =
    (act === "terminal-attach" || act === "terminal-close") &&
    o.via === "edge" &&
    !o.beyond &&
    o.edgeLocal === true;
  if (!ownEdge) {
    if (o.via !== "loopback" || o.beyond) return "not_loopback";
    if (o.forwarded) return "forwarded";
  }
  // say and relaunch reach this install's project agents only, never the
  // server agent (its held writes are not the checks' to drive).
  if (act === "agent-say" || act === "agent-relaunch") {
    const ws = /^\/api\/workspaces\/([^/]+)\//.exec(o.pathname)?.[1] ?? "";
    let name = ws;
    try {
      name = decodeURIComponent(ws);
    } catch {
      return "server_agent";
    }
    if (isServerScope(name)) return "server_agent";
  }
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
