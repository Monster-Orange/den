/**
 * Issue 277: repos that run nothing (config, docs, rulesets, shared CI),
 * through a real Den server over a throwaway distribution.
 *
 * Projects: north (focus) holds shop (one service) and cfg (services: {});
 * south holds cfg and rules (services: [], with a test suite); quiet holds
 * rules only. cfg is a shared repo, in north and south.
 *
 * - The services page (/api/services) shows a repo that runs nothing with
 *   no commands (`runs: "none"`), so the project page can show and remove
 *   it; the health row (/api/health) has no row for it: no "unknown", no
 *   "unhealthy".
 * - The graph has them as repo nodes, with nothing to run.
 * - The Checks page answers for a project of repos that run nothing.
 * - The project-wide Start (/api/workspace/exec) of a project whose repos
 *   all run nothing says so and ends with exit code 0.
 * - Removing the shared repo from north (the project page's remove)
 *   leaves it in south.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { denAuth } from "./helpers/den-auth.js";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let repos = "";
let port = 0;
let server: ChildProcess;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function request(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method,
        timeout: 30_000,
        agent: false,
        headers: {
          ...denAuth(path.join(tmp, "home")),
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
              }
            : {}),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (c: Buffer) => (out += c.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: out }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(data);
  });
}
const getJson = async <T>(p: string): Promise<T> => {
  const r = await request("GET", p);
  expect([p, r.status]).toEqual([p, 200]);
  return JSON.parse(r.body) as T;
};

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  DEN_ROOT: root,
  DEN_ENGINE_ROOT: ENGINE,
  DEN_HOME: path.join(tmp, "home"),
  HOME: path.join(tmp, "home"),
  DEN_NO_OPEN: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
});

const wsFile = () => path.join(root, "config", "local", "workspaces.yml");

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-norun-")));
  root = path.join(tmp, "dist");
  repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    ["shop", "cfg", "rules"].map((n) => `${n}:\n  gh: acme/${n}\n`).join(""),
  );
  const entry = (n: string): string[] => [
    `      ${n}:`,
    "        mode: dev-managed",
    `        path: ${path.join(repos, n)}`,
  ];
  write(
    wsFile(),
    [
      "active: [north, south, quiet]",
      "focus: north",
      "workspaces:",
      "  north:",
      "    services:",
      ...entry("shop"),
      ...entry("cfg"),
      "  south:",
      "    services:",
      ...entry("cfg"),
      ...entry("rules"),
      "  quiet:",
      "    services:",
      ...entry("rules"),
      "",
    ].join("\n"),
  );
  write(
    path.join(repos, "shop", ".den.yml"),
    'name: shop\nservices:\n  shop:\n    commands:\n      local:\n        up: "true"\n',
  );
  write(path.join(repos, "cfg", ".den.yml"), "name: cfg\nservices: {}\n");
  write(
    path.join(repos, "rules", ".den.yml"),
    'name: rules\nservices: []\ntests:\n  unit:\n    cmd: "true"\n',
  );

  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    { cwd: root, env: { ...env(), PORT: String(port) } },
  );
  server = started.server;
  port = started.port;
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Svc = { address: string; health?: string };
type Health = { repo: string; status?: string; health?: string };

describe("a repo that runs nothing, in Den's pages (issue 277)", () => {
  it("the services page shows it with nothing to start (runs: none); the health row has no row for it", async () => {
    const services = await getJson<
      (Svc & { commands: string[]; runs?: string; runsNothing?: boolean })[]
    >("/api/services?refresh=1");
    expect(services.map((s) => s.address).sort()).toEqual([
      "cfg",
      "rules",
      "shop",
    ]);
    for (const s of services.filter((x) => x.address !== "shop"))
      expect(s).toMatchObject({
        commands: [],
        runs: "none",
        runsNothing: true,
      });
    const shop = services.find((s) => s.address === "shop");
    expect(shop?.commands).toContain("up");
    expect(shop?.runsNothing).toBeUndefined();
    const health = await getJson<Health[]>("/api/health?refresh=1");
    expect(health.map((h) => h.repo)).toEqual(["shop"]);
  }, 60_000);

  it("the graph has the repos as nodes, with nothing to run", async () => {
    const graph = await getJson<{ nodes: string[]; edges: unknown[] }>(
      "/api/graph?workspace=south",
    );
    expect([...graph.nodes].sort()).toEqual(["cfg", "rules"]);
    expect(graph.edges).toEqual([]);
    // The graph's cards come from /api/services: nothing to run for them.
    const south = await getJson<(Svc & { commands: string[] })[]>(
      "/api/services?workspace=south",
    );
    expect(south.flatMap((s) => s.commands)).toEqual([]);
  }, 60_000);

  it("the Checks page answers for a project of repos that run nothing", async () => {
    const r = await getJson<{
      ok: boolean;
      envs: { answer: string; counts: { failed: number; error: number } }[];
    }>("/api/verify/overview?project=quiet");
    expect(r.ok).toBe(true);
    for (const e of r.envs) {
      expect(e.counts.failed).toBe(0);
      expect(e.counts.error).toBe(0);
    }
  }, 60_000);

  it("a project whose repos all run nothing: Start says so and ends with exit code 0", async () => {
    const r = await request(
      "GET",
      "/api/workspace/exec?cmd=up&workspace=quiet",
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatch(
      /Nothing to run: no repo in this project has a runtime of its own \(rules\)/,
    );
    expect(r.body).toMatch(/"type":"done","exitCode":0/);
    expect(r.body).not.toMatch(/"type":"error"/);
  }, 60_000);

  it("removing the shared repo from north leaves it in south", async () => {
    const r = await request("DELETE", "/api/workspaces/services", {
      workspace: "north",
      address: "cfg",
    });
    expect([r.status, JSON.parse(r.body)]).toEqual([200, { ok: true }]);
    const ws = parseYaml(fs.readFileSync(wsFile(), "utf-8")) as {
      workspaces: Record<string, { services: Record<string, unknown> }>;
    };
    expect(Object.keys(ws.workspaces.north.services)).toEqual(["shop"]);
    expect(ws.workspaces.south.services.cfg).toEqual({
      mode: "dev-managed",
      path: path.join(repos, "cfg"),
    });
  }, 60_000);
});
