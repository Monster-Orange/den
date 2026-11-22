/**
 * Issue 1034, on a real server: the test operator attaches and closes its
 * own shell through the install's own edge, so a live check (gate 653)
 * proves the terminal path that broke in 0.4.75 (the edge's
 * X-Forwarded-Proto `wss`). Nothing else widens: no other act through the
 * edge, no other terminal, no client beyond this machine, no edge without
 * its proof. Every act is audited as the test operator.
 *
 * The edge is modelled with its headers (helpers/edge-proof.ts). The
 * fixture person signs in on the named address through those headers, as
 * a browser on this machine would. No code, cookie or token is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { denAuth } from "./helpers/den-auth.js";
import { EDGE_PROOF } from "./helpers/edge-proof.js";
import {
  mintFixtureCode,
  readFixtureKey,
} from "../../../src/shared/fixture-person.js";

const NAMED = "acme.acme.localhost";
/** What the edge adds for a browser on this machine, over https. */
const EDGE = {
  ...EDGE_PROOF,
  "x-forwarded-for": "127.0.0.1",
  "x-forwarded-proto": "https",
};

let s: AgentsPageServer;
let fx: { cookie: string; csrf: string };
/** The fixture session on the named address (signed in through the edge). */
let fe: { cookie: string; csrf: string };

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

function raw(
  method: string,
  p: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port: s.port,
        path: p,
        method,
        agent: false,
        timeout: 20_000,
        setHost: !("host" in headers),
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
          resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(payload);
  });
}

/** Through the edge, on the named address, as the fixture session's page. */
const viaEdge = (extra: Record<string, string> = {}) => ({
  host: NAMED,
  ...EDGE,
  cookie: fe.cookie,
  origin: `https://${NAMED}`,
  "x-den-csrf": fe.csrf,
  "sec-fetch-site": "same-origin",
  ...extra,
});
/** On loopback, as the fixture session's page (the operator's own way in). */
const onLoopback = () => ({
  cookie: fx.cookie,
  origin: s.base,
  "x-den-csrf": fx.csrf,
  "sec-fetch-site": "same-origin",
});

/** The pane's upgrade on the named address, through the edge as wss. */
function attach(id: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: "localhost",
      port: s.port,
      path: `/api/sessions/${encodeURIComponent(id)}/io`,
      method: "GET",
      agent: false,
      timeout: 20_000,
      setHost: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-protocol": `den.io, den.csrf.${fe.csrf}`,
        ...headers,
      },
    });
    r.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    r.on("response", (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout: upgrade")));
    r.end();
  });
}

function auditRows(): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(s.stateDir, "audit.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The operator's own stub shell, started on loopback. */
async function ownShell(): Promise<string> {
  const r = await raw(
    "POST",
    "/api/workspaces/north/sessions",
    onLoopback(),
    {},
  );
  expect(r.status).toBe(200);
  return (r.json.session as { id: string }).id;
}

/** A fixture sign-in (a new code each time), on loopback or through `via`. */
async function fixtureSession(
  via: Record<string, string>,
): Promise<{ cookie: string; csrf: string }> {
  const code = mintFixtureCode(readFixtureKey(s.stateDir)!);
  const r = await raw("GET", `/auth?fixture=${encodeURIComponent(code)}`, {
    "sec-fetch-site": "none",
    accept: "text/html",
    ...via,
  });
  expect(r.status).toBe(303);
  const cookie =
    ([] as string[])
      .concat(r.headers["set-cookie"] ?? [])
      .map((c) => c.split(";")[0])
      .find((c) => /den_session_/.test(c)) ?? "";
  const me = await raw("GET", "/api/session", {
    cookie,
    "sec-fetch-site": "same-origin",
    ...via,
  });
  return { cookie, csrf: String(me.json.csrf ?? "") };
}

beforeAll(async () => {
  s = await startAgentsPageServer({
    testInstall: true,
    edgeProof: true,
    // An install that counts an edge client it can't place as local (Docker
    // Desktop, OrbStack): the operator still needs the edge to attest this
    // machine (review of issue 1034).
    userYml: `web:\n  url: https://${NAMED}\n  edge_unattested: local\n`,
  });
  fx = await fixtureSession({});
  fe = await fixtureSession({ host: NAMED, ...EDGE });
}, 90_000);
afterAll(async () => {
  await s?.stop();
});

const asPerson = () => ({
  ...denAuth(s.stateDir),
});

describe("the operator's own shell, through the install's own edge (issue 1034)", () => {
  it("attaches as wss: the upgrade answers 101, audited as the test operator", async () => {
    const id = await ownShell();
    expect(await attach(id, viaEdge({ "x-forwarded-proto": "wss" }))).toBe(101);
    const row = auditRows()
      .reverse()
      .find((e) => e.verb === "test-operator");
    expect(row?.principal).toBe("test:operator");
    expect(String(row?.detail)).toMatch(/^terminal-attach /);
  }, 30_000);

  it("closes it", async () => {
    const id = await ownShell();
    const pty = s.made.at(-1)!;
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      if (sig === "SIGHUP") setTimeout(() => pty.exit(129), 10);
    };
    const r = await raw(
      "POST",
      `/api/sessions/${encodeURIComponent(id)}/close`,
      viaEdge(),
    );
    expect([r.status, r.json.ok]).toEqual([200, true]);
  }, 30_000);
});

