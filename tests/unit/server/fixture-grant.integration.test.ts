/**
 * Issue 816 on real servers: the test install's side of setting up its test
 * person from your own Den.
 *  - test: a test install whose launcher opted in (<PREFIX>_TEST_ANNOUNCE=1).
 *    It announces itself under ~/.<cli>/test-installs at start. A grant your
 *    Den minted under its web.secret, sent with its person bearer, makes the
 *    key once; it answers the challenge as itself, and its announcement goes.
 *  - plain: opted in, but not a test install (no launch flag). It never
 *    announces, and a grant is refused.
 * The route needs the bearer and the grant: either alone writes nothing. An
 * agent's token is refused before the body is read. No answer, log line or
 * audit line holds the grant or the bearer.
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
} from "../../../src/shared/actor-token.js";
import { fixturePersonPath } from "../../../src/shared/fixture-person.js";
import { readFixtureMadeBy } from "../../../src/shared/fixture-setup-secret.js";
import {
  installIdOf,
  mintSetupGrant,
} from "../../../src/shared/test-install-grant.js";
import {
  identityAnswer,
  identityKey,
  newChallenge,
} from "../../../src/shared/den-identity.js";
import { personToken, readWebSecret } from "../../../src/shared/web-secret.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const STRIP = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_PERSON_TOKEN",
  "DEN_HOME",
  "DEN_TEST_INSTALL",
  "DEN_TEST_ANNOUNCE",
  "DEN_FIXTURE_SETUP_SECRET",
];

interface Den {
  home: string;
  stateDir: string;
  port: number;
  server: ChildProcess;
  out: () => string;
}
let tmp = "";
let test: Den;
let plain: Den;
const sent: string[] = [];

async function startDen(name: string, o: { flag: boolean }): Promise<Den> {
  const root = path.join(tmp, name, "dist");
  const home = path.join(tmp, name, "home");
  const stateDir = path.join(tmp, name, "state");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  // Not new: no fixture person at creation (issue 814); it waits for setup.
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "earlier.txt"), "an earlier start\n");
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    ["environments: [local]", "web:", "  test_install: true", ""].join("\n"),
  );
  const env = { ...process.env };
  for (const k of STRIP) delete env[k];
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
        DEN_TEST_ANNOUNCE: "1",
        ...(o.flag ? { DEN_TEST_INSTALL: "1" } : {}),
      },
    },
    { timeoutMs: 40_000 },
  );
  return { home, stateDir, port: s.port, server: s.server, out: s.out };
}

const secretOf = (d: Den) => readWebSecret(d.stateDir)!;
const announcement = (d: Den) =>
  path.join(d.home, ".den", "test-installs", `${installIdOf(d.stateDir)}.json`);
const hasKey = (d: Den) => fs.existsSync(fixturePersonPath(d.stateDir));
const grantFor = (d: Den) => {
  const g = mintSetupGrant({
    secret: secretOf(d),
    id: installIdOf(d.stateDir),
    from: "aaaaaaaaaaaaaaaa",
  });
  sent.push(g);
  return g;
};

function post(
  d: Den,
  body: unknown,
  bearer: string | null,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: d.port,
        path: "/api/web/fixture-person/grant",
        method: "POST",
        agent: false,
        timeout: 20_000,
        headers: {
          connection: "close",
          host: `localhost:${d.port}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => (buf += c.toString()));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(buf) as Record<string, unknown>;
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const audit = (d: Den) => {
  try {
    return fs.readFileSync(path.join(d.stateDir, "audit.jsonl"), "utf-8");
  } catch {
    return "";
  }
};

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-fg816-")));
  [test, plain] = await Promise.all([
    startDen("test", { flag: true }),
    startDen("plain", { flag: false }),
  ]);
}, 120_000);
afterAll(async () => {
  await Promise.all(
    [test, plain].filter(Boolean).map((d) => stopServer(d.server)),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("issue 816: the test install's grant route", () => {
  it("a waiting test install announces itself: 0600, no secret", () => {
    const f = announcement(test);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    const body = fs.readFileSync(f, "utf8");
    expect(JSON.parse(body)).toMatchObject({ port: test.port });
    expect(body).not.toContain(secretOf(test).toString("hex"));
  });

  it("an install that isn't a test install never announces", () => {
    expect(fs.existsSync(announcement(plain))).toBe(false);
  });

  it("the bearer alone, without a grant, writes nothing", async () => {
    const r = await post(test, {}, personToken(secretOf(test)));
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("bad_grant");
    expect(hasKey(test)).toBe(false);
  });

  it("a grant alone, without the bearer, writes nothing", async () => {
    const r = await post(test, { grant: grantFor(test) }, null);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(hasKey(test)).toBe(false);
  });

  it("an agent's token is refused before the body is read", async () => {
    const t = mintActorToken(test.stateDir, {
      agentId: "builder",
      workspace: "north",
      sessionName: "builder",
    });
    bindActorSession(test.stateDir, t.key, "s-builder");
    const r = await post(test, { grant: grantFor(test) }, t.token);
    // The guard refuses it (401 unauthorized here: no live session holds
    // it; 403 from another process), or the route does (403 person_only).
    expect([401, 403]).toContain(r.status);
    expect(["unauthorized", "agent_token_elsewhere", "person_only"]).toContain(
      r.json.code,
    );
    expect(hasKey(test)).toBe(false);
  });

  it("not a test install: a good grant and bearer are refused", async () => {
    const r = await post(
      plain,
      { grant: grantFor(plain), challenge: newChallenge() },
      personToken(secretOf(plain)),
    );
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("not_test_install");
    expect(hasKey(plain)).toBe(false);
  });

  it("bearer and grant: the key is made once, it answers as itself, and its announcement goes", async () => {
    const challenge = newChallenge();
    const grant = grantFor(test);
    const r = await post(
      test,
      { grant, challenge },
      personToken(secretOf(test)),
    );
    expect([r.status, r.json.ok, r.json.ready]).toEqual([200, true, true]);
    expect(r.json.answer).toBe(
      identityAnswer(identityKey(secretOf(test)), challenge),
    );
    expect(hasKey(test)).toBe(true);
    expect(readFixtureMadeBy(test.stateDir)).toBe("grant");
    expect(fs.existsSync(announcement(test))).toBe(false);
    const again = await post(
      test,
      { grant, challenge: newChallenge() },
      personToken(secretOf(test)),
    );
    expect(again.json.code).toBe("spent");
  });

  it("the list: 401 without a sign-in, 403 for an agent, 200 for the person", async () => {
    const get = (bearer: string | null) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: plain.port,
            path: "/api/web/test-installs",
            method: "GET",
            agent: false,
            headers: {
              connection: "close",
              host: `localhost:${plain.port}`,
              ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end();
      });
    expect(await get(null)).toBe(401);
    const t = mintActorToken(plain.stateDir, {
      agentId: "builder",
      workspace: "north",
      sessionName: "builder",
    });
    // Either answer refuses the agent, and which one depends on where it
    // stops. This token is minted but bound to no live session, so the
    // request guard usually refuses it first: 401 unauthorized (or 403
    // agent_token_elsewhere when another process holds it). Only a token
    // the guard accepts reaches the route, which answers 403 person_only.
    // test-installs-access-816.test.ts gives the route's check an agent
    // principal directly and expects person_only.
    expect([401, 403]).toContain(await get(t.token));
    expect(await get(personToken(secretOf(plain)))).toBe(200);
  });

  it("no grant or bearer in any log or audit line", () => {
    const seen = [test.out(), plain.out(), audit(test), audit(plain)].join(
      "\n",
    );
    for (const g of sent) expect(seen).not.toContain(g);
    expect(seen).not.toContain(personToken(secretOf(test)));
  });
});
