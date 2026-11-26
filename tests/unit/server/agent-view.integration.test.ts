/**
 * Issue 796 on a real server: an agent's read-only view of its own Den.
 *  1. an agent's own token gets a one-time view link (no sign-in code, no
 *     person's cookie); a person's credential, a browser and a claimed
 *     agent don't;
 *  2. the view reads pages and read-only routes; Allow or Deny, settings,
 *     an agent's start or stop, and a terminal are refused by route class;
 *  3. each page view and each refusal is logged and audited as the agent;
 *  4. `web.agent_view: false` turns it off, and the refusal says so;
 *  5. the link is one-time and loopback only, the view ends with the
 *     agent's token, and it reaches no Hub route; it never counts as a
 *     person (first run, a test install's owner, the devices list).
 * No code, cookie or token is printed: failures show statuses and codes.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import {
  bindActorSession,
  mintActorToken,
  revokeAgentTokens,
} from "../../../src/shared/actor-token.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { personToken, readWebSecret } from "../../../src/shared/web-secret.js";
import { FIRST_RUN_FILE } from "../../../src/ui/server/first-run.js";
import { ROUTES } from "../../../src/ui/server/route-classes.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const AGENT_KEYS = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_PERSON_TOKEN",
];
const BASE_CONFIG = [
  "environments: [local]",
  "agents:",
  "  token_binding: false",
  "",
];

let tmp = "";
let root = "";
let stateDir = "";
let port = 0;
let base = "";
let server: ChildProcess;
let out: () => string = () => "";

interface Reply {
  status: number;
  body: string;
  json: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}
function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: unknown,
  host = "localhost",
): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port,
        path: p,
        method,
        agent: false,
        timeout: 20_000,
        headers: {
          host: `${host}:${port}`,
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

/**
 * A GET's status within a few seconds; a route that streams (it answers
 * and stays open) reads as 200, one that never answers as 0.
 */
