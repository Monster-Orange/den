import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
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
} from "../../../src/shared/web/web-session.js";
import { ensureWebSecret } from "../../../src/shared/web/web-secret.js";
import {
  AUDIT_FILE,
  appendAuditRowWhenNoServer,
} from "../../../src/shared/audit-file.js";
import {
  DEN_PROCS_DIR,
  registerDenProcess,
} from "../../../src/shared/den-procs.js";

const ALWAYS_RUNNING_PID = 1;

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
      lockWaitMs: 100,
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
    fs.writeFileSync(
      path.join(tmp, WEB_SESSIONS_LOCK),
      `${ALWAYS_RUNNING_PID}\n`,
    );
    const a = io();
    expect(await cmdWebLogout(["--port", String(await freePort())], a.io)).toBe(
      1,
    );
    expect(a.o.err).toMatch(/sign-ins file is in use/);
    expect(a.o.err).toMatch(/nothing was changed/i);
    expect(keys()).toEqual([one]);
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

describe("refused on the port, but is a Den server running? (its own record)", () => {
  it("a live server bound to another address: logout changes nothing and says why", async () => {
    const one = store().create({ userAgent: "one" }).session.key;
    registerDenProcess(tmp, "server", ALWAYS_RUNNING_PID);
    const a = io();
    expect(await cmdWebLogout(["--port", String(await freePort())], a.io)).toBe(
      1,
    );
    expect(a.o.err).toMatch(/Den web is running here \(pid 1\)/);
    expect(a.o.err).toMatch(/nothing was changed/i);
    expect(keys()).toEqual([one]);
  });

  it("--all with a live server elsewhere: no session ended, no secret rotated", async () => {
    const one = store().create({ userAgent: "one" }).session.key;
    registerDenProcess(tmp, "server", 1);
    const secret = fs.readFileSync(path.join(tmp, "web.secret"), "utf-8");
    const a = io();
    expect(
      await cmdWebLogout(["--all", "--port", String(await freePort())], a.io),
    ).toBe(1);
    expect(keys()).toEqual([one]);
    expect(fs.readFileSync(path.join(tmp, "web.secret"), "utf-8")).toBe(secret);
  });

  it("records that can't be read: can't tell, so it changes nothing", async () => {
    const one = store().create({ userAgent: "one" }).session.key;
    fs.mkdirSync(path.join(tmp, DEN_PROCS_DIR), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, DEN_PROCS_DIR, "server-77.json"),
      "{not json",
    );
    const a = io();
    expect(await cmdWebLogout(["--port", String(await freePort())], a.io)).toBe(
      1,
    );
    expect(a.o.err).toMatch(/nothing was changed/i);
    expect(keys()).toEqual([one]);
  });

  it("a server record whose pid is gone, or another role's: it writes", async () => {
    store().create({ userAgent: "one" });
    registerDenProcess(tmp, "server", 2147483646);
    registerDenProcess(tmp, "runner", 1);
    const a = io();
    expect(await cmdWebLogout(["--port", String(await freePort())], a.io)).toBe(
      0,
    );
    expect(keys()).toEqual([]);
  });
});

describe("a server write holding the lock (web.sessions_lock_wait_ms)", () => {
  const kids: ChildProcess[] = [];
  afterEach(() => {
    for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
  });

  /** Another process takes the lock as the server's write does, for `ms`. */
  async function holder(ms: number): Promise<void> {
    const lock = path.join(tmp, WEB_SESSIONS_LOCK);
    const k = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");fs.writeFileSync(${JSON.stringify(lock)},process.pid+"\\n",{flag:"wx"});` +
          `setTimeout(()=>{fs.unlinkSync(${JSON.stringify(lock)});setInterval(()=>{},1000)},${ms});`,
      ],
      { stdio: "ignore" },
    );
    kids.push(k);
    const t0 = Date.now();
    while (!fs.existsSync(lock)) {
      if (Date.now() - t0 > 5_000)
        throw new Error("the holder never took the lock");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("logout waits for it, then ends what it was asked to", async () => {
    const one = store().create({ userAgent: "one" }).session.key;
    const two = store().create({ userAgent: "two" }).session.key;
    await holder(400);
    const a = { ...io(), wait: 3_000 };
    const t0 = Date.now();
    expect(
      await cmdWebLogout(
        [one.slice(0, 8), "--port", String(await freePort())],
        {
          ...a.io,
          lockWaitMs: a.wait,
        },
      ),
    ).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(keys()).toEqual([two]);
  });

  it("held past the wait: says so and changes nothing", async () => {
    const one = store().create({ userAgent: "one" }).session.key;
    await holder(5_000);
    const a = io();
    expect(
      await cmdWebLogout(["--port", String(await freePort())], {
        ...a.io,
        lockWaitMs: 200,
      }),
    ).toBe(1);
    expect(a.o.err).toMatch(/sign-ins file is in use/);
    expect(keys()).toEqual([one]);
  });

  it("the offline fallback never writes the sign-ins file or an end row while the lock is held", async () => {
    const one = store().create({ userAgent: "one" }).session.key;
    const before = fs.readFileSync(webSessionsPath(tmp));
    await holder(5_000);
    const port = String(await freePort());
    for (const args of [[one.slice(0, 8)], ["--all"], []]) {
      const a = io();
      expect(
        await cmdWebLogout([...args, "--port", port], {
          ...a.io,
          lockWaitMs: 200,
        }),
      ).toBe(1);
      expect(a.o.err).toMatch(/sign-ins file is in use/);
    }
    expect(fs.readFileSync(webSessionsPath(tmp)).equals(before)).toBe(true);
    expect(keys()).toEqual([one]);
    const trail = path.join(tmp, AUDIT_FILE);
    const text = fs.existsSync(trail) ? fs.readFileSync(trail, "utf-8") : "";
    expect(text.includes('"session-end"')).toBe(false);
  });
});

describe("appendAuditRowWhenNoServer runs only when no Den server is running, so it skips the server's audit lock; its row is redacted (issue 1391)", () => {
  it("is redacted as the server's rows are", () => {
    const token = "abcDEF123456.xyz-_~+/=";
    appendAuditRowWhenNoServer(tmp, {
      verb: "session.end",
      detail: `why: Authorization: Bearer ${token}`,
      principal: `Bearer ${token}`,
    });
    const text = fs.readFileSync(path.join(tmp, AUDIT_FILE), "utf8");
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED]");
  });
});
