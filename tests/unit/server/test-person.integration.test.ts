/**
 * Issue 636 on real servers: a supported test-person path for the CLI.
 * A driver inside an agent-like environment (DEN_AGENT and an agent's
 * token set) runs `<cli> --test-person <command>`:
 *  1. on an install not marked a test bed, or marked but not bound (no
 *     launch flag), it is refused with a clear error, nothing runs, and the
 *     audit shows nothing done (refused rows only);
 *  2. on a test bed it acts as the person (a person-only command runs),
 *     and its audit row names the test-person path;
 *  3. the mark can't be set or cleared through an agent's token (403);
 *  4. (doctor: test-person.test.ts.)
 * No token or secret is printed: failures show statuses and codes.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import {
  bindActorSession,
  mintActorToken,
} from "../../../src/shared/actor-token.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { personToken, readWebSecret } from "../../../src/shared/web-secret.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const AGENT_KEYS = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_PERSON_TOKEN",
];
const MARKED = ["environments: [local]", "web:", "  test_install: true", ""];
const PLAIN = ["environments: [local]", ""];

interface Den {
  root: string;
  home: string;
  stateDir: string;
  port: number;
  server: ChildProcess | null;
}
let tmp = "";
let bed: Den;
let noflag: Den;
let unmarked: Den;

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [...AGENT_KEYS, "DEN_HOME", "DEN_TEST_INSTALL"])
    delete env[k];
  return env;
}

function layout(name: string, config: string[]): Den {
  const root = path.join(tmp, name, "dist");
  const home = path.join(tmp, name, "home");
  const stateDir = path.join(tmp, name, "state");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(path.join(root, "config", "den.yml"), config.join("\n"));
  return { root, home, stateDir, port: 0, server: null };
}

async function startDen(name: string, flag: boolean): Promise<Den> {
  const d = layout(name, MARKED);
  const s = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: d.root,
      env: {
        ...baseEnv(),
        DEN_ROOT: d.root,
        DEN_ENGINE_ROOT: ENGINE,
        HOME: d.home,
        DEN_HOME: d.stateDir,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        ...(flag ? { DEN_TEST_INSTALL: "1" } : {}),
      },
    },
    { timeoutMs: 40_000 },
  );
  // The CLI finds its server by web.port.
  fs.writeFileSync(
    path.join(d.root, "config", "local", "user.yml"),
    `web:\n  port: ${s.port}\n`,
  );
  return { ...d, port: s.port, server: s.server };
}

/** A live agent's token on `den` (its session record says it runs). */
function agentToken(den: Den): string {
  fs.mkdirSync(den.stateDir, { recursive: true, mode: 0o700 });
  const { token, key } = mintActorToken(den.stateDir, {
    agentId: "stub",
    workspace: "north",
    sessionName: "stub",
  });
  const id = `s-stub-${Math.random().toString(36).slice(2, 8)}`;
  bindActorSession(den.stateDir, key, id);
  const dir = sessionPaths(den.stateDir).dir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, exited: false }),
  );
  return token;
}

/** `<cli> <args>` on `den`, from an agent-like environment. */
function cliAsAgent(den: Den, args: string[]) {
  const token = agentToken(den);
  return spawnSync(
    TSX,
    [path.join(ENGINE, "src", "ui", "cli", "index.ts"), ...args],
    {
      cwd: den.root,
      encoding: "utf-8",
      timeout: 90_000,
      env: {
        ...baseEnv(),
        DEN_ROOT: den.root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: den.stateDir,
        HOME: den.home,
        NO_COLOR: "1",
        CI: "1",
        DEN_AGENT: "stub",
        DEN_ACTOR_TOKEN: token,
      },
    },
  );
}

