/**
 * Issue 814 (option B) on real servers: the test operator. Three installs,
 * each marked web.test_install: true in its distribution config:
 *  - fresh: a new, empty state folder and the launcher's flag. Created as a
 *    test install: the creation record and the fixture person exist at
 *    once, with no person's click, and a fixture session there may make
 *    the test operator's few person-only requests, audited as such.
 *  - later: the flag, its own state folder, but the folder already held an
 *    install (marked later by a config edit). A test install for the
 *    fixture person (issue 810), never for the test operator.
 *  - normal: no launch flag (a normal install). The role is refused, even
 *    with a creation record and key sealed with its own secret.
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
import {
  ensureWebSecret,
  readWebSecret,
} from "../../../src/shared/web-secret.js";
import {
  creationRecordPath,
  verifiedCreationRecord,
  writeCreationRecord,
} from "../../../src/shared/test-operator.js";

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
let fresh: Den;
let later: Den;
let normal: Den;
let webup: Den;
let copied: Den;
/** The sealed record copied into `copied`, as it was. */
let copiedRecord = "";

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
  o: {
    flag: boolean;
    ownState: boolean;
    existing?: boolean;
    /** Issue 1407: what `web up` writes before the server starts. */
    webUpLog?: boolean;
    /** Issue 1407: another install's sealed record, copied in. */
    copyRecordFrom?: string;
  },
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
  // An install that already ran (its state folder holds its secret), and
  // was marked a test install later.
  if (o.existing) ensureWebSecret(stateDir);
  if (o.webUpLog) {
    fs.mkdirSync(path.join(stateDir, "logs", "den"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "logs", "den", "web.log"),
      "\n--- den web start ---\n",
    );
    // `web up` writes web.json (the server's pid) as soon as it starts the
    // server, before the server's first look (a probe of the real `web up`).
    fs.writeFileSync(
      path.join(stateDir, "web.json"),
      `${JSON.stringify({ pid: 4242, port: 4317, root, logPath: "web.log" }, null, 2)}\n`,
    );
  }
  if (o.copyRecordFrom)
    fs.copyFileSync(
      creationRecordPath(o.copyRecordFrom),
      creationRecordPath(stateDir),
    );
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

const nav = { "sec-fetch-site": "none", accept: "text/html" };
const sessionCookie = (r: Reply) =>
  ([] as string[])
    .concat(r.headers["set-cookie"] ?? [])
    .map((c) => c.split(";")[0])
    .find((c) => /^(__Host-)?den_session_/.test(c)) ?? "";
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
async function signOut(den: Den, headers: Record<string, string>) {
  const r = await call(den, "POST", "/api/session/logout", headers, {});
  expect(r.status).toBe(200);
}

/** The test operator's acts, each as a request a live check makes. */
const ACTS: [string, string, unknown][] = [
  ["POST", "/api/workspaces/notes/sessions", {}],
  ["POST", "/api/workspaces/notes/agents/a1/say", { text: "hi" }],
  ["POST", "/api/workspaces/notes/agents/a1/relaunch", {}],
];

