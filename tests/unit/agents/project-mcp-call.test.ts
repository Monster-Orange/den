/**
 * Issue 335, end to end: the headersHelper Den writes for a project's
 * extra MCP server is run as Claude Code runs it (a shell, the agent's own
 * env), through the real CLI (`<cli> mcp headers <name>`), and its header
 * goes on a call to a local HTTP stub. The bearer reaches the stub's
 * Authorization header, read at call time (a rotation is picked up on the
 * next call), and appears in no file, env or log.
 *
 * Issue 473: the helper never reads a store, nor its own env: it asks Den's
 * server, with the agent's token. Here that is a stand-in on a free port
 * (web.port): the real route (project-mcp-routes.ts), the agent proven
 * from its token as the request guard does, and a fake store (a file in a
 * temp dir) the server side reads. Never port 7777. Invented values only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { verifyActorToken } from "../../../src/shared/actor-token.js";
import { parseProjectMcpServers } from "../../../src/shared/agents/project-mcp.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleProjectMcpRoutes } from "../../../src/ui/server/project-mcp-routes.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const FIRST = "trk_TESTONLY_first_4c1d2e";
const SECOND = "trk_TESTONLY_rotated_8a7b6c";

const servers_: http.Server[] = [];
afterEach(async () => {
  for (const s of servers_.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

/** A stub MCP endpoint: it keeps each call's Authorization header. */
async function stub(): Promise<{ url: string; seen: (string | undefined)[] }> {
  const seen: (string | undefined)[] = [];
  const s = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
  servers_.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`,
    seen,
  };
}

function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesIn(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * Issue 473: Den's server, standing in: the mcp-headers route, its agent
 * proven from the bearer token (verifyActorToken on the rig's state), the
 * bearer read from the fake store's file at each call.
 */
async function denStandIn(
  stateDir: string,
  servers: () => unknown,
  secretFile: string,
): Promise<number> {
  const s = http.createServer((req, res) => {
    const t = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    const rec = t ? verifyActorToken(stateDir, t) : null;
    setPrincipal(req, rec ? { kind: "agent", ...rec } : null);
    const p = new URL(req.url ?? "/", "http://x").pathname;
    void handleProjectMcpRoutes(req, res, p, {
      projects: () => ["north", "south"],
      servers: (ws) =>
        ws === "north" ? parseProjectMcpServers(servers()).servers : [],
      secret: async () => fs.readFileSync(secretFile, "utf-8"),
    }).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  servers_.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}

/**
 * A rig whose agents' CLI is the real one, on a temp distribution: its
 * secrets backend is env, and secrets.refs.tracker_token names
 * TRACKER_TOKEN. Only the stand-in Den reads the fake store; the CLI's
 * shim (the agent's side) has no bearer in its env.
 */
async function realCli(stubUrl: string) {
  const r = await rig();
  const r0 = r;
  const dist = path.join(r0.dir, "dist");
  const store = path.join(r0.dir, "store");
  fs.mkdirSync(path.join(dist, "config", "local"), { recursive: true });
  fs.mkdirSync(store, { mode: 0o700 });
  fs.writeFileSync(path.join(dist, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(dist, "config", "den.yml"),
    [
      "environments: [local]",
      "github_org: acme",
      "secrets:",
      "  provider: env",
      "  refs:",
      "    tracker_token: { key: TRACKER_TOKEN }",
      "",
    ].join("\n"),
  );
  const servers = [{ name: "tracker", url: stubUrl, bearer: "tracker_token" }];
  fs.writeFileSync(
    path.join(dist, "config", "local", "workspaces.yml"),
    JSON.stringify({
      workspaces: {
        north: { services: {}, agents: { mcp_servers: servers } },
        south: { services: {} },
      },
    }),
  );
  const secretFile = path.join(store, "tracker_token");
  fs.writeFileSync(secretFile, FIRST, { mode: 0o600 });
  const port = await denStandIn(r0.stateDir, () => servers, secretFile);
  fs.appendFileSync(
    path.join(dist, "config", "den.yml"),
    `web:\n  port: ${port}\n`,
  );
  const shim = path.join(r0.dir, "bin", "acme-cli");
  fs.writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `exec '${TSX}' '${path.join(ENGINE, "src", "ui", "cli", "index.ts")}' "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  Object.assign(r.deps, {
    workspaceMcpServers: (ws: string) => (ws === "north" ? servers : undefined),
    mcpServer: () => ({
      command: shim,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        DEN_ROOT: dist,
        DEN_HOME: r0.stateDir,
        DEN_DAEMONS_FILE: path.join(r0.dir, "daemons.json"),
        CI: "1",
      },
    }),
  });
  return { r, secretFile, dist };
}

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const helperOf = (r: Rig, id: string): string =>
  (
    JSON.parse(
      fs.readFileSync(
        path.join(r.stateDir, "agent-files", id, "mcp.json"),
        "utf-8",
      ),
    ) as { mcpServers: Record<string, { headersHelper?: string }> }
  ).mcpServers.tracker?.headersHelper ?? "";

/**
 * The helper as Claude Code runs it: a shell, with the agent's own env.
 * Async: the stand-in Den answers from this process's event loop.
 */
const runHelper = (
  helper: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const c = spawn("/bin/sh", ["-c", helper], {
      env: env as NodeJS.ProcessEnv,
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += String(d)));
    c.stderr.on("data", (d) => (stderr += String(d)));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });

describe("issue 335: the bearer reaches the server at call time", () => {
  it("the helper's header goes on the call; a rotated secret is on the next one; no file, env or log holds it", async () => {
    const s = await stub();
    const { r, secretFile } = await realCli(s.url);
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(
      await agents(r, "start", "-w", "south", "--persona", "reviewer"),
    ).toBe(0);
    const helper = helperOf(r, "planner");
    expect(helper).not.toBe("");
    const env = r.made[0].opts.env as NodeJS.ProcessEnv;

    const call = async () => {
      const h = await runHelper(helper, env);
      expect([h.status, h.stderr]).toEqual([0, ""]);
      const headers = JSON.parse(h.stdout) as Record<string, string>;
      await fetch(s.url, { method: "POST", headers, body: "{}" });
      return h;
    };
    const one = await call();
    fs.writeFileSync(secretFile, SECOND);
    const two = await call();
    expect(s.seen).toEqual([`Bearer ${FIRST}`, `Bearer ${SECOND}`]);

    // Project B's agent, running A's helper: refused, with no bearer.
    const b = await runHelper(helper, r.made[1].opts.env as NodeJS.ProcessEnv);
    expect(b.status).toBe(1);
    expect(b.stderr).toContain('project south has no MCP server "tracker"');

    await settle();
    const leaks = (t: string) => t.includes(FIRST) || t.includes(SECOND);
    // Only the helper's stdout (Claude Code's) ever carries it.
    expect(leaks(one.stderr + two.stderr + b.stdout + b.stderr)).toBe(false);
    expect(leaks(helper)).toBe(false);
    for (const p of r.made) {
      expect(leaks(p.args.join(" "))).toBe(false);
      expect(leaks(JSON.stringify(p.opts.env ?? {}))).toBe(false);
    }
    for (const f of filesIn(r.stateDir))
      expect([f, leaks(fs.readFileSync(f, "utf-8"))]).toEqual([f, false]);
    expect(leaks([...r.out, ...r.err].join("\n"))).toBe(false);
  }, 120_000);
});
