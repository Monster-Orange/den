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
  extra: Record<string, string> = {},
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
          ...extra,
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
            json = {};
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

function setFocus(focus: string): void {
  fs.writeFileSync(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [north, south]",
      `focus: ${focus}`,
      "workspaces:",
      "  north:",
      "    services: []",
      "  south:",
      "    services: []",
      "",
    ].join("\n"),
  );
}

function setMode(mode: "strict" | "personal"): void {
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    `install_mode: ${mode}\napprovals:\n  policy: ask\n`,
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
  setFocus("north");
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
    expect(new Set(rowsOf(s, "sessions"))).toEqual(new Set(["north", "south"]));
  });
  it("a read of the focused project is refused while another project is focused", async () => {
    const t = token("north");
    const paths = [
      "/api/workspaces/available-repos",
      "/api/workspaces/settings",
      "/api/workspaces/deps-check",
      "/api/test-sources?pillar=smoke",
    ];
    try {
      setFocus("south");
      const away = await Promise.all(
        paths.map(async (p) => [p, (await call("GET", p, t)).json.code]),
      );
      expect(away.filter(([, c]) => c !== "agent_forbidden")).toEqual([]);
      const named = await call(
        "GET",
        "/api/test-sources?pillar=smoke&workspace=north",
        t,
      );
      expect([named.status, named.json.code]).toEqual([403, "agent_forbidden"]);
      const services = await call("GET", "/api/workspaces/services", t);
      expect(services.status).toBe(404);
      setFocus("north");
      const home = await Promise.all(
        paths.map(async (p) => [p, (await call("GET", p, t)).json.code]),
      );
      expect(home.filter(([, c]) => c === "agent_forbidden")).toEqual([]);
    } finally {
      setFocus("north");
    }
  });

  it("an agent reads its own ask by id; another agent's is no such request", async () => {
    const mine = token("north");
    const asked = await call("POST", "/api/approvals", mine, {
      action: "workspace_create",
      args: { name: "east" },
    });
    expect(asked.status).toBe(202);
    const id = String(asked.json.id);
    expect((await call("GET", `/api/approvals/${id}`, mine)).status).toBe(200);
    const other = token("north", undefined, "other");
    expect((await call("GET", `/api/approvals/${id}`, other)).status).toBe(404);
  });

  it("the person's own reads across every project are refused; the server agent reads them", async () => {
    const t = token("north");
    const got = await Promise.all(
      [
        "/api/server-log",
        "/api/approvals",
        "/api/alerts/devices",
        "/api/report/diagnostics",
        "/api/catalog",
        "/api/personas",
        "/api/verify/overview",
      ].map(async (p) => [p, (await call("GET", p, t)).status]),
    );
    expect(got.filter(([, s]) => s !== 403)).toEqual([]);
    const server = token("den-server", undefined, "server");
    expect((await call("GET", "/api/approvals", server)).status).not.toBe(403);
  });

  it("an agent reads its own request's status on both paths; another's is unknown", async () => {
    const mine = token("north");
    const rid = { "x-den-request-id": "own-req-0001" };
    await call(
      "POST",
      "/api/approvals",
      mine,
      {
        action: "workspace_create",
        args: { name: "west" },
      },
      rid,
    );
    for (const p of ["/api/requests/own-req-0001", "/requests/own-req-0001"]) {
      const got = await call("GET", p, mine);
      expect([p, got.status, got.json.state]).toEqual([p, 200, "done"]);
    }
    const other = token("north", undefined, "other");
    const theirs = await call("GET", "/requests/own-req-0001", other);
    expect(theirs.json.state).toBe("unknown");
  });

  it("the helpers count is served on strict, counted within the agent's projects", async () => {
    const got = await call("GET", "/api/sessions/helpers", token("north"));
    expect(got.status).toBe(200);
    expect(typeof got.json.running).toBe("number");
  });

  it("a log read of another project's repo is refused", async () => {
    const t = token("north");
    const got = await Promise.all(
      [
        "/api/service/history?repo=rover-repo&service=api",
        "/api/service/taillog?repo=rover-repo&service=api",
        "/api/service/logs?repo=rover-repo&service=api",
        "/api/logs/search?q=boom&targets=rover-repo/api",
      ].map(async (p) => [p, (await call("GET", p, t)).json.code]),
    );
    expect(got.filter(([, c]) => c !== "agent_forbidden")).toEqual([]);
  });
});

describe("personal install", () => {
  beforeAll(() => setMode("personal"));

  it("reads of another project are served, and lists show every project", async () => {
    const t = token("north");
    expect((await call("GET", "/api/workspaces/south/agents", t)).status).toBe(
      200,
    );
    expect((await call("GET", "/api/sessions?ws=south", t)).status).toBe(200);
    const s = await call("GET", "/api/sessions", t);
    expect(new Set(rowsOf(s, "sessions"))).toEqual(new Set(["north", "south"]));
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

  it("a sync of the focused project: refused when it is another project, run when it is the agent's", async () => {
    const t = token("north");
    try {
      setFocus("south");
      const r = await call("POST", "/api/workspace/sync", t, {});
      expect([r.status, r.json.code]).toEqual([403, "agent_forbidden"]);
      setFocus("north");
      expect((await call("POST", "/api/workspace/sync", t, {})).status).toBe(
        200,
      );
    } finally {
      setFocus("north");
    }
  });

  it("the person's own reads are served to an agent on a personal install", async () => {
    const t = token("north");
    const got = await Promise.all(
      ["/api/catalog", "/api/personas", "/api/verify/overview"].map(
        async (p) => [p, (await call("GET", p, t)).json.code],
      ),
    );
    expect(got.filter(([, c]) => c === "agent_forbidden")).toEqual([]);
  });

  it("a log read is not held by repo on a personal install", async () => {
    const t = token("north");
    const r = await call(
      "GET",
      "/api/service/history?repo=rover-repo&service=api",
      t,
    );
    expect(r.json.code).not.toBe("agent_forbidden");
  });

  it("a service's up, down or restart, and a test run, on another focused project are refused", async () => {
    const t = token("north");
    try {
      setFocus("south");
      const exec = await call(
        "GET",
        "/api/service/exec?repo=rover-repo&service=api&cmd=restart&env=local",
        t,
      );
      const run = await call("GET", "/api/run?pillar=smoke", t);
      const head = await call("HEAD", "/api/run?pillar=smoke", t);
      expect([exec.status, exec.json.code]).toEqual([403, "agent_forbidden"]);
      expect([run.status, run.json.code]).toEqual([403, "agent_forbidden"]);
      expect(head.status).toBe(403);
      setFocus("north");
      const own = await call(
        "GET",
        "/api/service/exec?repo=rover-repo&service=api&cmd=restart&env=local",
        t,
      );
      expect(own.json.code).not.toBe("agent_forbidden");
    } finally {
      setFocus("north");
    }
  });
});
