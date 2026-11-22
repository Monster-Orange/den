/**
 * Issue 816: setting up a test install's test person from your own Den,
 * in any browser.
 *
 * - A waiting test install whose launcher opts in (`<PREFIX>_TEST_ANNOUNCE=1`)
 *   announces itself on this computer: a 0600 file in a 0700 folder under
 *   the person's home, with its state folder, port and pid. No secret.
 * - The person's Den lists announcements, treating each as untrusted input
 *   (any process of this user can write one): the folder must be a real,
 *   0700, owned state folder with a web.secret, not the Den's own; the id is
 *   recomputed from it; the port is a whole number in 1024-65535 on
 *   127.0.0.1; the file is 0600, owned, at most 4 KB, never a symlink.
 * - At the person's Allow, the person's Den mints a one-use grant under a key
 *   derived from the test install's own web.secret (its own label, never the
 *   identity key's), good for 30 s by default (at most the Setting's
 *   maximum), and sends it once over loopback. The test install checks the
 *   MAC, its own id and the expiry, spends the grant first (failing closed),
 *   and only then writes the fixture key.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { product } from "./product.js";

export const TEST_ANNOUNCE_ENV_KEY = "TEST_ANNOUNCE";
/**
 * One tag per grant taken, in the test install's state folder. It only
 * grows: a test install takes a grant once, or a handful of times over its
 * life (Set up again), and its state folder goes with it.
 */
export const SETUP_GRANT_SPENT_FILE = "fixture-grant.spent";
export const SETUP_GRANT_DEFAULT_SECONDS = 30;
export const SETUP_GRANT_MAX_SECONDS = 120;
const ANNOUNCE_MAX_BYTES = 4096;
const GRANT_MAX_CHARS = 512;
const GRANT_KEY_LABEL = "den-816-setup-grant-v1";
const HEX16 = /^[0-9a-f]{16}$/;

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const uid = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

/** Where this user's test installs announce themselves: ~/.<cli>/test-installs. */
export function announceDir(home: string = os.homedir()): string {
  return path.join(home, `.${product().cli}`, "test-installs");
}

/** The install's id: sha256 of its state folder's real path, 16 hex. */
export function installIdOf(stateDir: string): string {
  return createHash("sha256").update(real(stateDir)).digest("hex").slice(0, 16);
}

export interface Announced {
  id: string;
  stateDir: string;
  port: number;
  pid: number;
  startedAt: string;
}

