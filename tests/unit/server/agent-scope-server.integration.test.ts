/**
 * An agent token's project scope on a real server, in both install modes.
 * Two projects, north and south, one stopped agent in each; the asking
 * agent's token is north's.
 *  - strict: a read naming south (path or query) is refused, and an
 *    unknown project the same way; lists show north only;
 *  - personal: reads of south are served; a write naming south is refused;
 *  - a grant to south, and the server agent's reserved scope, reach it.
 * No token is printed: failures show statuses and project names.
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
import { writeRecord } from "../../../src/shared/agents/records.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const AGENT_KEYS = [
  "DEN_AGENT",
  "DEN_ACTOR_TOKEN",
  "DEN_ACTOR_TOKEN_FILE",
  "DEN_PERSON_TOKEN",
];

let tmp = "";
let root = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

function call(
  method: string,
  p: string,
  token: string,
  body?: unknown,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method,
        agent: false,
        timeout: 15_000,
        headers: {
          authorization: `Bearer ${token}`,
          ...(data
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
              }
            : {}),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (c: Buffer) => (out += c.toString()));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(out) as Record<string, unknown>;
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(data);
  });
}

/** A token for agent `id` of `workspace`, bound to a session that runs. */
function token(workspace: string, grants?: string[], id = "builder"): string {
  const dir = sessionPaths(stateDir).dir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `s-${id}-live.json`), JSON.stringify({}));
  const t = mintActorToken(stateDir, {
    agentId: id,
    workspace,
    ...(grants ? { grants } : {}),
    sessionName: `den-${workspace}:${id}`,
  });
  bindActorSession(stateDir, t.key, `s-${id}-live`);
  return t.token;
}

function setMode(mode: "strict" | "personal"): void {
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    `install_mode: ${mode}\n`,
  );
}

const rowsOf = (r: Reply, k: string) =>
  ((r.json[k] as { workspace?: string }[] | undefined) ?? []).map(
    (x) => x.workspace,
  );

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-scope-")));
  root = path.join(tmp, "dist");
  const home = path.join(tmp, "home");
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    ["environments: [local]", "agents:", "  token_binding: false", ""].join(
      "\n",
    ),
  );
  fs.writeFileSync(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [north, south]",
      "focus: north",
      "workspaces:",
      "  north:",
      "    services: []",
      "  south:",
      "    services: []",
      "",
    ].join("\n"),
  );
  for (const [id, ws] of [
    ["scout", "north"],
    ["rover", "south"],
  ] as const)
    writeRecord(stateDir, {
      id,
      persona: "builder",
      runtime: "den-claude",
      workspace: ws,
      cwd: tmp,
      session: { backend: "den-pty", id: `s-${id}` },
      sessionName: `den-${ws}:${id}`,
      startedAt: "2026-11-06T09:30:00.000Z",
      stoppedAt: "2026-11-06T10:00:00.000Z",
    });
  setMode("strict");
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
}, 90_000);
afterAll(async () => {
  if (server) await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("strict install", () => {
  beforeAll(() => setMode("strict"));

  it("a read naming another project, or an unknown one, is refused; its own is served", async () => {
    const t = token("north");
    const got = await Promise.all(
      [
        "/api/workspaces/south/agents",
        "/api/workspaces/nosuch/agents",
        "/api/workspaces/south/agents/rover/details",
        "/api/sessions?ws=south",
        "/api/sessions?workspace=south",
        "/api/workspaces/north/agents",
      ].map(async (p) => [p, (await call("GET", p, t)).status]),
    );
    expect(got).toEqual([
      ["/api/workspaces/south/agents", 403],
      ["/api/workspaces/nosuch/agents", 403],
      ["/api/workspaces/south/agents/rover/details", 403],
      ["/api/sessions?ws=south", 403],
      ["/api/sessions?workspace=south", 403],
      ["/api/workspaces/north/agents", 200],
    ]);
  });

  it("the sessions, workspaces and stale lists show its own project only", async () => {
    const t = token("north");
    const s = await call("GET", "/api/sessions", t);
    expect(s.status).toBe(200);
    expect(new Set(rowsOf(s, "sessions"))).toEqual(new Set(["north"]));
    expect(s.json.workspaces).toEqual(["north"]);
    const w = await call("GET", "/api/workspaces", t);
    expect(w.status).toBe(200);
    expect(Object.keys(w.json.workspaces as object)).toEqual(["north"]);
    expect(w.json.active).toEqual(["north"]);
    const st = await call("GET", "/api/agents/stale", t);
    expect(st.status).toBe(200);
    expect(rowsOf(st, "agents").filter((ws) => ws !== "north")).toEqual([]);
  });

  it("a grant to south reaches it; so does the server agent's scope", async () => {
    const granted = token("north", ["south"]);
    expect(
      (await call("GET", "/api/workspaces/south/agents", granted)).status,
    ).toBe(200);
    const server = token("den-server", undefined, "server");
    expect(
      (await call("GET", "/api/workspaces/south/agents", server)).status,
    ).toBe(200);
    const s = await call("GET", "/api/sessions", server);
    expect(new Set(rowsOf(s, "sessions"))).toEqual(
      new Set(["north", "south"]),
    );
  });
});

describe("personal install", () => {
  beforeAll(() => setMode("personal"));

  it("reads of another project are served, and lists show every project", async () => {
    const t = token("north");
    expect(
      (await call("GET", "/api/workspaces/south/agents", t)).status,
    ).toBe(200);
    expect((await call("GET", "/api/sessions?ws=south", t)).status).toBe(200);
    const s = await call("GET", "/api/sessions", t);
    expect(new Set(rowsOf(s, "sessions"))).toEqual(
      new Set(["north", "south"]),
    );
    const w = await call("GET", "/api/workspaces", t);
    expect(Object.keys(w.json.workspaces as object).sort()).toEqual([
      "north",
      "south",
    ]);
  });

  it("a write naming another project is refused", async () => {
    const t = token("north");
    const r = await call("POST", "/api/workspace/sync?workspace=south", t, {});
    expect([r.status, r.json.code]).toEqual([403, "agent_forbidden"]);
  });
});
