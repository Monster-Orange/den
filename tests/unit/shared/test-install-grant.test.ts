/**
 * Issue 816: setting up a test install's test person from your own Den.
 * The pieces the server routes are built on, tested alone:
 *  - the announcement a waiting test install writes on this computer
 *    (0600, in a 0700 folder, no secret), and its removal;
 *  - the one-use grant your Den mints at the person's Allow, and how the
 *    test install checks it (MAC, its own id, expiry, spent first, fails
 *    closed). The grant is bound to the install that minted it.
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import { createHmac } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  announceTestInstall,
  installIdOf,
  listAnnounced,
  mintSetupGrant,
  setupGrantKey,
  takeSetupGrant,
  unannounceTestInstall,
} from "../../../src/shared/test-install-grant.js";
import { identityKey } from "../../../src/shared/den-identity.js";

let tmp = "";
let dir = "";
let stateDir = "";
const secret = Buffer.alloc(32, 7);
const otherSecret = Buffer.alloc(32, 9);
const NOW = 1_800_000_000_000;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-816-")));
  dir = path.join(tmp, "test-installs");
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  fs.writeFileSync(path.join(stateDir, "web.secret"), secret, { mode: 0o600 });
});

describe("the announcement", () => {
  it("is 0600 in a 0700 folder, names the install, and holds no secret", () => {
    announceTestInstall(dir, { stateDir, port: 4321, pid: process.pid });
    const id = installIdOf(stateDir);
    const file = path.join(dir, `${id}.json`);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const body = fs.readFileSync(file, "utf8");
    expect(JSON.parse(body)).toMatchObject({
      id,
      stateDir,
      port: 4321,
      pid: process.pid,
    });
    expect(body).not.toContain(secret.toString("hex"));
    expect(body).not.toContain(secret.toString("base64"));
  });

  it("the id is the state folder's, stable, 16 hex", () => {
    expect(installIdOf(stateDir)).toMatch(/^[0-9a-f]{16}$/);
    expect(installIdOf(stateDir)).toBe(installIdOf(stateDir + "/"));
  });

  it("is removed on unannounce; listing skips a dead pid and a torn file", () => {
    announceTestInstall(dir, { stateDir, port: 4321, pid: process.pid });
    const dead = path.join(tmp, "dead");
    fs.mkdirSync(dead);
    announceTestInstall(dir, { stateDir: dead, port: 4322, pid: 2 ** 22 + 1 });
    fs.writeFileSync(path.join(dir, "torn.json"), "{not json", { mode: 0o600 });
    const opts = { ownStateDir: path.join(tmp, "own-den") };
    expect(listAnnounced(dir, opts).map((a) => a.port)).toEqual([4321]);
    unannounceTestInstall(dir, stateDir);
    expect(listAnnounced(dir, opts)).toEqual([]);
  });
});

describe("the grant", () => {
  const mint = (o: Partial<{ s: Buffer; id: string; now: number }> = {}) =>
    mintSetupGrant({
      secret: o.s ?? secret,
      id: o.id ?? installIdOf(stateDir),
      from: "aaaaaaaaaaaaaaaa",
      ttlSeconds: 120,
      now: o.now ?? NOW,
    });
  const take = (grant: string, now = NOW + 1_000) =>
    takeSetupGrant(grant, { secret, stateDir, now });

  it("a fresh grant from this install's key is taken once", () => {
    const g = mint();
    expect(take(g)).toEqual({ ok: true, from: "aaaaaaaaaaaaaaaa" });
    expect(take(g)).toEqual({ ok: false, code: "spent" });
  });

  it("stays spent across a restart (the spent file)", () => {
    const g = mint();
    expect(take(g).ok).toBe(true);
    expect(takeSetupGrant(g, { secret, stateDir, now: NOW + 2_000 })).toEqual({
      ok: false,
      code: "spent",
    });
  });

  it("refuses a grant made with another key", () => {
    expect(take(mint({ s: otherSecret }))).toEqual({
      ok: false,
      code: "bad_grant",
    });
  });

  it("refuses a grant for another install", () => {
    expect(take(mint({ id: "0123456789abcdef" }))).toEqual({
      ok: false,
      code: "not_this_install",
    });
  });

  it("refuses an expired grant", () => {
    expect(take(mint(), NOW + 121_000)).toEqual({
      ok: false,
      code: "expired",
    });
  });

  it("refuses something that isn't a grant, without throwing", () => {
    for (const g of ["", "v1", "v2.a.b.c.d.e", "x".repeat(2000)])
      expect(take(g).ok).toBe(false);
  });

  it("fails closed when the spent file can't be written", () => {
    const g = mint();
    fs.chmodSync(stateDir, 0o500);
    try {
      expect(take(g)).toEqual({ ok: false, code: "cannot_spend" });
    } finally {
      fs.chmodSync(stateDir, 0o700);
    }
  });

  it("a tampered expiry fails the MAC", () => {
    const parts = mint().split(".");
    parts[4] = String(Number(parts[4]) + 600);
    expect(take(parts.join("."))).toEqual({ ok: false, code: "bad_grant" });
  });
});

describe("review: the announcement is untrusted input", () => {
  const own = () => path.join(tmp, "own-den");
  const live = () => listAnnounced(dir, { ownStateDir: own() });
  /** A test install's state folder as one really looks: 0700, its web.secret. */
  function realState(name: string): string {
    const s = path.join(tmp, name);
    fs.mkdirSync(s, { recursive: true, mode: 0o700 });
    fs.chmodSync(s, 0o700);
    fs.writeFileSync(path.join(s, "web.secret"), secret, { mode: 0o600 });
    return s;
  }
  const announce = (s: string, port = 4321) =>
    announceTestInstall(dir, { stateDir: s, port, pid: process.pid });
  const fileOf = (s: string) => path.join(dir, `${installIdOf(s)}.json`);
  const rewrite = (s: string, patch: Record<string, unknown>) => {
    const f = fileOf(s);
    const v = { ...JSON.parse(fs.readFileSync(f, "utf8")), ...patch };
    fs.writeFileSync(f, JSON.stringify(v), { mode: 0o600 });
  };

  it("a real one is listed, with the id recomputed from its folder", () => {
    const s = realState("a");
    announce(s);
    rewrite(s, { id: "ffffffffffffffff" });
    expect(live().map((a) => a.id)).toEqual([installIdOf(s)]);
  });

  it("a folder that isn't 0700 is not listed", () => {
    const s = realState("b");
    announce(s);
    fs.chmodSync(s, 0o755);
    expect(live()).toEqual([]);
  });

  it("a folder with no web.secret is not listed", () => {
    const s = realState("c");
    fs.rmSync(path.join(s, "web.secret"));
    announce(s);
    expect(live()).toEqual([]);
  });

  it("this Den's own state folder is never listed", () => {
    fs.mkdirSync(own(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(own(), "web.secret"), secret);
    announce(own());
    expect(live()).toEqual([]);
  });

  it("a port outside 1024-65535, or not a whole number, is not listed", () => {
    for (const [i, port] of [80, 70000, 4321.5, -1].entries()) {
      const s = realState(`p${i}`);
      announce(s);
      rewrite(s, { port });
    }
    expect(live()).toEqual([]);
  });

  it("a file that isn't 0600, is over 4 KB, or is a symlink is not listed", () => {
    const loose = realState("loose");
    announce(loose);
    fs.chmodSync(fileOf(loose), 0o644);
    const big = realState("big");
    announce(big);
    rewrite(big, { pad: "x".repeat(5000) });
    const linked = realState("linked");
    announce(linked);
    const real = path.join(tmp, "elsewhere.json");
    fs.renameSync(fileOf(linked), real);
    fs.symlinkSync(real, fileOf(linked));
    expect(live()).toEqual([]);
  });
});

