/**
 * Stat-keyed caches that don't decide agent state, read again
 * when their file changed within one clock tick (statSettled).
 * A file system stamps mtimes by a coarse clock, so a same-size rewrite
 * just after a read can keep every stamp a cache keyed on. Each case
 * rewrites a file at the same size and puts its mtime back with utimes:
 * the stat is the one the cache saw, the content isn't.
 *
 * 1. assertDenConfigValid: a config fixed (or broken) in one tick.
 * 2. repoFingerprint: an input file edited in one tick.
 * 3. runtimeVersion: a CLI rewritten in place in one tick.
 * 4. isQuarantined: an answer read from a file changed within a tick.
 * 5. The notifications store's lock: taken over and re-made in one tick,
 *    same inode and time, is told apart by its nonce (its own file; the
 *    pid file stays the plain pid an older Den reads).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const made: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-1598-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** Rewrites `file` with `text` (same size), keeping its inode and mtime. */
function sameTick(file: string, text: string): void {
  const st = fs.statSync(file);
  expect(Buffer.byteLength(text)).toBe(st.size);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, st.atime, st.mtime);
  const now = fs.statSync(file);
  expect([now.ino, now.size, now.mtimeMs]).toEqual([
    st.ino,
    st.size,
    st.mtimeMs,
  ]);
}

/** A whole-ms stamp, now: utimes keeps no sub-ms part. */
function stampNow(file: string): void {
  const t = new Date();
  fs.utimesSync(file, t, t);
}

describe("issue 1598: 1. assertDenConfigValid", () => {
  const org = (owner: string) =>
    `orgs:\n  north:\n    sources:\n      - { host: github, owner: ${owner} }\n`;

  it("a config fixed in one tick, same size: its verdict is read again", async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
    fs.mkdirSync(path.join(root, "config"));
    const file = path.join(root, "config", "den.yml");
    fs.writeFileSync(file, org("a_c")); // not a GitHub owner name
    stampNow(file);
    const saved = process.env.DEN_ROOT;
    process.env.DEN_ROOT = root;
    try {
      const cfg = await import("../../../src/shared/den-config.js");
      expect(() => cfg.assertDenConfigValid()).toThrow(/owner/);
      sameTick(file, org("abc"));
      expect(() => cfg.assertDenConfigValid()).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.DEN_ROOT;
      else process.env.DEN_ROOT = saved;
    }
  });
});

describe("issue 1598: 2. repoFingerprint", () => {
  it("an input file edited in one tick, same size: the fingerprint moves", async () => {
    const { repoFingerprint } =
      await import("../../../src/shared/environment-manager/derivation/cache.js");
    const dir = tmp();
    const mk = path.join(dir, "Makefile");
    fs.writeFileSync(mk, "up:\n\t@echo one\n");
    stampNow(mk);
    const a = repoFingerprint(dir);
    sameTick(mk, "up:\n\t@echo two\n");
    expect(repoFingerprint(dir)).not.toBe(a);
  });

  it("settled files: the same fingerprint, as before", async () => {
    const { repoFingerprint } =
      await import("../../../src/shared/environment-manager/derivation/cache.js");
    const dir = tmp();
    const mk = path.join(dir, "Makefile");
    fs.writeFileSync(mk, "up:\n\t@echo one\n");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(mk, old, old);
    expect(repoFingerprint(dir)).toBe(repoFingerprint(dir));
  });
});

describe("issue 1598: 3. runtimeVersion", () => {
  it("a CLI rewritten in place in one tick, same size: asked again", async () => {
    const rs = await import("../../../src/shared/agents/runtime-search.js");
    rs.clearVersionCache();
    const bin = path.join(tmp(), "claude");
    fs.writeFileSync(bin, '#!/bin/sh\necho "1.0.0 (Claude Code)"\n', {
      mode: 0o755,
    });
    stampNow(bin);
    expect(await rs.runtimeVersion(bin, ["--version"], {})).toBe("1.0.0");
    sameTick(bin, '#!/bin/sh\necho "2.0.0 (Claude Code)"\n');
    expect(await rs.runtimeVersion(bin, ["--version"], {})).toBe("2.0.0");
  });
});

describe("issue 1598: 4. isQuarantined", () => {
  it("an answer read from a file changed within a tick isn't kept", async () => {
    const rs = await import("../../../src/shared/agents/runtime-search.js");
    let on = false;
    rs.setQuarantineReader(() => on);
    try {
      const bin = path.join(tmp(), "claude");
      fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
      expect(rs.isQuarantined(bin)).toBe(false);
      // The attribute set in the same tick (its ctime unmoved on a coarse clock).
      on = true;
      expect(rs.isQuarantined(bin)).toBe(true);
    } finally {
      rs.setQuarantineReader(undefined);
    }
  });
});

describe("issue 1598: 5. the notifications store's lock", () => {
  it("re-made in one tick by another taker (same inode and time): kept, not taken", async () => {
    const n = await import("../../../src/shared/notifications.js");
    const lock = path.join(tmp(), "notifications.json.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), "2147483646"); // a holder that's gone
    const took = n.takeBackStoreLock(lock, {
      afterSeen: () => {
        // Another taker took it back and made its own in the same place, in
        // one tick: the same inode and mtime (its files rewritten in place
        // leave the folder's time alone), its own pid and nonce.
        fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
        fs.writeFileSync(path.join(lock, "nonce"), "n-other");
      },
    });
    expect(took).toBe(false);
    expect(fs.readFileSync(path.join(lock, "nonce"), "utf-8")).toBe("n-other");
  });

  it("re-made in one tick with the same pid text: the nonce alone tells it apart", async () => {
    const n = await import("../../../src/shared/notifications.js");
    const lock = path.join(tmp(), "notifications.json.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), "2147483646"); // a holder that's gone
    fs.writeFileSync(path.join(lock, "nonce"), "n-old");
    const took = n.takeBackStoreLock(lock, {
      afterSeen: () => {
        fs.writeFileSync(path.join(lock, "nonce"), "n-other");
      },
    });
    expect(took).toBe(false);
    expect(fs.readFileSync(path.join(lock, "nonce"), "utf-8")).toBe("n-other");
  });

  it("a lock it takes: its pid file is the plain pid (an older Den reads it), the nonce its own file", async () => {
    const n = await import("../../../src/shared/notifications.js");
    const file = path.join(tmp(), "notifications.json");
    expect(n.tryStoreLock(file)).toBe(true);
    const lock = `${file}.lock`;
    // How an older Den reads it: Number(text.trim()).
    const oldRead = Number(
      fs.readFileSync(path.join(lock, "pid"), "utf-8").trim(),
    );
    expect(oldRead).toBe(process.pid);
    expect(fs.readFileSync(path.join(lock, "nonce"), "utf-8")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("a stale lock, untouched: taken back, as before", async () => {
    const n = await import("../../../src/shared/notifications.js");
    const lock = path.join(tmp(), "notifications.json.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), "2147483646");
    expect(n.takeBackStoreLock(lock)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
