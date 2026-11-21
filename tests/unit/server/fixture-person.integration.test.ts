/**
 * Issue 810 on real servers. A test install is one whose distribution
 * config has web.test_install: true AND whose server was started with the
 * launcher's test-only flag AND that runs on its own state dir (not the
 * product's default) AND has no owner or paired person. Three installs:
 *  - test: all of that.
 *  - noflag: the mark, its own state dir, no launch flag (a real install).
 *  - homedir: the mark and the flag, on the default state dir.
 * Covered: the mark ignored unless bound (a person signed in by a link
 * counts as one); Set up test person (a person's browser session only;
 * never an agent, the person's CLI bearer, or the fixture person); a
 * key file written by hand refused; the fixture sign-in, logged and
 * audited as the fixture person; what a fixture session can't reach
 * (approvals, person-only settings, terminals, Hub, anything off its
 * allow-list); and the session dying with the mark, the binding or the key.
 * No code, cookie or secret is printed: failures show statuses and codes.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import { signedIn } from "./helpers/signed-in.js";
import {
  fixturePersonPath,
  mintFixtureCode,
  readFixtureKey,
  setupFixturePerson,
} from "../../../src/shared/fixture-person.js";
import { personToken, readWebSecret } from "../../../src/shared/web-secret.js";
import { clearWebOwner, writeWebOwner } from "../../../src/shared/web-owner.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const AGENT_KEYS = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_PERSON_TOKEN",
];

interface Den {
  root: string;
  home: string;
  stateDir: string;
  port: number;
  base: string;
  server: ChildProcess;
  out: () => string;
}
let tmp = "";
let test: Den;
let noflag: Den;
let homedir: Den;

interface Reply {
  status: number;
  body: string;
  json: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}
function call(
  den: Den,
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port: den.port,
        path: p,
        method,
        agent: false,
        timeout: 20_000,
        headers: {
          connection: "close",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }),
          ...headers,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d: Buffer) => (buf += d.toString()));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(buf) as Record<string, unknown>;
          } catch {
            /* a page */
          }
          resolve({
            status: res.statusCode ?? 0,
            body: buf,
            json,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(payload);
  });
}

/** A WebSocket upgrade's status and refusal body (the server answers and closes). */
function upgrade(
  den: Den,
  p: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "localhost",
      port: den.port,
      path: p,
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("upgrade", (res, socket) => {
      socket.on("error", () => undefined);
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, body: "" });
    });
    req.on("error", reject);
    req.end();
  });
}

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [...AGENT_KEYS, "DEN_HOME", "DEN_TEST_INSTALL"])
    delete env[k];
  return env;
}

const MARKED = ["environments: [local]", "web:", "  test_install: true", ""];

async function startDen(
  name: string,
  o: { flag: boolean; ownState: boolean },
): Promise<Den> {
  const root = path.join(tmp, name, "dist");
  const home = path.join(tmp, name, "home");
  const stateDir = o.ownState
    ? path.join(tmp, name, "state")
    : path.join(home, ".den");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(path.join(root, "config", "den.yml"), MARKED.join("\n"));
  const env: NodeJS.ProcessEnv = {
    ...baseEnv(),
    DEN_ROOT: root,
    DEN_ENGINE_ROOT: ENGINE,
    HOME: home,
    DEN_NO_OPEN: "1",
    NO_COLOR: "1",
    ...(o.ownState ? { DEN_HOME: stateDir } : {}),
    ...(o.flag ? { DEN_TEST_INSTALL: "1" } : {}),
  };
  const s = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    { cwd: root, env },
    { timeoutMs: 40_000 },
  );
  return {
    root,
    home,
    stateDir,
    port: s.port,
    base: `http://localhost:${s.port}`,
    server: s.server,
    out: s.out,
  };
}

/** `<cli> web fixture-person --port <port>` against `den`, env as given. */
function cliFixturePerson(den: Den) {
  return spawnSync(
    TSX,
    [
      path.join(ENGINE, "src", "ui", "cli", "index.ts"),
      "web",
      "fixture-person",
      "--port",
      String(den.port),
    ],
    {
      cwd: den.root,
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...baseEnv(),
        DEN_ROOT: den.root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: den.stateDir,
        HOME: den.home,
        NO_COLOR: "1",
        CI: "1",
      },
    },
  );
}

