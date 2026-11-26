/**
 * Issue 1299 (with issue 1300): every write to the sessions file takes
 * web-sessions.lock and re-reads the file under it, so a server write and
 * another process's write (`web logout` with no server answering) never
 * lose each other's change. A holder that runs makes a writer wait up to
 * `web.sessions_lock_wait_ms` (default 2000), then the write is refused
 * ("try again"); a lock its holder left behind is taken over.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  lockUnlinkIfUnchanged,
  readWebAuthConfig,
  SESSIONS_LOCK_WAIT_MS,
  SessionStoreUnreadable,
  WEB_SESSIONS_LOCK,
  WebSessionStore,
  webSessionsPath,
} from "../../../src/shared/web-session.js";
import {
  patchCliRows,
  PERSON_ONLY_SETTINGS,
} from "../../../src/shared/settings-cli-rows.js";
import { readSettingsSources } from "../server/helpers/settings-sources.js";

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1299l-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const secret = randomBytes(32);
const store = (waitMs = 50) =>
  new WebSessionStore({
    stateDir: () => tmp,
    secret: () => secret,
    lockWaitMs: () => waitMs,
  });
const lockFile = () => path.join(tmp, WEB_SESSIONS_LOCK);
const onDisk = () =>
  Object.keys(
    JSON.parse(fs.readFileSync(webSessionsPath(tmp), "utf-8")).sessions,
  ).length;

/** Issue 1582: a whole-second time both files are pinned to (utimes drops sub-ms). */
const T = 1_700_000_000;
describe("issue 1299: the sessions lock", () => {
  it("two writers, one after the other, never lose each other's sessions", () => {
    const server = store();
    const other = store();
    const a = server.create({ host: "a" });
    const b = other.create({ host: "b" });
    server.create({ host: "c" });
    expect(onDisk()).toBe(3);
    // The other ends a; the server's next write doesn't bring it back.
    other.end(a.session.key);
    server.create({ host: "d" });
    expect(onDisk()).toBe(3);
    expect(server.lookup(a.id)).toBeNull();
    expect(server.lookup(b.id)).not.toBeNull();
  });

  it("issue 1582: a session ended in a file rewritten with the same inode, size and mtime is ended here too", () => {
    const server = store();
    const a = server.create({ host: "a" });
    const file = webSessionsPath(tmp);
    fs.utimesSync(file, T, T);
    // The server reads the file at its pinned mtime, and keeps it.
    expect(server.list().map((s) => s.key)).toEqual([a.session.key]);
    const before = fs.statSync(file);
    // Another process ends the session: the record's key is replaced by
    // one of the same length (the file keeps its size), written in place
    // (its inode kept), its mtime pinned again.
    const text = fs.readFileSync(file, "utf-8");
    const gone = text.replace(a.session.key, "0".repeat(a.session.key.length));
    expect(gone).not.toBe(text);
    fs.writeFileSync(file, gone);
    fs.utimesSync(file, T, T);
    const after = fs.statSync(file);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([
      before.ino,
      before.size,
      before.mtimeMs,
    ]);
    expect(server.lookup(a.id)).toBeNull();
    expect(server.list().map((s) => s.key)).not.toContain(a.session.key);
  });

  it("a write leaves no lock behind", () => {
    store().create({});
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("a running holder: the write waits its time, then is refused, changing nothing", () => {
    const s = store(80);
    s.create({ host: "a" });
    // A process that runs (this test's parent) holds the lock.
    fs.writeFileSync(lockFile(), `${process.ppid}\n`, { mode: 0o600 });
    const t0 = Date.now();
    expect(() => s.create({ host: "b" })).toThrow(SessionStoreUnreadable);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    expect(() => s.create({})).toThrow(/try again/);
    expect(onDisk()).toBe(1);
    // Still its holder's.
    expect(fs.readFileSync(lockFile(), "utf-8").trim()).toBe(
      String(process.ppid),
    );
    fs.unlinkSync(lockFile());
    s.create({ host: "b" });
    expect(onDisk()).toBe(2);
  });

  it("a lock its holder left behind (that pid no longer runs) is taken over", () => {
    const s = store();
    fs.writeFileSync(lockFile(), "2147483646\n", { mode: 0o600 });
    s.create({});
    expect(onDisk()).toBe(1);
    expect(fs.existsSync(lockFile())).toBe(false);
  });
});

describe("issue 1299: web.sessions_lock_wait_ms", () => {
  const user = (body: string) => {
    fs.mkdirSync(path.join(tmp, "config/local"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config/local/user.yml"), body);
  };

  it("defaults to 2000 ms; a whole number from 0 to 30000", () => {
    expect(SESSIONS_LOCK_WAIT_MS).toBe(2000);
    expect(readWebAuthConfig(tmp).sessionsLockWaitMs).toBe(2000);
    user("web:\n  sessions_lock_wait_ms: 500\n");
    expect(readWebAuthConfig(tmp).sessionsLockWaitMs).toBe(500);
    user("web:\n  sessions_lock_wait_ms: 0\n");
    expect(readWebAuthConfig(tmp).sessionsLockWaitMs).toBe(0);
    user("web:\n  sessions_lock_wait_ms: 30001\n");
    expect(() => readWebAuthConfig(tmp)).toThrow(/web.sessions_lock_wait_ms/);
    user('web:\n  sessions_lock_wait_ms: "soon"\n');
    expect(() => readWebAuthConfig(tmp)).toThrow(/0 to 30000/);
  });

  it("Settings writes it; a person's only", () => {
    const u: Record<string, unknown> = { web: { approve_attempts: 3 } };
    expect(patchCliRows(u, { web_sessions: { lock_wait_ms: 500 } })).toEqual({
      ok: true,
    });
    expect(u.web).toEqual({ approve_attempts: 3, sessions_lock_wait_ms: 500 });
    expect(patchCliRows(u, { web_sessions: { lock_wait_ms: 30001 } }).ok).toBe(
      false,
    );
    expect(PERSON_ONLY_SETTINGS).toContain("web_sessions");
  });

  it("has a Settings row, words in en/es/ja, and a config name", () => {
    const pub = path.join(__dirname, "../../../src/ui/server/public");
    const read = (f: string) => fs.readFileSync(path.join(pub, f), "utf-8");
    expect(readSettingsSources()).toMatch(
      /id: "access\.sessions_lock_wait"[\s\S]{0,900}web_sessions\.lock_wait_ms/,
    );
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      expect([f, read(f).includes('"set.access.sessions_lock_wait":')]).toEqual(
        [f, true],
      );
      expect([
        f,
        read(f).includes('"set.access.sessions_lock_wait.d":'),
      ]).toEqual([f, true]);
    }
    const cfg = fs.readFileSync(
      path.join(__dirname, "../../../src/ui/cli/config-command.ts"),
      "utf-8",
    );
    expect(cfg).toMatch(
      /"web\.sessions_lock_wait_ms": \["web_sessions", "lock_wait_ms"\]/,
    );
    const srv = fs.readFileSync(
      path.join(__dirname, "../../../src/ui/server/index.ts"),
      "utf-8",
    );
    expect(srv).toMatch(/lockWaitMs: \(\) =>/);
    expect(srv).toMatch(/web_sessions: body\.web_sessions/);
  });
});

describe("issue 1299 review: the server never stalls on the lock", () => {
  it("a lookup's touch skips a held lock at once, and still answers", () => {
    let now = Date.UTC(2026, 10, 23, 8, 0, 0);
    const s = new WebSessionStore({
      stateDir: () => tmp,
      secret: () => secret,
      now: () => now,
      lockWaitMs: () => 2000,
    });
    const a = s.create({ host: "a" });
    now += 5 * 60_000; // the touch is due
    fs.writeFileSync(lockFile(), `${process.ppid}\n`, { mode: 0o600 });
    const t0 = Date.now();
    expect(s.lookup(a.id)).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("whenFree waits without blocking: timers run meanwhile, and it says no once its time is up", async () => {
    const s = store(0);
    fs.writeFileSync(lockFile(), `${process.ppid}\n`, { mode: 0o600 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const t0 = Date.now();
    const free = await s.whenFree(200);
    clearInterval(timer);
    expect(free).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    expect(ticks).toBeGreaterThan(10);
  });

  it("whenFree says yes once the holder lets go, or when the holder is gone", async () => {
    const s = store(0);
    fs.writeFileSync(lockFile(), `${process.ppid}\n`, { mode: 0o600 });
    setTimeout(() => fs.unlinkSync(lockFile()), 50);
    expect(await s.whenFree(2000)).toBe(true);
    fs.writeFileSync(lockFile(), "2147483646\n", { mode: 0o600 });
    expect(await s.whenFree(2000)).toBe(true);
    expect(await s.whenFree(0)).toBe(true);
  });

  it("the server's store never waits in a write; its requests wait in whenFree", () => {
    const srv = fs.readFileSync(
      path.join(__dirname, "../../../src/ui/server/index.ts"),
      "utf-8",
    );
    expect(srv).toMatch(/lockWaitMs: \(\) => 0,/);
    expect(srv).toMatch(/await webSessions\.whenFree\(/);
  });
});

describe("issue 1299 review: a stale lock is unlinked only if it's still the one read", () => {
  it("a lock replaced since it was looked at stays", () => {
    fs.writeFileSync(lockFile(), "2147483646\n", { mode: 0o600 });
    const seen = fs.statSync(lockFile());
    const seenText = fs.readFileSync(lockFile(), "utf-8");
    // Another writer took it over meanwhile: a new file (on a fast disk it
    // can keep the inode and mtime; its text tells it apart, issue 1582).
    fs.unlinkSync(lockFile());
    fs.writeFileSync(lockFile(), `${process.pid}\n`, { mode: 0o600 });
    expect(lockUnlinkIfUnchanged(lockFile(), seen, seenText)).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(true);
    expect(lockUnlinkIfUnchanged(lockFile(), fs.statSync(lockFile()))).toBe(
      true,
    );
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("issue 1582: a lock replaced with the same inode and mtime stays (its text differs)", () => {
    fs.writeFileSync(lockFile(), "2147483646 aaaaaaaaaaaaaaaa\n", {
      mode: 0o600,
    });
    fs.utimesSync(lockFile(), T, T);
    const seen = fs.statSync(lockFile());
    const seenText = fs.readFileSync(lockFile(), "utf-8");
    // Taken over in place, its times put back: the stat matches.
    fs.writeFileSync(lockFile(), `${process.pid} bbbbbbbbbbbbbbbb\n`);
    fs.utimesSync(lockFile(), T, T);
    const now = fs.statSync(lockFile());
    expect([now.ino, now.mtimeMs]).toEqual([seen.ino, seen.mtimeMs]);
    expect(lockUnlinkIfUnchanged(lockFile(), seen, seenText)).toBe(false);
    expect(fs.existsSync(lockFile())).toBe(true);
  });

  it("issue 1582: a lock taken records a nonce after the pid, and its release reads both", () => {
    const release = store().lock();
    const text = fs.readFileSync(lockFile(), "utf-8");
    expect(text).toMatch(new RegExp(`^${process.pid} [0-9a-f]{16}\\n$`));
    // Another take by this same pid (a nonce of its own) isn't released.
    fs.writeFileSync(lockFile(), `${process.pid} ffffffffffffffff\n`);
    release();
    expect(fs.existsSync(lockFile())).toBe(true);
    // Nor an older Den's lock, a bare pid (only the stale take-over may).
    fs.writeFileSync(lockFile(), `${process.pid}\n`);
    release();
    expect(fs.existsSync(lockFile())).toBe(true);
  });
});
