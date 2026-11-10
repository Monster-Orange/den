/**
 * HUB-1.5: every agent Den launches gets Den Hub's MCP server when hub.url
 * is set, with headers naming who calls. The token goes only into the
 * agent's own 0600 MCP file: never argv, a record, a log or the CLI's
 * output. Without Hub, nothing changes.
 *
 * A real host on a temp socket and a scripted PTY. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { readRecord } from "../../../src/shared/agents/records.js";
import { HUB_PROMPT_LINE, HUB_SERVER } from "../../../src/shared/hub.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { hubLines } from "../../../src/ui/cli/doctor-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const TOKEN = "hubi_TESTONLYxyz123secretvalue";
const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const mcpFile = (r: Rig) =>
  path.join(r.stateDir, "agent-files", "planner", "mcp.json");
type Cfg = {
  mcpServers: Record<
    string,
    { type?: string; url?: string; headers?: Record<string, string> }
  >;
};
const cfg = (r: Rig) => JSON.parse(fs.readFileSync(mcpFile(r), "utf-8")) as Cfg;

/** Every file under `dir` but the agent's MCP config. */
function filesBut(dir: string, skip: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesBut(p, skip));
    else if (e.isFile() && p !== skip) out.push(p);
  }
  return out;
}

async function withHub(): Promise<Rig> {
  const r = await rig({
    hub: async () => ({ url: "https://hub.example.test", token: TOKEN }),
    workspaceRepos: (ws) => (ws === "north" ? ["acme/north", "acme/kit"] : []),
  });
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  return r;
}

describe("an agent's MCP config has Den Hub when hub.url is set", () => {
  it("the hub server is Streamable HTTP at <url>/mcp with the bearer token and the caller headers", async () => {
    const r = await withHub();
    const s = cfg(r).mcpServers[HUB_SERVER];
    expect(s).toMatchObject({
      type: "http",
      url: "https://hub.example.test/mcp",
    });
    expect(s.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "X-Den-Workspace": "north",
      "X-Den-Repos": "acme/north,acme/kit",
    });
    expect(s.headers!["X-Den-Agent"]).toBeTruthy();
    expect(s.headers!["X-Den-Session"]).toMatch(/^[0-9a-f-]{36}$/);
    // Den's own server is still there, first.
    expect(Object.keys(cfg(r).mcpServers)[0]).not.toBe(HUB_SERVER);
    // Only the user can read the file that holds the token.
    expect(fs.statSync(mcpFile(r)).mode & 0o077).toBe(0);
  });

  it("the prompt says Hub is there", async () => {
    const r = await withHub();
    expect(r.made[0].args.join(" ")).toContain(HUB_PROMPT_LINE);
  });

  it("the token is never in argv, the env, a record, a state file or the CLI's output", async () => {
    const r = await withHub();
    await settle();
    const p = r.made[0];
    expect(p.args.join(" ")).not.toContain(TOKEN);
    expect(JSON.stringify(p.opts.env ?? {})).not.toContain(TOKEN);
    expect(JSON.stringify(readRecord(r.stateDir, "planner"))).not.toContain(
      TOKEN,
    );
    for (const f of filesBut(r.stateDir, mcpFile(r)))
      expect([f, fs.readFileSync(f, "utf-8").includes(TOKEN)]).toEqual([
        f,
        false,
      ]);
    expect([...r.out, ...r.err].join("\n")).not.toContain(TOKEN);
  });

  it("a resume gets Hub again, with a new session header", async () => {
    const r = await withHub();
    const first = cfg(r).mcpServers[HUB_SERVER].headers!["X-Den-Session"];
    expect(await agents(r, "stop", "planner")).toBe(0);
    r.made[r.made.length - 1].exit(143);
    await settle();
    expect(await agents(r, "resume", "planner")).toBe(0);
    const s = cfg(r).mcpServers[HUB_SERVER];
    expect(s.headers!.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(s.headers!["X-Den-Session"]).not.toBe(first);
  });
});

describe("without Hub, nothing changes", () => {
  it("no hub server and no prompt line", async () => {
    const r = await rig();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(Object.keys(cfg(r).mcpServers)).not.toContain(HUB_SERVER);
    expect(r.made[0].args.join(" ")).not.toContain(HUB_PROMPT_LINE);
  });

  it("a Hub lookup that fails starts the agent without Hub", async () => {
    const r = await rig({
      hub: async () => {
        throw new Error("store locked");
      },
    });
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(Object.keys(cfg(r).mcpServers)).not.toContain(HUB_SERVER);
  });
});

describe("Settings › Hub and doctor", () => {
  async function serve(
    st: Awaited<
      ReturnType<typeof import("../../../src/shared/hub.js").hubStatus>
    >,
  ): Promise<string> {
    const s = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleAgentRoutes(req, res, p, { hubStatus: async () => st });
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "localhost", () => r()));
    return `http://localhost:${(s.address() as AddressInfo).port}/api/hub`;
  }

  it("GET /api/hub answers the status; other methods are refused", async () => {
    const st = {
      configured: true as const,
      url: "https://hub.example.test",
      connected: true,
      team: "Acme",
      label: "north-box",
    };
    const url = await serve(st);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(st);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
  });

  it("doctor: no row without Hub; a down Hub warns and never fails", () => {
    expect(hubLines({ configured: false }, "Acme")).toEqual({
      lines: [],
      problem: false,
    });
    const up = hubLines(
      {
        configured: true,
        url: "https://hub.example.test",
        connected: true,
        team: "Acme",
        label: "north-box",
      },
      "Acme",
    );
    expect(up.lines.join("\n")).toContain(
      "hub  ✓  https://hub.example.test: connected (team Acme, install north-box)",
    );
    expect(up.check?.status).toBe("ok");
    const down = hubLines(
      {
        configured: true,
        url: "https://hub.example.test",
        connected: false,
        problem: "Hub did not answer: 401",
      },
      "Acme",
    );
    expect(down.problem).toBe(false);
    expect(down.check?.status).toBe("warn");
    expect(down.lines.join("\n")).toContain(
      "not connected: Hub did not answer: 401",
    );
  });
});
