/**
 * Issue 810 on real servers: two throwaway installs, one marked a test
 * install (web.test_install: true in its distribution config), one not.
 *  - A real install refuses the fixture sign-in and the fixture setup.
 *  - A test install: a signed-in person presses Set up test person (the
 *    route); an agent's call is refused. The fixture sign-in then gives a
 *    session, logged and audited as the fixture person, never the human.
 *  - The fixture session can't Allow a held write, can't make or change
 *    the fixture person or the test-install mark, and can't reach Hub.
 *  - The test-install mark is never written through Settings.
 * No code, cookie or secret is printed: failures show statuses and codes.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import { signedIn } from "./helpers/signed-in.js";
import {
  fixturePersonPath,
  mintFixtureCode,
  readFixtureSecret,
} from "../../../src/shared/fixture-person.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");

interface Den {
  root: string;
  stateDir: string;
  port: number;
  base: string;
  server: ChildProcess;
  out: () => string;
}
let tmp = "";
let real: Den;
let test: Den;

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

async function startDen(name: string, testInstall: boolean): Promise<Den> {
  const root = path.join(tmp, name, "dist");
  const home = path.join(tmp, name, "home");
  const stateDir = path.join(home, ".den");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      ...(testInstall ? ["web:", "  test_install: true"] : []),
      "",
    ].join("\n"),
  );
  const env = {
    ...process.env,
    DEN_ROOT: root,
    DEN_ENGINE_ROOT: ENGINE,
    DEN_HOME: stateDir,
    HOME: home,
    DEN_NO_OPEN: "1",
    NO_COLOR: "1",
  };
  const s = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    { cwd: root, env },
    { timeoutMs: 40_000 },
  );
  return {
    root,
    stateDir,
    port: s.port,
    base: `http://localhost:${s.port}`,
    server: s.server,
    out: s.out,
  };
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

/** The fixture person's page headers on `den`: signed in by its code. */
async function fixtureSignIn(den: Den) {
  const code = mintFixtureCode(readFixtureSecret(den.stateDir)!);
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

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-fx810-")));
  [real, test] = await Promise.all([
    startDen("real", false),
    startDen("test", true),
  ]);
}, 90_000);
afterAll(async () => {
  await Promise.all([
    real && stopServer(real.server),
    test && stopServer(test.server),
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a real install (no test mark)", () => {
  it("Settings reads: not a test install, no test person", async () => {
    const p = await signedIn(real.stateDir, real.base);
    const r = await call(real, "GET", "/api/web/fixture-person", p.headers);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, testInstall: false, ready: false });
  });

  it("refuses Set up test person, even for the signed-in person, and writes nothing", async () => {
    const p = await signedIn(real.stateDir, real.base);
    const r = await call(
      real,
      "POST",
      "/api/web/fixture-person",
      p.headers,
      {},
    );
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("not_test_install");
    expect(fs.existsSync(fixturePersonPath(real.stateDir))).toBe(false);
  });

  it("refuses the fixture sign-in, even with a fixture secret placed by hand", async () => {
    fs.mkdirSync(real.stateDir, { recursive: true });
    fs.writeFileSync(fixturePersonPath(real.stateDir), "A".repeat(43) + "\n", {
      mode: 0o600,
    });
    try {
      const code = mintFixtureCode(readFixtureSecret(real.stateDir)!);
      const r = await call(
        real,
        "GET",
        `/auth?fixture=${encodeURIComponent(code)}`,
        nav,
      );
      expect(r.status).toBe(403);
      expect(sessionCookie(r)).toBe("");
      expect(r.body).toMatch(/isn't marked a test install/);
      expect(r.body.includes(code)).toBe(false);
    } finally {
      fs.rmSync(fixturePersonPath(real.stateDir), { force: true });
    }
  });
});

describe("a test install", () => {
  it("Set up test person is refused for an agent's call, and nothing is written", async () => {
    const p = await signedIn(test.stateDir, test.base);
    const r = await call(
      test,
      "POST",
      "/api/web/fixture-person",
      { ...p.headers, ...AGENT_CLAIM },
      {},
    );
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("person_only");
    expect(fs.existsSync(fixturePersonPath(test.stateDir))).toBe(false);
  });

  it("a signed-in person sets it up: 0600, never in the answer; Settings then reads ready", async () => {
    const p = await signedIn(test.stateDir, test.base);
    const r = await call(
      test,
      "POST",
      "/api/web/fixture-person",
      p.headers,
      {},
    );
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const f = fixturePersonPath(test.stateDir);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(r.body.includes(fs.readFileSync(f, "utf-8").trim())).toBe(false);
    const s = await call(test, "GET", "/api/web/fixture-person", p.headers);
    expect(s.json).toEqual({ ok: true, testInstall: true, ready: true });
  });

  it("grants the fixture sign-in, and logs and audits it as the fixture person", async () => {
    const f = await fixtureSignIn(test);
    expect(f.r.status).toBe(303);
    expect(String(f.r.headers.location)).toBe("/agents");
    expect(f.cookie).not.toBe("");
    expect(f.me.signedIn).toBe(true);
    expect(test.out()).toMatch(/fixture person signed in/);
    const audit = fs.readFileSync(
      path.join(test.stateDir, "audit.jsonl"),
      "utf-8",
    );
    const line = audit
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => String(e.detail).includes("fixture person signed in"));
    expect(line?.principal).toBe("fixture:person");
    expect(String(line?.principal)).not.toMatch(/^person:/);
  });

  it("the fixture code is one-time", async () => {
    const code = mintFixtureCode(readFixtureSecret(test.stateDir)!);
    const q = `/auth?fixture=${encodeURIComponent(code)}`;
    expect((await call(test, "GET", q, nav)).status).toBe(303);
    const again = await call(test, "GET", q, nav);
    expect(again.status).not.toBe(303);
    expect(sessionCookie(again)).toBe("");
  });

  it("the fixture person can't Allow a held write", async () => {
    const f = await fixtureSignIn(test);
    const r = await call(test, "POST", "/api/approvals/a1/decide", f.headers, {
      decision: "allow",
    });
    expect(r.status).toBe(403);
    expect(String(r.json.code)).toMatch(/^fixture/);
  });

  it("the fixture person can't set up (or replace) the fixture person", async () => {
    const before = fs.readFileSync(fixturePersonPath(test.stateDir), "utf-8");
    const f = await fixtureSignIn(test);
    const r = await call(
      test,
      "POST",
      "/api/web/fixture-person",
      f.headers,
      {},
    );
    expect(r.status).toBe(403);
    expect(fs.readFileSync(fixturePersonPath(test.stateDir), "utf-8")).toBe(
      before,
    );
  });

  it("the fixture person can't reach Hub", async () => {
    const f = await fixtureSignIn(test);
    for (const p of ["/api/hub/connect", "/api/hub/disconnect"]) {
      const r = await call(test, "POST", p, f.headers, {});
      expect([p, r.status, r.json.code]).toEqual([p, 403, "fixture_scope"]);
    }
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
      expect(r.status).toBe(403);
      expect(r.json.code).toBe("test_install_by_hand");
      const cfg = fs.readFileSync(
        path.join(test.root, "config", "den.yml"),
        "utf-8",
      );
      expect(cfg).toMatch(/test_install: true/);
    },
  );
});