const nav = { "sec-fetch-site": "none", accept: "text/html" };
const sessionCookie = (r: Reply) =>
  ([] as string[])
    .concat(r.headers["set-cookie"] ?? [])
    .map((c) => c.split(";")[0])
    .find((c) => /^(__Host-)?den_session_/.test(c)) ?? "";
/** A claimed agent (x-den-actor): never the person, whatever the cookie. */
const AGENT_CLAIM = {
  "x-den-actor": "agent",
  "x-den-actor-client": "claude-code",
};
const keyText = (den: Den) =>
  fs.readFileSync(fixturePersonPath(den.stateDir), "utf-8");
const state = async (den: Den) =>
  (await call(den, "GET", "/api/web/fixture-person")).json;

/** The fixture person's page headers on `den`: signed in by its code. */
async function fixtureSignIn(den: Den) {
  const code = mintFixtureCode(readFixtureKey(den.stateDir)!);
  const r = await call(
    den,
    "GET",
    `/auth?fixture=${encodeURIComponent(code)}&next=%2Fagents`,
    nav,
  );
  const cookie = sessionCookie(r);
  const me = await call(den, "GET", "/api/session", {
    cookie,
    "sec-fetch-site": "same-origin",
  });
  return {
    r,
    cookie,
    me: me.json,
    headers: {
      cookie,
      origin: den.base,
      "x-den-csrf": String(me.json.csrf ?? ""),
    },
  };
}
/** Signs a person's session out, so it no longer counts as one on `den`. */
async function signOut(den: Den, headers: Record<string, string>) {
  const r = await call(den, "POST", "/api/session/logout", headers, {});
  expect(r.status).toBe(200);
}
async function stillSignedIn(den: Den, cookie: string): Promise<boolean> {
  const me = await call(den, "GET", "/api/session", {
    cookie,
    "sec-fetch-site": "same-origin",
  });
  return me.json.signedIn === true;
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-fx810-")));
  [test, noflag, homedir] = await Promise.all([
    startDen("test", { flag: true, ownState: true }),
    startDen("noflag", { flag: false, ownState: true }),
    startDen("homedir", { flag: true, ownState: false }),
  ]);
}, 120_000);
afterAll(async () => {
  await Promise.all(
    [test, noflag, homedir].filter(Boolean).map((d) => stopServer(d.server)),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the mark counts only on a bound test install", () => {
  it("the bound install reads as a test install", async () => {
    expect((await state(test)).testInstall).toBe(true);
  });

  it("ignored without the launcher's flag: Settings reads no, setup and sign-in refused", async () => {
    expect(await state(noflag)).toEqual({
      ok: true,
      testInstall: false,
      ready: false,
    });
    const p = await signedIn(noflag.stateDir, noflag.base);
    const r = await call(
      noflag,
      "POST",
      "/api/web/fixture-person",
      p.headers,
      {},
    );
    expect([r.status, r.json.code]).toEqual([403, "not_test_install"]);
    // Even a key the server would have sealed doesn't sign in here.
    setupFixturePerson(noflag.stateDir, {
      testInstall: true,
      agent: false,
      webSecret: readWebSecret(noflag.stateDir)!,
    });
    const code = mintFixtureCode(readFixtureKey(noflag.stateDir)!);
    const a = await call(
      noflag,
      "GET",
      `/auth?fixture=${encodeURIComponent(code)}`,
      nav,
    );
    expect(a.status).toBe(403);
    expect(sessionCookie(a)).toBe("");
    expect(a.body).toMatch(/isn't a test install/);
    expect(a.body.includes(code)).toBe(false);
  });

  it("ignored on the product's default state dir", async () => {
    expect((await state(homedir)).testInstall).toBe(false);
  });

  it("ignored on an install with an owner", async () => {
    writeWebOwner({ id: 1, login: "someone" }, test.stateDir);
    try {
      expect((await state(test)).testInstall).toBe(false);
    } finally {
      clearWebOwner(test.stateDir);
    }
    expect((await state(test)).testInstall).toBe(true);
  });
});

describe("making the fixture person on the test install", () => {
  it("a key file written by hand is refused: not ready, and it signs nobody in", async () => {
    fs.mkdirSync(test.stateDir, { recursive: true });
    fs.writeFileSync(fixturePersonPath(test.stateDir), `${"A".repeat(43)}\n`, {
      mode: 0o600,
    });
    expect((await state(test)).ready).toBe(false);
    const code = mintFixtureCode(readFixtureKey(test.stateDir)!);
    const r = await call(
      test,
      "GET",
      `/auth?fixture=${encodeURIComponent(code)}`,
      nav,
    );
    expect(r.status).toBe(401);
    expect(sessionCookie(r)).toBe("");
    fs.rmSync(fixturePersonPath(test.stateDir), { force: true });
  });

  it("refused for an agent's call, and nothing is written", async () => {
    const p = await signedIn(test.stateDir, test.base);
    const r = await call(
      test,
      "POST",
      "/api/web/fixture-person",
      { ...p.headers, ...AGENT_CLAIM },
      {},
    );
    await signOut(test, p.headers);
    expect([r.status, r.json.code]).toEqual([403, "person_only"]);
    expect(fs.existsSync(fixturePersonPath(test.stateDir))).toBe(false);
  });

  it("a person signed in by a link counts as a person on the install", async () => {
    const p = await signedIn(test.stateDir, test.base);
    try {
      expect((await state(test)).testInstall).toBe(false);
    } finally {
      await signOut(test, p.headers);
    }
    expect((await state(test)).testInstall).toBe(true);
  });

  it("the signed-in person's own Settings still reads a test install, so the button shows", async () => {
    const p = await signedIn(test.stateDir, test.base);
    try {
      const own = await call(test, "GET", "/api/web/fixture-person", p.headers);
      expect(own.json.testInstall).toBe(true);
      // Anyone else still sees the person's session as a person here.
      expect((await state(test)).testInstall).toBe(false);
    } finally {
      await signOut(test, p.headers);
    }
  });

  it("a signed-in person sets it up: 0600, never in the answer; Settings reads ready", async () => {
    const p = await signedIn(test.stateDir, test.base);
    const r = await call(
      test,
      "POST",
      "/api/web/fixture-person",
      p.headers,
      {},
    );
    expect([r.status, r.json.ok]).toEqual([200, true]);
    expect(fs.statSync(fixturePersonPath(test.stateDir)).mode & 0o777).toBe(
      0o600,
    );
    expect(r.body.includes(keyText(test).trim())).toBe(false);
    expect(await state(test)).toEqual({
      ok: true,
      testInstall: true,
      ready: true,
    });
  });

  it("the person's CLI bearer is refused: setup is the Settings button only", async () => {
    const before = keyText(test);
    const r = await call(
      test,
      "POST",
      "/api/web/fixture-person",
      {
        authorization: `Bearer ${personToken(readWebSecret(test.stateDir)!)}`,
      },
      {},
    );
    expect([r.status, r.json.code]).toEqual([403, "person_only"]);
    expect(keyText(test)).toBe(before);
    const c = cliFixturePerson(test);
    expect(c.status).toBe(1);
    expect(c.stderr).toMatch(/Set up test person/);
    expect(keyText(test)).toBe(before);
  });
});

describe("the fixture sign-in", () => {
  it("is granted, and logged and audited as the fixture person", async () => {
    const f = await fixtureSignIn(test);
    expect(f.r.status).toBe(303);
    expect(String(f.r.headers.location)).toBe("/agents");
    expect(f.me.signedIn).toBe(true);
    expect(test.out()).toMatch(/fixture person signed in/);
    const line = fs
      .readFileSync(path.join(test.stateDir, "audit.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => String(e.detail).includes("fixture person signed in"));
    expect(line?.principal).toBe("fixture:person");
  });

  it("a HEAD never spends the one-time code", async () => {
    const code = mintFixtureCode(readFixtureKey(test.stateDir)!);
    const q = `/auth?fixture=${encodeURIComponent(code)}`;
    const head = await call(test, "HEAD", q, nav);
    expect(head.status).not.toBe(303);
    expect(sessionCookie(head)).toBe("");
    expect((await call(test, "GET", q, nav)).status).toBe(303);
  });

  it("is one-time", async () => {
    const code = mintFixtureCode(readFixtureKey(test.stateDir)!);
    const q = `/auth?fixture=${encodeURIComponent(code)}`;
    expect((await call(test, "GET", q, nav)).status).toBe(303);
    const again = await call(test, "GET", q, nav);
    expect(again.status).not.toBe(303);
    expect(sessionCookie(again)).toBe("");
  });
});

describe("what the fixture person can't reach", () => {
  it("can't Allow a held write", async () => {
    const f = await fixtureSignIn(test);
    const r = await call(test, "POST", "/api/approvals/a1/decide", f.headers, {
      decision: "allow",
    });
    expect(r.status).toBe(403);
    expect(String(r.json.code)).toMatch(/^fixture/);
  });

  it("can't set up (or replace) the fixture person", async () => {
    const before = keyText(test);
    const f = await fixtureSignIn(test);
    const r = await call(
      test,
      "POST",
      "/api/web/fixture-person",
      f.headers,
      {},
    );
    expect(r.status).toBe(403);
    expect(keyText(test)).toBe(before);
  });

  it("can't reach Hub", async () => {
    const f = await fixtureSignIn(test);
    for (const p of ["/api/hub/connect", "/api/hub/disconnect"]) {
      const r = await call(test, "POST", p, f.headers, {});
      expect([p, r.status, r.json.code]).toEqual([p, 403, "fixture_scope"]);
    }
  });

  it("can't change a person-only setting", async () => {
    const f = await fixtureSignIn(test);
    const r = await call(test, "POST", "/api/settings", f.headers, {
      agents_default_mode: "auto",
    });
    expect(r.status).toBe(403);
  });

  it("can't open a terminal's WebSocket", async () => {
    const f = await fixtureSignIn(test);
    const r = await upgrade(test, "/api/sessions/s1/io", {
      cookie: f.cookie,
      origin: test.base,
      "sec-websocket-protocol": `den.csrf.${String(f.me.csrf ?? "")}`,
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/fixture_scope/);
  });

  it("can't reach a route off its allow-list", async () => {
    const f = await fixtureSignIn(test);
    const w = await call(test, "POST", "/api/local-dev", f.headers, {});
    expect([w.status, w.json.code]).toEqual([403, "fixture_scope"]);
    const g = await call(test, "GET", "/api/run", {
      cookie: f.cookie,
      "sec-fetch-site": "same-origin",
    });
    expect([g.status, g.json.code]).toEqual([403, "fixture_scope"]);
  });
});

describe("the test-install mark is never written through Settings", () => {
  it.each([
    ["the person", false],
    ["the fixture person", true],
  ])(
    "POST /api/settings with test_install is refused for %s",
    async (_n, fx) => {
      const headers = fx
        ? (await fixtureSignIn(test)).headers
        : (await signedIn(test.stateDir, test.base)).headers;
      const r = await call(test, "POST", "/api/settings", headers, {
        test_install: false,
      });
      if (!fx) await signOut(test, headers);
      expect(r.status).toBe(403);
      expect(r.json.code).toBe("test_install_by_hand");
      expect(
        fs.readFileSync(path.join(test.root, "config", "den.yml"), "utf-8"),
      ).toMatch(/test_install: true/);
    },
  );
});

describe("a fixture session dies with what allowed it", () => {
  it("when the install gets an owner", async () => {
    const f = await fixtureSignIn(test);
    expect(await stillSignedIn(test, f.cookie)).toBe(true);
    writeWebOwner({ id: 1, login: "someone" }, test.stateDir);
    try {
      expect(await stillSignedIn(test, f.cookie)).toBe(false);
    } finally {
      clearWebOwner(test.stateDir);
    }
    expect(await stillSignedIn(test, f.cookie)).toBe(false);
  });

  it("when the mark is removed", async () => {
    const f = await fixtureSignIn(test);
    expect(await stillSignedIn(test, f.cookie)).toBe(true);
    const cfg = path.join(test.root, "config", "den.yml");
    fs.writeFileSync(cfg, "environments: [local]\n");
    try {
      expect(await stillSignedIn(test, f.cookie)).toBe(false);
    } finally {
      fs.writeFileSync(cfg, MARKED.join("\n"));
    }
  });

  it("when the test person is set up again", async () => {
    const f = await fixtureSignIn(test);
    expect(await stillSignedIn(test, f.cookie)).toBe(true);
    const p = await signedIn(test.stateDir, test.base);
    const r = await call(
      test,
      "POST",
      "/api/web/fixture-person",
      p.headers,
      {},
    );
    expect([r.status, r.json.ok]).toEqual([200, true]);
    expect(await stillSignedIn(test, f.cookie)).toBe(false);
    // A new sign-in, with the new key, stands.
    const g = await fixtureSignIn(test);
    expect(await stillSignedIn(test, g.cookie)).toBe(true);
  });

  it("when the key is removed", async () => {
    const f = await fixtureSignIn(test);
    expect(await stillSignedIn(test, f.cookie)).toBe(true);
    fs.rmSync(fixturePersonPath(test.stateDir));
    expect(await stillSignedIn(test, f.cookie)).toBe(false);
  });
});
