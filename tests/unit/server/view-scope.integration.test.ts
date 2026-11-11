/**
 * The view scope (0.3.0-dev.16): one source for "which repos are in view",
 * read by the health row, the pages' /api/services and `<cli> status`.
 *
 * Three active workspaces, focus ws-a; shop is in ws-a and ws-b (one
 * checkout), billing only in ws-b, search only in ws-c. Default scope "all":
 * every active workspace, shop listed once with both owners. Scope ws-b:
 * shop and billing only, and the focus stays ws-a. Real server and CLI,
 * throwaway distribution.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
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
        timeout: 15_000,
        agent: false,
        headers: {
          // SEC-1a: a mutation carries the CLI's credential.
          ...(method === "GET" ? {} : denAuth(path.join(tmp, "home"))),
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
const getJson = async <T>(p: string): Promise<T> =>
  JSON.parse((await request("GET", p)).body) as T;

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

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-scope-")));
  root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    ["shop", "billing", "search"]
      .map((n) => `${n}:\n  gh: acme/${n}\n`)
      .join(""),
  );
  const entry = (n: string): string[] => [
    `      ${n}:`,
    "        mode: dev-managed",
    `        path: ${path.join(repos, n)}`,
  ];
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [ws-a, ws-b, ws-c]",
      "focus: ws-a",
      "workspaces:",
      "  ws-a:",
      "    services:",
      ...entry("shop"),
      "  ws-b:",
      "    services:",
      ...entry("shop"),
      ...entry("billing"),
      "  ws-c:",
      "    services:",
      ...entry("search"),
      "",
    ].join("\n"),
  );
  for (const n of ["shop", "billing", "search"])
    write(
      path.join(repos, n, ".den.yml"),
      `name: ${n}\nservices:\n  api:\n    commands:\n      local:\n        up: "true"\n`,
    );

  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: { ...env(), PORT: String(port) },
    },
  );
  server = started.server;
  port = started.port;
}, 30_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Svc = { address: string; inWorkspaces?: string[] };
type Health = { repo: string; workspaces?: string[]; inView?: boolean };
const byAddr = <T extends { address: string }>(rows: T[]) =>
  Object.fromEntries(rows.map((r) => [r.address, r]));

describe("the view scope", () => {
  it("defaults to every active workspace, a shared service listed once with its owners", async () => {
    const services = await getJson<Svc[]>("/api/services?refresh=1");
    expect(services.map((s) => s.address).sort()).toEqual([
      "billing",
      "search",
      "shop",
    ]);
    const s = byAddr(services);
    expect(s["shop"].inWorkspaces).toEqual(["ws-a", "ws-b"]);
    expect(s["billing"].inWorkspaces).toEqual(["ws-b"]);

    // The health row covers the same repos, with the same owners.
    const health = await getJson<Health[]>("/api/health?refresh=1");
    expect(health.map((h) => h.repo).sort()).toEqual([
      "billing",
      "search",
      "shop",
    ]);
    expect(health.find((h) => h.repo === "shop")?.workspaces).toEqual([
      "ws-a",
      "ws-b",
    ]);
    // One source: the view says what the lists above hold.
    expect(await getJson("/api/scope")).toEqual({
      scope: "all",
      fellBack: false,
      inView: ["ws-a", "ws-b", "ws-c"],
      focus: "ws-a",
    });
  }, 20_000);

  it("`status` shows the same view, the scope line and the owners", () => {
    const r = spawnSync(
      path.join(ENGINE, "node_modules", ".bin", "tsx"),
      [path.join(ENGINE, "src", "ui", "cli", "index.ts"), "status"],
      { cwd: root, env: env(), encoding: "utf-8", timeout: 30_000 },
    );
    const out = r.stdout + r.stderr;
    expect(out).toContain("Scope: all active (ws-a, ws-b, ws-c) · focus: ws-a");
    expect(out).toMatch(/shop\S* · ws-a, ws-b/);
    expect(out).toContain("billing");
    expect(out).toContain("search");

    const one = spawnSync(
      path.join(ENGINE, "node_modules", ".bin", "tsx"),
      [
        path.join(ENGINE, "src", "ui", "cli", "index.ts"),
        "status",
        "--scope",
        "ws-c",
      ],
      { cwd: root, env: env(), encoding: "utf-8", timeout: 30_000 },
    );
    const oneOut = one.stdout + one.stderr;
    expect(oneOut).toContain("Scope: ws-c · focus: ws-a");
    expect(oneOut).toContain("search");
    expect(oneOut).not.toContain("billing");
  }, 60_000);

  it("one workspace in view: its repos only, and the focus is unchanged", async () => {
    const r = await request("POST", "/api/scope", { scope: "ws-b" });
    expect([r.status, JSON.parse(r.body)]).toEqual([
      200,
      { scope: "ws-b", fellBack: false, inView: ["ws-b"], focus: "ws-a" },
    ]);
    const services = await getJson<Svc[]>("/api/services");
    expect(services.map((s) => s.address).sort()).toEqual(["billing", "shop"]);
    // WS-6.4: health still covers every active workspace (search is
    // ws-c's); the scope marks what is in view, for the chip to count.
    const health = await getJson<Health[]>("/api/health");
    expect(health.map((h) => h.repo).sort()).toEqual([
      "billing",
      "search",
      "shop",
    ]);
    expect(
      health
        .filter((h) => h.inView)
        .map((h) => h.repo)
        .sort(),
    ).toEqual(["billing", "shop"]);
    const ws = await getJson<{ focus: string; active: string[] }>(
      "/api/workspaces",
    );
    expect([ws.focus, ws.active]).toEqual(["ws-a", ["ws-a", "ws-b", "ws-c"]]);

    // Back to all: no `view` block left behind.
    expect((await request("POST", "/api/scope", { scope: "all" })).status).toBe(
      200,
    );
    const userYml = path.join(root, "config", "local", "user.yml");
    expect(
      fs.existsSync(userYml) ? fs.readFileSync(userYml, "utf-8") : "",
    ).not.toContain("view");
    expect((await getJson<Svc[]>("/api/services")).length).toBe(3);
  }, 20_000);

  it("refuses a workspace that is not active", async () => {
    for (const scope of ["ws-z", "", 3, "../x"]) {
      const r = await request("POST", "/api/scope", { scope });
      expect([scope, r.status]).toEqual([scope, 400]);
    }
  });
});