describe("nothing else widens through the edge", () => {
  it("a person's shell: attach refused", async () => {
    const open = await raw(
      "POST",
      "/api/workspaces/north/sessions",
      asPerson(),
    );
    expect(open.status).toBe(200);
    const { id } = open.json.session as { id: string };
    expect(await attach(id, viaEdge({ "x-forwarded-proto": "wss" }))).toBe(403);
  }, 30_000);

  it("a client beyond this machine: refused", async () => {
    const id = await ownShell();
    const st = await attach(
      id,
      viaEdge({ "x-forwarded-proto": "wss", "x-forwarded-for": "203.0.113.7" }),
    );
    expect(st).toBe(403);
  }, 30_000);

  it("a client the edge can't place (unattested, counted local here): refused", async () => {
    const id = await ownShell();
    // OrbStack presents the host to its containers as 0.250.250.254, and any
    // other machine's request through it can look the same.
    expect(
      await attach(
        id,
        viaEdge({
          "x-forwarded-proto": "wss",
          "x-forwarded-for": "0.250.250.254",
        }),
      ),
    ).toBe(403);
  }, 30_000);

  it("the edge's headers without its proof: refused", async () => {
    const id = await ownShell();
    const { "x-den-edge-proof": _p, ...noProof } = viaEdge({
      "x-forwarded-proto": "wss",
    });
    void _p;
    // Not the edge's word: not https, so the __Host- session does not count.
    expect(await attach(id, noProof)).toBe(401);
  }, 30_000);

  it.each([
    ["POST", "/api/workspaces/north/sessions"],
    ["POST", "/api/workspaces/north/agents/planner/say"],
  ])("%s %s through the edge: refused (fixture_scope)", async (m, p) => {
    const r = await raw(m, p, viaEdge(), { text: "hello" });
    expect([r.status, r.json.code]).toEqual([403, "fixture_scope"]);
  });
});

describe("a real install", () => {
  it("has no fixture person, so no operator: a fixture code is refused at sign-in", async () => {
    const real = await startAgentsPageServer({
      edgeProof: true,
      userYml: `web:\n  url: https://${NAMED}\n`,
    });
    try {
      expect(readFixtureKey(real.stateDir)).toBeNull();
      const code = mintFixtureCode(randomBytes(32));
      const r = await new Promise<number>((resolve, reject) => {
        const q = http.request(
          {
            host: "localhost",
            port: real.port,
            path: `/auth?fixture=${encodeURIComponent(code)}`,
            method: "GET",
            agent: false,
            setHost: false,
            headers: {
              host: NAMED,
              ...EDGE,
              "sec-fetch-site": "none",
              accept: "text/html",
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        q.on("error", reject);
        q.end();
      });
      expect(r).not.toBe(303);
    } finally {
      await real.stop();
    }
  }, 90_000);
});