/** Write this test install's announcement (0600, in a 0700 folder). */
export function announceTestInstall(
  dir: string,
  o: { stateDir: string; port: number; pid: number; now?: Date },
): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const stateDir = real(o.stateDir);
  const id = installIdOf(stateDir);
  const body: Announced = {
    id,
    stateDir,
    port: o.port,
    pid: o.pid,
    startedAt: (o.now ?? new Date()).toISOString(),
  };
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Remove it (set up, no longer a test install, or exiting). */
export function unannounceTestInstall(dir: string, stateDir: string): void {
  try {
    fs.rmSync(path.join(dir, `${installIdOf(stateDir)}.json`), {
      force: true,
    });
  } catch {
    /* gone already */
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One file, read without following a link, checked; or null. */
function readAnnouncement(file: string): Announced | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600) return null;
    if (uid() !== null && st.uid !== uid()) return null;
    if (st.size > ANNOUNCE_MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    const v = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
    if (typeof v.stateDir !== "string" || !path.isAbsolute(v.stateDir))
      return null;
    if (
      typeof v.port !== "number" ||
      !Number.isInteger(v.port) ||
      v.port < 1024 ||
      v.port > 65535
    )
      return null;
    if (typeof v.pid !== "number" || !Number.isInteger(v.pid) || v.pid < 1)
      return null;
    return {
      id: "",
      stateDir: v.stateDir,
      port: v.port,
      pid: v.pid,
      startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Whether `stateDir` looks like a test install's own state folder. */
function stateDirOk(stateDir: string, ownStateDir: string): boolean {
  try {
    const st = fs.lstatSync(stateDir);
    if (!st.isDirectory() || (st.mode & 0o777) !== 0o700) return false;
    if (uid() !== null && st.uid !== uid()) return false;
    if (real(stateDir) !== stateDir) return false;
    if (real(stateDir) === real(ownStateDir)) return false;
    const secret = fs.lstatSync(path.join(stateDir, "web.secret"));
    return secret.isFile();
  } catch {
    return false;
  }
}

/**
 * The announcements that pass every check, each id recomputed; a live pid
 * only. The caller still proves each port with the identity probe.
 */
export function listAnnounced(
  dir: string,
  o: { ownStateDir: string },
): Announced[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Announced[] = [];
  for (const n of names.sort()) {
    const a = readAnnouncement(path.join(dir, n));
    if (!a || !stateDirOk(a.stateDir, o.ownStateDir) || !alive(a.pid)) continue;
    out.push({ ...a, id: installIdOf(a.stateDir) });
  }
  return out;
}

/** The grant's key: its own label, never the identity key's. */
export function setupGrantKey(secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(GRANT_KEY_LABEL).digest();
}

const macOf = (secret: Buffer, msg: string) =>
  createHmac("sha256", setupGrantKey(secret)).update(msg).digest("base64url");

/** `v1.<id>.<from>.<nonce>.<exp>.<mac>`: minted in memory, sent once. */
export function mintSetupGrant(o: {
  secret: Buffer;
  id: string;
  from: string;
  ttlSeconds?: number;
  now?: number;
}): string {
  const exp = Math.floor(
    ((o.now ?? Date.now()) +
      (o.ttlSeconds ?? SETUP_GRANT_DEFAULT_SECONDS) * 1000) /
      1000,
  );
  const nonce = randomBytes(16).toString("hex");
  const head = ["v1", o.id, o.from, nonce, String(exp)];
  return [...head, macOf(o.secret, head.join("|"))].join(".");
}

export type GrantRefusal =
  | "bad_grant"
  | "not_this_install"
  | "expired"
  | "too_long"
  | "spent"
  | "cannot_spend";

const spentTag = (g: string) =>
  createHash("sha256").update(`den-816-grant-spent-v1:${g}`).digest("hex");

/**
 * Check a grant for this install (its secret and state folder) and spend
 * it. Spent first: the tag is appended before success, and a failed append
 * refuses.
 */
export function takeSetupGrant(
  grant: string,
  o: { secret: Buffer; stateDir: string; now?: number; maxSeconds?: number },
): { ok: true; from: string } | { ok: false; code: GrantRefusal } {
  if (typeof grant !== "string" || grant.length > GRANT_MAX_CHARS)
    return { ok: false, code: "bad_grant" };
  const parts = grant.split(".");
  if (parts.length !== 6 || parts[0] !== "v1")
    return { ok: false, code: "bad_grant" };
  const [, id, from, nonce, expS, mac] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!HEX16.test(id) || !HEX16.test(from) || !/^[0-9a-f]{32}$/.test(nonce))
    return { ok: false, code: "bad_grant" };
  if (!/^\d{1,12}$/.test(expS)) return { ok: false, code: "bad_grant" };
  const want = Buffer.from(
    macOf(o.secret, parts.slice(0, 5).join("|")),
    "utf8",
  );
  const got = Buffer.from(mac, "utf8");
  const a = createHash("sha256").update(want).digest();
  const b = createHash("sha256").update(got).digest();
  if (!timingSafeEqual(a, b)) return { ok: false, code: "bad_grant" };
  if (id !== installIdOf(o.stateDir))
    return { ok: false, code: "not_this_install" };
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const exp = Number(expS);
  const max = Math.min(
    o.maxSeconds ?? SETUP_GRANT_MAX_SECONDS,
    SETUP_GRANT_MAX_SECONDS,
  );
  if (exp <= now) return { ok: false, code: "expired" };
  if (exp - now > max) return { ok: false, code: "too_long" };
  const file = path.join(o.stateDir, SETUP_GRANT_SPENT_FILE);
  const tag = spentTag(grant);
  let spent = "";
  try {
    spent = fs.readFileSync(file, "utf8");
  } catch {
    spent = "";
  }
  if (spent.split("\n").includes(tag)) return { ok: false, code: "spent" };
  try {
    fs.appendFileSync(file, tag + "\n", { mode: 0o600 });
  } catch {
    return { ok: false, code: "cannot_spend" };
  }
  return { ok: true, from };
}