function auditRows(den: Den): Record<string, unknown>[] {
  try {
    return fs
      .readFileSync(path.join(den.stateDir, "audit.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** A fixture session's request: its cookie, Origin and CSRF. */
async function asFixture(den: Den, m: string, p: string, body?: unknown) {
  const f = await fixtureSignIn(den);
  return call(
    den,
    m,
    p,
    m === "GET"
      ? { cookie: f.cookie, "sec-fetch-site": "same-origin" }
      : f.headers,
    body,
  );
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-op814-")));
  // Another install's sealed record (its own folder and secret), to copy
  // into a real install's folder.
  const other = path.join(tmp, "other-state");
  writeCreationRecord(other, ensureWebSecret(other));
  copiedRecord = fs.readFileSync(creationRecordPath(other), "utf-8");
  [fresh, later, normal, webup, copied] = await Promise.all([
    startDen("fresh", { flag: true, ownState: true }),
    startDen("later", { flag: true, ownState: true, existing: true }),
    startDen("normal", { flag: false, ownState: true }),
    startDen("webup", { flag: true, ownState: true, webUpLog: true }),
    startDen("copied", {
      flag: true,
      ownState: true,
      existing: true,
      copyRecordFrom: other,
    }),
  ]);
  // The later install: a person sets the fixture person up (issue 810).
  const p = await signedIn(later.stateDir, later.base);
  const r = await call(later, "POST", "/api/web/fixture-person", p.headers, {});
  expect([r.status, r.json.ok]).toEqual([200, true]);
  await signOut(later, p.headers);
}, 120_000);
afterAll(async () => {
  await Promise.all(
    [fresh, later, normal, webup, copied]
      .filter(Boolean)
      .map((d) => stopServer(d.server)),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a new test install is made with its fixture person", () => {
  it("the creation record and the fixture key exist at once, 0600, with no person's click", () => {
    for (const f of [
      creationRecordPath(fresh.stateDir),
      fixturePersonPath(fresh.stateDir),
    ])
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(auditRows(fresh).some((e) => e.verb === "fixture-person")).toBe(
      false,
    );
    expect(
      auditRows(fresh).find((e) => e.verb === "test-install")?.principal,
    ).toBe("test:operator");
  });

  it("the fixture person signs in at once", async () => {
    const f = await fixtureSignIn(fresh);
    expect([f.r.status, f.me.signedIn]).toEqual([303, true]);
  });

  it("`web fixture-login` gives a link on it", () => {
    const c = spawnSync(
      TSX,
      [
        path.join(ENGINE, "src", "ui", "cli", "index.ts"),
        "web",
        "fixture-login",
        "--origin",
        fresh.base,
      ],
      {
        cwd: fresh.root,
        encoding: "utf-8",
        timeout: 60_000,
        env: {
          ...baseEnv(),
          DEN_ROOT: fresh.root,
          DEN_ENGINE_ROOT: ENGINE,
          DEN_HOME: fresh.stateDir,
          HOME: fresh.home,
          NO_COLOR: "1",
          CI: "1",
        },
      },
    );
    expect(c.status).toBe(0);
    expect(c.stdout).toMatch(/\/auth\?fixture=/);
  });

  it("an install whose folder already held an install gets no record and no key by itself", () => {
    expect(fs.existsSync(creationRecordPath(later.stateDir))).toBe(false);
    expect(fs.existsSync(creationRecordPath(normal.stateDir))).toBe(false);
    expect(fs.existsSync(fixturePersonPath(normal.stateDir))).toBe(false);
  });
});

/**
 * Issue 1407 (Vision's ruling): the birth is the flagged start that makes
 * the install's secret, whatever `web up` wrote first; a real install's
 * folder never becomes one, even with another install's record in it.
 */
describe("issue 1407: a test install started by `web up`", () => {
  it("its log there first: still created as a test install, record sealed, fixture person made", () => {
    expect(
      verifiedCreationRecord(webup.stateDir, readWebSecret(webup.stateDir)),
    ).toBe(true);
    expect(fs.existsSync(fixturePersonPath(webup.stateDir))).toBe(true);
  });

  it.each(ACTS)(
    "%s %s passes the gate there, audited as the test operator",
    async (m, p, body) => {
      const r = await asFixture(webup, m, p, body);
      expect([m, p, r.json.code]).not.toEqual([m, p, "fixture_scope"]);
      const row = auditRows(webup)
        .reverse()
        .find(
          (e) => e.verb === "test-operator" && String(e.detail).includes(p),
        );
      expect(row?.principal).toBe("test:operator");
    },
  );

  it("a real install with another install's sealed record copied in: not one, the record unchanged and unverified, no fixture person", () => {
    expect(fs.readFileSync(creationRecordPath(copied.stateDir), "utf-8")).toBe(
      copiedRecord,
    );
    expect(
      verifiedCreationRecord(copied.stateDir, readWebSecret(copied.stateDir)),
    ).toBe(false);
    expect(fs.existsSync(fixturePersonPath(copied.stateDir))).toBe(false);
  });
});

describe("the test operator, on a new test install", () => {
  it.each(ACTS)(
    "%s %s passes the gate, audited as the test operator",
    async (m, p, body) => {
      const r = await asFixture(fresh, m, p, body);
      expect([m, p, r.json.code]).not.toEqual([m, p, "fixture_scope"]);
      expect(
        r.status === 403 && /only a person/.test(String(r.json.error)),
      ).toBe(false);
      const row = auditRows(fresh)
        .reverse()
        .find(
          (e) => e.verb === "test-operator" && String(e.detail).includes(p),
        );
      expect(row?.principal).toBe("test:operator");
    },
  );

  it("attaching or closing a shell it didn't start is refused", async () => {
    const f = await fixtureSignIn(fresh);
    const r = await upgrade(fresh, "/api/sessions/s1/io", {
      cookie: f.cookie,
      origin: fresh.base,
      "sec-websocket-protocol": `den.csrf.${String(f.me.csrf ?? "")}`,
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/fixture_scope/);
    const c = await asFixture(fresh, "POST", "/api/sessions/s1/close", {});
    expect([c.status, c.json.code]).toEqual([403, "fixture_scope"]);
  });

  it.each([
    ["POST", "/api/approvals/a1/decide", { decision: "allow" }],
    ["POST", "/api/web/fixture-person", {}],
    ["GET", "/api/web/waiting", undefined],
    ["POST", "/api/hub/connect", {}],
    ["POST", "/api/hub/link-suggestions", {}],
    ["POST", "/api/workspaces/notes/agents/a1/restart", {}],
    ["POST", "/api/agents/runtimes/claude/path", { path: "/nope" }],
    ["GET", "/api/workspaces/notes/hub-project", undefined],
    ["GET", "/api/hub/link-suggestions", undefined],
  ])("%s %s stays refused", async (m, p, body) => {
    const r = await asFixture(fresh, m, p, body);
    expect(r.status).toBe(403);
  });

  it("a person-only setting stays refused", async () => {
    const r = await asFixture(fresh, "POST", "/api/settings", {
      agents_default_mode: "auto",
    });
    expect(r.status).toBe(403);
  });
});

describe("the test operator is refused everywhere else", () => {
  it.each(ACTS)(
    "marked later by a config edit: %s %s refused",
    async (m, p, body) => {
      const r = await asFixture(later, m, p, body);
      expect([r.status, r.json.code]).toEqual([403, "fixture_scope"]);
    },
  );

  it("marked later: the terminal's WebSocket is refused", async () => {
    const f = await fixtureSignIn(later);
    const r = await upgrade(later, "/api/sessions/s1/io", {
      cookie: f.cookie,
      origin: later.base,
      "sec-websocket-protocol": `den.csrf.${String(f.me.csrf ?? "")}`,
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/fixture_scope/);
  });

  it("a normal install refuses the role, even with a record and key sealed with its own secret", async () => {
    const secret = readWebSecret(normal.stateDir)!;
    writeCreationRecord(normal.stateDir, secret);
    setupFixturePerson(normal.stateDir, {
      testInstall: true,
      agent: false,
      webSecret: secret,
    });
    const code = mintFixtureCode(readFixtureKey(normal.stateDir)!);
    const a = await call(
      normal,
      "GET",
      `/auth?fixture=${encodeURIComponent(code)}`,
      nav,
    );
    expect(a.status).toBe(403);
    expect(sessionCookie(a)).toBe("");
    expect(auditRows(normal).some((e) => e.principal === "test:operator")).toBe(
      false,
    );
  });
});