describe("review: the grant's lifetime and its key", () => {
  const take = (grant: string, now: number) =>
    takeSetupGrant(grant, { secret, stateDir, now, maxSeconds: 120 });
  const mintAt = (ttlSeconds: number) =>
    mintSetupGrant({
      secret,
      id: installIdOf(stateDir),
      from: "aaaaaaaaaaaaaaaa",
      ttlSeconds,
      now: NOW,
    });

  it("an expiry further ahead than the maximum is refused", () => {
    expect(take(mintAt(600), NOW + 1_000)).toEqual({
      ok: false,
      code: "too_long",
    });
  });

  it("the default lifetime is 30 s", () => {
    const g = mintSetupGrant({
      secret,
      id: installIdOf(stateDir),
      from: "aaaaaaaaaaaaaaaa",
      now: NOW,
    });
    expect(take(g, NOW + 31_000)).toEqual({ ok: false, code: "expired" });
  });

  it("a grant made under the identity key (den-identity-v1) is refused", () => {
    const parts = mintAt(30).split(".");
    const msg = parts.slice(0, 5).join("|");
    parts[5] = createHmac("sha256", identityKey(secret))
      .update(msg)
      .digest("base64url");
    expect(take(parts.join("."), NOW + 1_000)).toEqual({
      ok: false,
      code: "bad_grant",
    });
  });

  it("the grant's key is not the identity key", () => {
    expect(setupGrantKey(secret).equals(identityKey(secret))).toBe(false);
  });
});