function quick(p: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "localhost",
        port,
        path: p,
        method: "GET",
        agent: false,
        headers: { host: `localhost:${port}`, connection: "close", ...headers },
      },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.destroy();
      },
    );
    req.setTimeout(5_000, () => {
      req.destroy();
      resolve(0);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

function upgrade(
  p: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "localhost",
      port,
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

const nav = { "sec-fetch-site": "none", accept: "text/html" };
const sessionCookie = (r: Reply) =>
  ([] as string[])
    .concat(r.headers["set-cookie"] ?? [])
    .map((c) => c.split(";")[0])
    .find((c) => /^(__Host-)?den_session_/.test(c)) ?? "";
const audit = (): Record<string, unknown>[] => {
  try {
    return fs
      .readFileSync(path.join(stateDir, "audit.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
};

let agentToken = "";
/** The agent's token, bound to a session that runs (as Den's start does). */
function agentTokenNow(): string {
  const dir = sessionPaths(stateDir).dir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "s-builder.json"), JSON.stringify({}));
  const t = mintActorToken(stateDir, {
    agentId: "builder",
    workspace: "north",
    sessionName: "builder",
  });
  bindActorSession(stateDir, t.key, "s-builder");
  return t.token;
}
const asAgent = () => ({ authorization: `Bearer ${agentToken}` });

/** An agent's view link, asked for with its token. */
async function viewLink(next = "/agents"): Promise<Reply> {
  return call("POST", "/api/agents/self/view", asAgent(), { next });
}
/** An agent's view: the link opened, its cookie, and its page headers. */
async function openView(next = "/agents") {
  const link = await viewLink(next);
  expect([link.status, link.json.ok]).toEqual([200, true]);
  const u = new URL(String(link.json.url));
  const r = await call("GET", `${u.pathname}${u.search}`, nav);
  const cookie = sessionCookie(r);
  const me = await call("GET", "/api/session", {
    cookie,
    "sec-fetch-site": "same-origin",
  });
  return {
    link,
    r,
    cookie,
    me: me.json,
    headers: {
      cookie,
      origin: base,
      "x-den-csrf": String(me.json.csrf ?? ""),
    },
  };
}
const setConfig = (extra: string[]) =>
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    [...BASE_CONFIG, ...extra, ""].join("\n"),
  );

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-av796-")));
  root = path.join(tmp, "dist");
  const home = path.join(tmp, "home");
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  setConfig([]);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [...AGENT_KEYS, "DEN_HOME", "DEN_TEST_INSTALL"])
    delete env[k];
  const s = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        HOME: home,
        DEN_HOME: stateDir,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 40_000 },
  );
  port = s.port;
  base = `http://localhost:${port}`;
  server = s.server;
  out = s.out;
  agentToken = agentTokenNow();
}, 90_000);
afterAll(async () => {
  if (server) await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("clause 1: a view for the agent's own Den, through its token", () => {
  it("the agent's token gets a one-time loopback link; opened, a session that says it is a view", async () => {
    const v = await openView();
    expect(String(v.link.json.url)).toMatch(
      /^http:\/\/localhost:\d+\/auth\?agent_view=/,
    );
    expect(v.link.json.minutes).toBe(10);
    // Issue 1243: the answer says the link is the agent's own, never a person's.
    expect(String(v.link.json.note)).toMatch(
      /your own browser on this machine.*Never give it to a person/,
    );
    expect([v.r.status, String(v.r.headers.location)]).toEqual([
      303,
      "/agents",
    ]);
    expect(v.cookie).not.toBe("");
    expect(v.me).toMatchObject({
      signedIn: true,
      actor: "agent:builder",
      view: { agent: "agent:builder", readOnly: true },
    });
    // No approval key rides along: a view never approves.
    expect(String(v.r.headers.location)).not.toMatch(/#ak=/);
  });

  it("a person's CLI token, no credential, and a claimed agent get no link", async () => {
    const person = {
      authorization: `Bearer ${personToken(readWebSecret(stateDir)!)}`,
    };
    const claimed = {
      "x-den-actor": "agent",
      "x-den-actor-client": "claude-code",
      ...person,
    };
    for (const h of [person, claimed, {}]) {
      const r = await call("POST", "/api/agents/self/view", h, {});
      expect(r.status === 200).toBe(false);
      expect(r.json.url).toBeUndefined();
    }
  });

  it("the link is one-time", async () => {
    const link = await viewLink();
    const u = new URL(String(link.json.url));
    const q = `${u.pathname}${u.search}`;
    const head = await call("HEAD", q, nav);
    expect(sessionCookie(head)).toBe("");
    expect((await call("GET", q, nav)).status).toBe(303);
    const again = await call("GET", q, nav);
    expect(again.status).toBe(401);
    expect(sessionCookie(again)).toBe("");
    expect(again.body.includes(u.searchParams.get("agent_view")!)).toBe(false);
  });
});

describe("clause 2: viewing only, by route class", () => {
  it("opens Agents, Settings and Terminals, and reads the API", async () => {
    const v = await openView();
    const page = { cookie: v.cookie, ...nav };
    for (const p of ["/agents", "/settings", "/terminals"])
      expect([p, (await call("GET", p, page)).status]).toEqual([p, 200]);
    // Issue 482: the old terminal page's address goes on to Terminals,
    // which the view may open (above).
    const old = await call("GET", "/agents?terminal=1", page);
    expect(old.status).toBe(302);
    expect(String(old.headers.location ?? "")).toMatch(/^\/terminals(\?|$)/);
    const read = { cookie: v.cookie, "sec-fetch-site": "same-origin" };
    expect((await call("GET", "/api/settings", read)).status).toBe(200);
  });

  it.each([
    ["Allow", "POST", "/api/approvals/a1/decide", { decision: "allow" }],
    ["Deny", "POST", "/api/approvals/a1/decide", { decision: "deny" }],
    ["a setting", "POST", "/api/settings", { language: "es" }],
    [
      "a person-only setting",
      "POST",
      "/api/settings",
      { agents_default_mode: "auto" },
    ],
    [
      "an agent's start",
      "POST",
      "/api/workspaces/north/agents/builder/start",
      {},
    ],
    [
      "an agent's stop",
      "POST",
      "/api/workspaces/north/agents/builder/stop",
      {},
    ],
    ["Hub", "POST", "/api/hub/connect", {}],
    ["another view link", "POST", "/api/agents/self/view", {}],
  ])("%s is refused", async (_what, method, p, body) => {
    const v = await openView();
    const r = await call(method, p, v.headers, body);
    expect([r.status, r.json.code]).toEqual([403, "agent_view"]);
    expect(String(r.json.error)).toMatch(/agent:builder's view .*read-only/);
  });

  it("a GET that starts something, and the sign-in records, are refused", async () => {
    const v = await openView();
    const read = { cookie: v.cookie, "sec-fetch-site": "same-origin" };
    for (const p of ["/api/run", "/api/web/sessions", "/api/hub/status"]) {
      const r = await call("GET", p, read);
      expect([p, r.status, r.json.code]).toEqual([p, 403, "agent_view"]);
    }
  });

  it("no typing into a terminal: its WebSocket is refused", async () => {
    const v = await openView();
    const r = await upgrade("/api/sessions/s1/io", {
      cookie: v.cookie,
      origin: base,
      "sec-websocket-protocol": `den.csrf.${String(v.me.csrf ?? "")}`,
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/agent_view/);
  });

  it("it can sign itself out", async () => {
    const v = await openView();
    const r = await call("POST", "/api/session/logout", v.headers, {});
    expect(r.status).toBe(200);
    const me = await call("GET", "/api/session", {
      cookie: v.cookie,
      "sec-fetch-site": "same-origin",
    });
    expect(me.json.signedIn).toBe(false);
  });
});

describe("clause 3: logged as the agent, never the person", () => {
  it("page views and refusals carry the agent's name in the log and the audit", async () => {
    const v = await openView();
    await call("GET", "/settings", { cookie: v.cookie, ...nav });
    await call("POST", "/api/settings", v.headers, { language: "es" });
    expect(out()).toMatch(/agent:builder \(read-only view\) viewed \/settings/);
    expect(out()).toMatch(
      /agent:builder \(read-only view\) refused POST \/api\/settings/,
    );
    const rows = audit().filter((e) => e.verb === "agent-view");
    const viewed = rows.find((e) => e.detail === "viewed /settings");
    const refused = rows.find(
      (e) => e.detail === "POST /api/settings" && e.outcome === "refused",
    );
    for (const row of [viewed, refused]) {
      expect(row?.principal).toBe("agent:builder");
      expect(JSON.stringify(row)).not.toMatch(/person:/);
    }
  });
});

describe("clause 4: off per install", () => {
  it("web.agent_view: false refuses the link, says so plainly, and ends open views", async () => {
    const v = await openView();
    setConfig(["web:", "  agent_view: false"]);
    try {
      const r = await viewLink();
      expect([r.status, r.json.code]).toEqual([403, "agent_view_off"]);
      expect(String(r.json.error)).toMatch(/off on this install/);
      const me = await call("GET", "/api/session", {
        cookie: v.cookie,
        "sec-fetch-site": "same-origin",
      });
      expect(me.json.signedIn).toBe(false);
    } finally {
      setConfig([]);
    }
    expect((await viewLink()).status).toBe(200);
  });

  it("Settings reads it, on by default, with its minutes", async () => {
    const v = await openView();
    const r = await call("GET", "/api/settings", {
      cookie: v.cookie,
      "sec-fetch-site": "same-origin",
    });
    expect(r.json.web_agent_view).toEqual({ on: true, minutes: 10 });
  });
});

describe("a view gets nothing an agent's token is refused", () => {
  it("the sign-in pages are closed to it", async () => {
    const v = await openView();
    const r = await call(
      "GET",
      `/attest?return=${encodeURIComponent("https://den.example.test/")}`,
      { cookie: v.cookie, ...nav },
    );
    expect([r.status, r.json.code]).toEqual([403, "agent_view"]);
    expect(String(r.headers.location ?? "")).toBe("");
  });

  it("every read-only route: when the agent's token is refused, so is its view", async () => {
    const v = await openView();
    const read = { cookie: v.cookie, "sec-fetch-site": "same-origin" };
    const paths = ROUTES.filter(
      (r) =>
        r.cls === "readonly" &&
        r.methods.includes("GET") &&
        r.path.startsWith("/api/"),
    ).map((r) => r.path.replace(/:[A-Za-z_]+/g, "x1").replace(/\*$/, "x1"));
    expect(paths.length).toBeGreaterThan(50);
    const leaks: string[] = [];
    for (const p of paths) {
      if (p === "/api/session" || p.startsWith("/api/session/")) continue;
      const a = await quick(p, asAgent());
      if (a !== 403) continue;
      const b = await quick(p, read);
      // A route that never answers the view (0) is no leak.
      if (b >= 200 && b < 400) leaks.push(`${p}: agent ${a}, view ${b}`);
    }
    expect(leaks).toEqual([]);
  }, 120_000);

  it("person-only reads, by name", async () => {
    const v = await openView();
    const read = { cookie: v.cookie, "sec-fetch-site": "same-origin" };
    for (const p of [
      "/api/alerts",
      "/api/alerts/push-key",
      "/api/embed/app-keys",
    ]) {
      const r = await call("GET", p, read);
      expect([p, r.status]).toEqual([p, 403]);
    }
  });
});

describe("clause 5: short-lived, this machine, own Den only", () => {
  it("a view link opened by another machine's name is refused", async () => {
    const link = await viewLink();
    const u = new URL(String(link.json.url));
    const r = await call(
      "GET",
      `${u.pathname}${u.search}`,
      nav,
      undefined,
      "den-elsewhere.example",
    );
    expect(r.status === 303).toBe(false);
    expect(sessionCookie(r)).toBe("");
  });

  it("the view ends when the agent's token goes", async () => {
    const v = await openView();
    revokeAgentTokens(stateDir, "builder");
    try {
      const me = await call("GET", "/api/session", {
        cookie: v.cookie,
        "sec-fetch-site": "same-origin",
      });
      expect(me.json.signedIn).toBe(false);
    } finally {
      agentToken = agentTokenNow();
    }
  });

  it("never counts as a person: first run stays, the devices list names the agent", async () => {
    await openView();
    expect(fs.existsSync(path.join(stateDir, FIRST_RUN_FILE))).toBe(false);
    const list = await call("GET", "/api/web/sessions", {
      authorization: `Bearer ${personToken(readWebSecret(stateDir)!)}`,
    });
    const rows = (list.json.sessions ?? []) as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      expect([row.via, row.agent]).toEqual(["agent-view", "agent:builder"]);
  });
});
