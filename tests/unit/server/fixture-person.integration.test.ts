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
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import { spawnSync, type ChildProcess } from "child_process";
import * as yaml from "yaml";
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

/**
 * Issue 402: live checks press ☆/★ on the Services page as the fixture
 * person, and the page saves the rail's pins (POST /api/settings, shell).
 * Those are the page's own view prefs, never a program Den runs: refused,
 * every pin check failed on the bed from the day it signed in as the
 * fixture person.
 */
// Issue 1210: `web.fixture_person` gives the fixture person an invented
// name and login on the rail; the audit and the log keep "fixture person".
const NAMED = [
  ...MARKED.slice(0, -1),
  "  fixture_person:",
  "    name: Robin Example",
  "    login: robin-example",
  "",
];
const INVENTED = /Robin Example|robin-example/;
async function withConfig<T>(den: Den, lines: string[], fn: () => Promise<T>) {
  const cfg = path.join(den.root, "config", "den.yml");
  fs.writeFileSync(cfg, lines.join("\n"));
  try {
    return await fn();
  } finally {
    fs.writeFileSync(cfg, MARKED.join("\n"));
  }
}

describe("the fixture person's invented name (issue 1210)", () => {
  it("the rail shows the name over its login", async () => {
    await withConfig(test, NAMED, async () => {
      const f = await fixtureSignIn(test);
      expect(f.me.identity).toEqual({
        kind: "github",
        via: "fixture",
        login: "robin-example",
        name: "Robin Example",
      });
    });
  });

  it("without the setting it is the local identity, as before", async () => {
    const f = await fixtureSignIn(test);
    expect((f.me.identity as { kind?: string })?.kind).toBe("local");
  });

  it("the audit and the log still say fixture person, never the name", async () => {
    await withConfig(test, NAMED, async () => {
      await fixtureSignIn(test);
      const rows = fs
        .readFileSync(path.join(test.stateDir, "audit.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean);
      expect(rows.join("\n")).not.toMatch(INVENTED);
      const last = JSON.parse(
        rows.filter((l) => l.includes("fixture person signed in")).pop()!,
      ) as Record<string, unknown>;
      expect(last.principal).toBe("fixture:person");
      expect(test.out()).not.toMatch(INVENTED);
    });
  });

  it("a person's own session never takes the name", async () => {
    await withConfig(test, NAMED, async () => {
      const p = await signedIn(test.stateDir, test.base);
      try {
        const me = await call(test, "GET", "/api/session", {
          cookie: p.headers.cookie,
          "sec-fetch-site": "same-origin",
        });
        expect((me.json.identity as { kind?: string })?.kind).toBe("local");
        expect(JSON.stringify(me.json)).not.toMatch(INVENTED);
      } finally {
        await signOut(test, p.headers);
      }
    });
  });

  it("an install that isn't a bound test install ignores it", async () => {
    await withConfig(noflag, NAMED, async () => {
      const p = await signedIn(noflag.stateDir, noflag.base);
      try {
        const me = await call(noflag, "GET", "/api/session", {
          cookie: p.headers.cookie,
          "sec-fetch-site": "same-origin",
        });
        expect(JSON.stringify(me.json)).not.toMatch(INVENTED);
      } finally {
        await signOut(noflag, p.headers);
      }
    });
  });
});

// Issue 1215: on a test install the fixture person makes, activates,
// deactivates and deletes its own projects (live checks set one up), audited
// as the fixture person; nothing else in the project family.
const auditRows = (den: Den) =>
  fs
    .readFileSync(path.join(den.stateDir, "audit.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const projectRows = (den: Den, slug: string) =>
  auditRows(den).filter(
    (e) => e.verb === "project" && String(e.detail).includes(slug),
  );

describe("the fixture person's own projects (issue 1215)", () => {
  it("creates, activates, deactivates and deletes one, each audited as the fixture person", async () => {
    const f = await fixtureSignIn(test);
    const c = await call(test, "POST", "/api/workspaces/create", f.headers, {
      name: "fx 1215 long name",
    });
    expect([c.status, c.json.slug]).toEqual([200, "fx-1215-long-name"]);
    const on = await call(test, "POST", "/api/workspaces", f.headers, {
      name: "fx-1215-long-name",
      action: "activate",
    });
    expect(on.status).toBe(200);
    expect(on.json.active).toContain("fx-1215-long-name");
    const off = await call(test, "POST", "/api/workspaces", f.headers, {
      name: "fx-1215-long-name",
      action: "deactivate",
    });
    expect(off.json.active).not.toContain("fx-1215-long-name");
    const del = await call(test, "DELETE", "/api/workspaces", f.headers, {
      name: "fx-1215-long-name",
    });
    expect(del.status).toBe(200);
    const rows = projectRows(test, "fx-1215-long-name");
    expect(rows.map((e) => String(e.detail).split(" ")[0])).toEqual([
      "create",
      "activate",
      "deactivate",
      "delete",
    ]);
    for (const e of rows) expect(e.principal).toBe("fixture:person");
    // Gone, and no longer its own.
    const again = await call(test, "POST", "/api/workspaces", f.headers, {
      name: "fx-1215-long-name",
      action: "activate",
    });
    expect(again.status).toBe(403);
  });

  it("can't touch a project it didn't make", async () => {
    const p = await signedIn(test.stateDir, test.base);
    try {
      const made = await call(
        test,
        "POST",
        "/api/workspaces/create",
        p.headers,
        {
          name: "people-1215",
        },
      );
      expect(made.status).toBe(200);
    } finally {
      await signOut(test, p.headers);
    }
    const f = await fixtureSignIn(test);
    for (const [m, body] of [
      ["POST", { name: "people-1215", action: "deactivate" }],
      ["DELETE", { name: "people-1215" }],
    ] as const) {
      const r = await call(test, m, "/api/workspaces", f.headers, body);
      expect([r.status, r.json.code]).toEqual([403, "fixture_not_its_project"]);
    }
  });

  it("a name it once used, now a person's project, is never its own", async () => {
    const f = await fixtureSignIn(test);
    const c = await call(test, "POST", "/api/workspaces/create", f.headers, {
      name: "fx-1215-reused",
    });
    expect(c.status).toBe(200);
    // Removed without the server (by hand, or the CLI's own write).
    const file = path.join(test.root, "config", "local", "workspaces.yml");
    const doc = yaml.parse(fs.readFileSync(file, "utf-8")) as {
      workspaces: Record<string, unknown>;
      active?: string[];
    };
    delete doc.workspaces["fx-1215-reused"];
    doc.active = (doc.active ?? []).filter((n) => n !== "fx-1215-reused");
    fs.writeFileSync(file, yaml.stringify(doc));
    // A person makes a project with the same name.
    const p = await signedIn(test.stateDir, test.base);
    try {
      const made = await call(
        test,
        "POST",
        "/api/workspaces/create",
        p.headers,
        {
          name: "fx-1215-reused",
        },
      );
      expect(made.status).toBe(200);
    } finally {
      await signOut(test, p.headers);
    }
    const f2 = await fixtureSignIn(test);
    const d = await call(test, "DELETE", "/api/workspaces", f2.headers, {
      name: "fx-1215-reused",
    });
    expect([d.status, d.json.code]).toEqual([403, "fixture_not_its_project"]);
  });

  it("can't rename, focus, or remove clones with its own project", async () => {
    const f = await fixtureSignIn(test);
    await call(test, "POST", "/api/workspaces/create", f.headers, {
      name: "fx-1215-b",
    });
    try {
      for (const body of [
        { name: "fx-1215-b", action: "rename", to: "other" },
        { name: "fx-1215-b", action: "focus" },
      ]) {
        const r = await call(test, "POST", "/api/workspaces", f.headers, body);
        expect([r.status, r.json.code]).toEqual([403, "fixture_scope"]);
      }
      const r = await call(test, "POST", "/api/workspaces/rename", f.headers, {
        name: "fx-1215-b",
        to: "other",
      });
      expect(r.status).toBe(403);
      const d = await call(test, "DELETE", "/api/workspaces", f.headers, {
        name: "fx-1215-b",
        cleanupDev: true,
      });
      expect([d.status, d.json.code]).toEqual([403, "fixture_scope"]);
    } finally {
      await call(test, "DELETE", "/api/workspaces", f.headers, {
        name: "fx-1215-b",
      });
    }
  });

  it("an agent's claim on the fixture session is refused (audited), and nothing is made", async () => {
    const f = await fixtureSignIn(test);
    const r = await call(
      test,
      "POST",
      "/api/workspaces/create",
      { ...f.headers, ...AGENT_CLAIM },
      { name: "fx-1215-claimed" },
    );
    expect([r.status, r.json.code]).toEqual([403, "fixture_scope"]);
    // Audited as refused, and never made.
    const rows = projectRows(test, "fx-1215-claimed");
    expect(rows.map((e) => [e.detail, e.outcome, e.principal])).toEqual([
      ["create fx-1215-claimed", "refused", "fixture:person"],
    ]);
  });
});

describe("what the fixture person saves from a page", () => {
  it("the rail's pins, as the Services page's ☆ saves them", async () => {
    const f = await fixtureSignIn(test);
    const pins = [
      { item: "svc-a", project: null },
      { item: "svc-b", project: null },
    ];
    const r = await call(test, "POST", "/api/settings", f.headers, {
      shell: { pins },
    });
    expect([r.status, r.json.ok]).toEqual([200, true]);
    const back = await call(test, "GET", "/api/settings", {
      cookie: f.cookie,
      "sec-fetch-site": "same-origin",
    });
    const stored = (back.json.shell as { pins?: { item: string }[] }).pins;
    expect((stored ?? []).map((p) => p.item)).toEqual(["svc-a", "svc-b"]);
    const clear = await call(test, "POST", "/api/settings", f.headers, {
      shell: { pins: [] },
    });
    expect(clear.status).toBe(200);
  });
});

/**
 * Issue 946: a pin is more than a view pref (a held write on a pinned
 * item waits for an Allow). The fixture person's saves add pins and remove
 * only the ones it added; the person's own pins always stay.
 */
describe("the fixture person's pins never touch the person's", () => {
  const person = () => ({
    authorization: `Bearer ${personToken(readWebSecret(test.stateDir)!)}`,
  });
  const items = async (cookie: string) => {
    const back = await call(test, "GET", "/api/settings", {
      cookie,
      "sec-fetch-site": "same-origin",
    });
    return (
      (back.json.shell as { pins?: { item: string }[] } | undefined)?.pins ?? []
    ).map((p) => p.item);
  };
  afterEach(async () => {
    await call(test, "POST", "/api/settings", person(), { shell: null });
  });

  it("an empty list from the fixture person leaves the person's pin", async () => {
    const mine = await call(test, "POST", "/api/settings", person(), {
      shell: { pins: [{ item: "svc-person", project: null }] },
    });
    expect(mine.status).toBe(200);
    const f = await fixtureSignIn(test);
    const r = await call(test, "POST", "/api/settings", f.headers, {
      shell: { pins: [] },
    });
    expect(r.status).toBe(200);
    expect(await items(f.cookie)).toEqual(["svc-person"]);
  });

  // Issue 957: Den's record of the fixture's own pins follows the stored
  // pins. A fixture pin dropped from user.yml by hand, then pinned again by
  // the person, is the person's: the fixture can't take it off.
  it("a fixture pin dropped by hand and pinned again by the person is the person's", async () => {
    const f = await fixtureSignIn(test);
    await call(test, "POST", "/api/settings", f.headers, {
      shell: { pins: [{ item: "svc-check", project: null }] },
    });
    expect(await items(f.cookie)).toEqual(["svc-check"]);
    // By hand: the pin is gone from user.yml.
    const file = path.join(test.root, "config", "local", "user.yml");
    const doc = yaml.parse(fs.readFileSync(file, "utf8")) as {
      shell?: { pins?: unknown[] };
    };
    if (doc.shell) doc.shell.pins = [];
    fs.writeFileSync(file, yaml.stringify(doc));
    // Den reads its settings (as any page load does).
    expect(await items(f.cookie)).toEqual([]);
    // The person pins it again.
    await call(test, "POST", "/api/settings", person(), {
      shell: { pins: [{ item: "svc-check", project: null }] },
    });
    // The fixture person's empty list leaves it: it is the person's now.
    await call(test, "POST", "/api/settings", f.headers, {
      shell: { pins: [] },
    });
    expect(await items(f.cookie)).toEqual(["svc-check"]);
  });

  it("it adds a pin and takes off only its own", async () => {
    await call(test, "POST", "/api/settings", person(), {
      shell: { pins: [{ item: "svc-person", project: null }] },
    });
    const f = await fixtureSignIn(test);
    await call(test, "POST", "/api/settings", f.headers, {
      shell: {
        pins: [
          { item: "svc-person", project: null },
          { item: "svc-check", project: null },
        ],
      },
    });
    expect(await items(f.cookie)).toEqual(["svc-person", "svc-check"]);
    await call(test, "POST", "/api/settings", f.headers, {
      shell: { pins: [] },
    });
    expect(await items(f.cookie)).toEqual(["svc-person"]);
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

  it("can't change a person-only setting alongside the rail's own prefs", async () => {
    const f = await fixtureSignIn(test);
    const r = await call(test, "POST", "/api/settings", f.headers, {
      shell: { collapsed: true },
      editor: "vi",
    });
    expect(r.status).toBe(403);
  });

  it("a claimed agent on the fixture session can't change the rail's prefs", async () => {
    const f = await fixtureSignIn(test);
    const r = await call(
      test,
      "POST",
      "/api/settings",
      {
        ...f.headers,
        ...AGENT_CLAIM,
      },
      { shell: { pins: [{ item: "svc-claimed", project: null }] } },
    );
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
