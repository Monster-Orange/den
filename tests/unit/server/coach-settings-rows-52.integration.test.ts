/**
 * Issue 52 on a real server: the Coach's Settings rows (coach-settings-pref.ts). POST /api/settings
 * `coach` is a person's write: an agent's token is refused and nothing is
 * written. A person's write lands in config/local/user.yml's agents.coach,
 * never the distribution's config; GET /api/settings shows it; turning
 * judging on or off is audited. No token is printed: failures show
 * statuses and codes.
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
let server: ChildProcess;

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
const asPerson = () => ({
  authorization: `Bearer ${personToken(readWebSecret(stateDir)!)}`,
});
const setConfig = (extra: string[]) =>
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    [...BASE_CONFIG, ...extra, ""].join("\n"),
  );

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-coach52-")));
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
  server = s.server;
  agentToken = agentTokenNow();
}, 90_000);
afterAll(async () => {
  if (server) await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const userYml = () => path.join(root, "config", "local", "user.yml");
const denYml = () =>
  fs.readFileSync(path.join(root, "config", "den.yml"), "utf-8");

describe("the Coach's Settings rows (issue 52)", () => {
  it("an agent's token can't switch judging on; nothing is written", async () => {
    const before = denYml();
    const r = await call("POST", "/api/settings", asAgent(), {
      coach: { judge: { enabled: true } },
    });
    expect(r.status).toBe(403);
    const u = fs.existsSync(userYml())
      ? fs.readFileSync(userYml(), "utf-8")
      : "";
    expect(u).not.toMatch(/judge/);
    expect(denYml()).toBe(before);
    const g = await call("GET", "/api/settings", asPerson());
    expect(g.json.coach).toEqual({
      enabled: false,
      window_days: 7,
      judge: { enabled: false },
    });
  });

  it("a person's write goes to user.yml only, shows in GET, and judging is audited", async () => {
    const before = denYml();
    const r = await call("POST", "/api/settings", asPerson(), {
      coach: { enabled: true, window_days: 14, judge: { enabled: true } },
    });
    expect([r.status, r.json.ok]).toEqual([200, true]);
    expect(r.json.coach).toEqual({
      enabled: true,
      window_days: 14,
      judge: { enabled: true },
    });
    const u = fs.readFileSync(userYml(), "utf-8");
    expect(u).toMatch(/coach:/);
    expect(u).toMatch(/window_days: 14/);
    expect(denYml()).toBe(before);
    const g = await call("GET", "/api/settings", asPerson());
    expect(g.json.coach).toMatchObject({ judge: { enabled: true } });
    const lines = audit().filter((a) => a.verb === "coach-judge");
    expect(lines.map((a) => a.detail)).toEqual([
      "Coach judging turned on: samples go to the model provider",
    ]);
    // Off again: audited too; an unchanged judge writes no line.
    await call("POST", "/api/settings", asPerson(), {
      coach: { judge: { enabled: false } },
    });
    await call("POST", "/api/settings", asPerson(), {
      coach: { window_days: 10 },
    });
    expect(
      audit()
        .filter((a) => a.verb === "coach-judge")
        .map((a) => a.detail),
    ).toEqual([
      "Coach judging turned on: samples go to the model provider",
      "Coach judging turned off",
    ]);
  });

  it("a bad value is refused with its key named, and nothing changes", async () => {
    const before = fs.readFileSync(userYml(), "utf-8");
    const r = await call("POST", "/api/settings", asPerson(), {
      coach: { window_days: 0 },
    });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/coach\.window_days/);
    expect(fs.readFileSync(userYml(), "utf-8")).toBe(before);
  });
});
