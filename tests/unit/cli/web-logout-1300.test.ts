/**
 * Issue 1300: `web logout` never writes a stale copy of the sessions file.
 *
 *   1. With a server running, it never writes the file itself. A server
 *      that doesn't answer in time gets "Den didn't answer; nothing was
 *      changed", never a direct write. A session made while it waited
 *      survives.
 *   2. It writes the file only when nothing listens on the port (checked,
 *      not assumed from a timeout), under the sessions lock, re-reading
 *      under it and ending only the sessions it means to. If another
 *      process holds the lock, it says so and changes nothing.
 *   3. Every end it makes is in the activity trail with why (issue 1295).
 *
 * No session key, cookie or token is printed by a test.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

jest.mock("../../../src/shared/edge/config.js", () => ({
  readWebPort: () => 7777,
}));
import { cmdWebLogout } from "../../../src/ui/cli/web-command.js";
import {
  WEB_SESSIONS_LOCK,
  WebSessionStore,
  webSessionsPath,
} from "../../../src/shared/web-session.js";
import { ensureWebSecret } from "../../../src/shared/web-secret.js";
import { AUDIT_FILE } from "../../../src/shared/audit-file.js";

let tmp = "";
const servers: http.Server[] = [];
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-wlo-")));
  ensureWebSecret(tmp);
});
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const store = () =>
  new WebSessionStore({
    stateDir: () => tmp,
    secret: () => ensureWebSecret(tmp),
  });
const keys = () =>
  store()
    .list()
    .map((s) => s.key)
    .sort();

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const p = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return p;
}

/** A server that takes the call and never answers; runs `meanwhile` on it. */
async function slowServer(meanwhile: () => void): Promise<number> {
  const srv = http.createServer(() => meanwhile());
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return (srv.address() as AddressInfo).port;
}

const io = () => {
  const o = { out: "", err: "" };
  return {
    o,
    io: {
      out: (x: string) => (o.out += x),
      err: (x: string) => (o.err += x),
      stateDir: tmp,
      callTimeoutMs: 300,
    },
  };
};

describe("a server that is running but slow", () => {
  it("logout never writes the file, says so, and a session made while it waited survives", async () => {
    const before = store().create({ userAgent: "before" }).session.key;
    let during = "";
    const port = await slowServer(() => {
      during = store().create({ userAgent: "during" }).session.key;
    });
    const bytes = () => fs.readFileSync(webSessionsPath(tmp), "utf-8");
    const a = io();
    const code = await cmdWebLogout(["--port", String(port)], a.io);
    expect(code).toBe(1);
    expect(a.o.err).toMatch(/didn't answer/);
    expect(a.o.err).toMatch(/nothing was changed/i);
    expect(a.o.out).not.toMatch(/Signed out/);
    expect(during).not.toBe("");
    // Both sessions stand: no direct write happened.
    expect(keys()).toEqual([before, during].sort());
    const after = bytes();
    expect(after).toContain(during);
  }, 15_000);

  it("logout <id> on a slow server changes nothing either", async () => {
    const one = store().create({ userAgent: "one" }).session.key;
    const port = await slowServer(() => {});
    const a = io();
    expect(
      await cmdWebLogout([one.slice(0, 8), "--port", String(port)], a.io),
    ).toBe(1);
    expect(keys()).toEqual([one]);
  }, 15_000);
});

describe("no server: the state files, under the lock", () => {
  it("logout <id> ends that session only; others stay", async () => {
    const one = store().create({ userAgent: "one" }).session.key;
    const two = store().create({ userAgent: "two" }).session.key;
    const a = io();
    expect(
      await cmdWebLogout(
        [one.slice(0, 8), "--port", String(await freePort())],
        a.io,
      ),
    ).toBe(0);
    expect(keys()).toEqual([two]);
  });

  it("another process holding the sessions lock: says so and changes nothing", async () => {
    const one = store().create({ userAgent: "one" }).session.key;
    // pid 1 always runs (and isn't ours).
    fs.writeFileSync(path.join(tmp, WEB_SESSIONS_LOCK), "1\n");
    const a = io();
    expect(await cmdWebLogout(["--port", String(await freePort())], a.io)).toBe(
      1,
    );
    expect(a.o.err).toMatch(/sessions file is in use/);
    expect(a.o.err).toMatch(/nothing was changed/i);
    expect(keys()).toEqual([one]);
    // Its lock is left alone.
    expect(fs.existsSync(path.join(tmp, WEB_SESSIONS_LOCK))).toBe(true);
  });

  it("a lock left by a process that is gone is taken over", async () => {
    store().create({ userAgent: "one" });
    fs.writeFileSync(path.join(tmp, WEB_SESSIONS_LOCK), "2147483646\n");
    const a = io();
    expect(await cmdWebLogout(["--port", String(await freePort())], a.io)).toBe(
      0,
    );
    expect(a.o.out.trim()).toBe("Signed out 1 browser.");
    expect(keys()).toEqual([]);
    // Released when done.
    expect(fs.existsSync(path.join(tmp, WEB_SESSIONS_LOCK))).toBe(false);
  });

  it("each end is in the activity trail with why, never the key", async () => {
    const one = store().create({ userAgent: "one" }).session.key;
    const two = store().create({ userAgent: "two" }).session.key;
    const port = String(await freePort());
    expect(await cmdWebLogout([one.slice(0, 8), "--port", port], io().io)).toBe(
      0,
    );
    expect(await cmdWebLogout(["--port", port], io().io)).toBe(0);
    const text = fs.readFileSync(path.join(tmp, AUDIT_FILE), "utf-8");
    const rows = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { verb: string; detail: string });
    expect(rows.map((r) => [r.verb, r.detail])).toEqual([
      [
        "session-end",
        `${one.slice(0, 8)} (browser) ended: revoked from linked devices`,
      ],
      [
        "session-end",
        `${two.slice(0, 8)} (browser) ended: signed out everywhere`,
      ],
    ]);
    expect(text.includes(one)).toBe(false);
    expect(text.includes(two)).toBe(false);
    expect(
      (fs.statSync(path.join(tmp, AUDIT_FILE)).mode & 0o777).toString(8),
    ).toBe("600");
  });
});