function auditRows(den: Den): Record<string, unknown>[] {
  const f = path.join(den.stateDir, "audit.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
/** Rows that say something was done (not refused). */
const doneRows = (den: Den) =>
  auditRows(den).filter((r) => r.outcome !== "refused");

function call(
  den: Den,
  method: string,
  p: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: den.port,
        path: p,
        method,
        agent: false,
        timeout: 20_000,
        headers: {
          connection: "close",
          host: `localhost:${den.port}`,
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
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(payload);
  });
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-tp636-")));
  unmarked = layout("unmarked", PLAIN);
  [bed, noflag] = await Promise.all([
    startDen("bed", true),
    startDen("noflag", false),
  ]);
}, 120_000);
afterAll(async () => {
  await Promise.all(
    [bed, noflag].filter((d) => d?.server).map((d) => stopServer(d.server!)),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("1. not a test bed: --test-person is refused and nothing is done", () => {
  it("an install with no mark: refused before anything runs", () => {
    const r = cliAsAgent(unmarked, ["--test-person", "notifications", "clear"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /--test-person is refused: this install isn't a test bed/,
    );
    expect(r.stdout).not.toMatch(/Cleared/);
    expect(doneRows(unmarked)).toEqual([]);
  }, 120_000);

  it("marked but not a bound test bed (no launch flag): the server refuses, the audit shows nothing done", () => {
    const before = doneRows(noflag).length;
    const r = cliAsAgent(noflag, ["--test-person", "notifications", "clear"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/isn't a test bed/);
    expect(r.stdout).not.toMatch(/Cleared/);
    expect(doneRows(noflag).length).toBe(before);
    expect(
      auditRows(noflag).some(
        (x) => x.outcome === "refused" && x.reason === "not_test_bed",
      ),
    ).toBe(true);
  }, 120_000);

  it("the header with the person's token, straight to a route: 403, nothing done", async () => {
    const before = doneRows(noflag).length;
    const r = await call(
      noflag,
      "POST",
      "/api/web/test-person",
      {
        authorization: `Bearer ${personToken(readWebSecret(noflag.stateDir)!)}`,
        "x-den-test-person": "1",
      },
      { command: "agents stop" },
    );
    expect([r.status, r.json.code]).toEqual([403, "not_test_bed"]);
    expect(doneRows(noflag).length).toBe(before);
  });
});

describe("2. on a test bed --test-person acts as the person, on the record", () => {
  it("a person-only command runs from an agent's environment, and its row names the path", () => {
    // Without the flag, the agent's environment is refused it.
    const plain = cliAsAgent(bed, ["notifications", "clear"]);
    expect(plain.status).toBe(1);
    expect(plain.stderr).toMatch(/the bell is the person's/);

    const r = cliAsAgent(bed, ["--test-person", "notifications", "clear"]);
    expect([r.status, r.stderr]).toEqual([0, expect.any(String)]);
    expect(r.stdout).toMatch(/Cleared/);
    const row = auditRows(bed).find((x) => x.verb === "test-person");
    expect(row).toMatchObject({
      actor: "user",
      principal: `person:${os.userInfo().username}`,
      via: "test-person",
    });
    expect(row).not.toHaveProperty("outcome");
    expect(String(row?.detail)).toMatch(/notifications clear as the person/);
  }, 120_000);

  it("an agent's token with the header is refused, even here", async () => {
    const token = agentToken(bed);
    const r = await call(
      bed,
      "POST",
      "/api/web/test-person",
      { authorization: `Bearer ${token}`, "x-den-test-person": "1" },
      { command: "agents stop" },
    );
    // Refused before any route: by the path's own check, or first by the
    // token's binding to its agent's processes (request-guard-test-person
    // has the path's check alone).
    expect(r.status).toBe(403);
    expect(["test_person_refused", "agent_token_elsewhere"]).toContain(
      r.json.code,
    );
    expect(
      auditRows(bed).some(
        (x) =>
          x.verb === "test-person" && String(x.detail).includes("agents stop"),
      ),
    ).toBe(false);
  });
});

describe("3. the mark can't be set or cleared through an agent's token", () => {
  it("POST /api/settings with test_install, as an agent: 403, the config unchanged", async () => {
    const file = path.join(bed.root, "config", "den.yml");
    const before = fs.readFileSync(file, "utf-8");
    const token = agentToken(bed);
    for (const body of [
      { test_install: false },
      { web_test_install: false },
      { test_install: true },
    ]) {
      const r = await call(
        bed,
        "POST",
        "/api/settings",
        { authorization: `Bearer ${token}` },
        body,
      );
      expect(r.status).toBe(403);
    }
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    // Still a test bed: the path still works for the person.
    const ok = cliAsAgent(bed, ["--test-person", "notifications", "clear"]);
    expect(ok.status).toBe(0);
  }, 120_000);
});
