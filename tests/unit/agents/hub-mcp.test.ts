/**
 * HUB-1.5: every agent Den launches gets Den Hub's MCP server when hub.url
 * is set. D52: through Den's proxy, with the agent's own Den token; Den
 * says who calls. The install's Hub token is nowhere the agent can read:
 * not argv, its env, its files (its MCP config included), a record, a log
 * or the CLI's output. Without Hub, nothing changes.
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
import { DEN_BASE, cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

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

/** Every file under `dir`. */
function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesIn(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
/** D52: what every agent's Hub server is. */
const PROXY = {
  type: "http",
  url: `${DEN_BASE}/hub/mcp`,
  headers: { Authorization: "Bearer ${DEN_ACTOR_TOKEN}" },
};

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
  it("D52: the hub server is Streamable HTTP at Den's proxy, with the agent's own Den token (from its env) and nothing else", async () => {
    const r = await withHub();
    // Exactly: no Hub token, no X-Den-* (Den's proxy sets those).
    expect(cfg(r).mcpServers[HUB_SERVER]).toEqual(PROXY);
    // The session has the token the header names (SEC-1c's).
    expect(r.made[0].opts.env?.DEN_ACTOR_TOKEN).toMatch(/^den_at_/);
    // Den's own server is still there, first.
    expect(Object.keys(cfg(r).mcpServers)[0]).not.toBe(HUB_SERVER);
    expect(fs.statSync(mcpFile(r)).mode & 0o077).toBe(0);
  });

  it("the prompt says Hub is there", async () => {
    const r = await withHub();
    expect(r.made[0].args.join(" ")).toContain(HUB_PROMPT_LINE);
  });

  it("D52: the Hub token is never in argv, the env, a record, any file under Den's state (the agent's MCP config too) or the CLI's output", async () => {
    const r = await withHub();
    await settle();
    const p = r.made[0];
    expect(p.args.join(" ")).not.toContain(TOKEN);
    expect(JSON.stringify(p.opts.env ?? {})).not.toContain(TOKEN);
    expect(JSON.stringify(readRecord(r.stateDir, "planner"))).not.toContain(
      TOKEN,
    );
    expect(filesIn(r.stateDir)).toContain(mcpFile(r));
    for (const f of filesIn(r.stateDir))
      expect([f, fs.readFileSync(f, "utf-8").includes(TOKEN)]).toEqual([
        f,
        false,
      ]);
    expect([...r.out, ...r.err].join("\n")).not.toContain(TOKEN);
  });

  it("a resume gets Hub again, through Den, with the new session's token", async () => {
    const r = await withHub();
    const first = r.made[0].opts.env?.DEN_ACTOR_TOKEN;
    expect(await agents(r, "stop", "planner")).toBe(0);
    r.made[r.made.length - 1].exit(143);
    await settle();
    expect(await agents(r, "resume", "planner")).toBe(0);
    expect(cfg(r).mcpServers[HUB_SERVER]).toEqual(PROXY);
    const now = r.made[r.made.length - 1].opts.env?.DEN_ACTOR_TOKEN;
    expect(now).toMatch(/^den_at_/);
    expect(now).not.toBe(first);
  });

  it("HUB-1.7: with Hub's own mcp_url, the agent still calls Den (Den's proxy goes there)", async () => {
    const r = await rig({
      hub: async () => ({
        url: "https://hub.example.test",
        mcpUrl: "https://mcp.hub.example.test/t/acme",
        token: TOKEN,
      }),
      workspaceRepos: () => [],
    });
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(cfg(r).mcpServers[HUB_SERVER]).toEqual(PROXY);
  });
});

describe("hub.allow_tools", () => {
  const rules = (r: Rig) =>
    (
      JSON.parse(
        fs.readFileSync(
          path.join(r.stateDir, "agent-files", "planner", "settings.json"),
          "utf-8",
        ),
      ) as { permissions?: { allow?: string[] } }
    ).permissions?.allow ?? [];

  it("on (the default): Hub's tools are allowed, so they never ask", async () => {
    const r = await withHub();
    expect(rules(r)).toEqual(
      expect.arrayContaining([`mcp__${HUB_SERVER}`, `mcp__${HUB_SERVER}__*`]),
    );
  });

  it("off: no Hub allow rule, so they ask like any tool", async () => {
    const r = await rig({
      hub: async () => ({
        url: "https://hub.example.test",
        token: TOKEN,
        allowTools: false,
      }),
    });
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(cfg(r).mcpServers[HUB_SERVER]).toBeTruthy();
    expect(rules(r).some((x) => x.startsWith(`mcp__${HUB_SERVER}`))).toBe(
      false,
    );
  });
});

describe("hub.inbox_on_stop (D41)", () => {
  const stop = (r: Rig) =>
    (
      JSON.parse(
        fs.readFileSync(
          path.join(r.stateDir, "agent-files", "planner", "settings.json"),
          "utf-8",
        ),
      ) as { hooks: { Stop: { hooks: { command: string }[] }[] } }
    ).hooks.Stop[0].hooks[0].command;

  it("nudge (the default): the Stop hook asks Den's proxy to Hub, with no token", async () => {
    const r = await withHub();
    expect(stop(r)).toContain(`--hub-inbox ${DEN_BASE}/hub`);
    expect(stop(r)).not.toContain("hub.example.test");
    expect(stop(r)).not.toContain(TOKEN);
  });

  it("off: the Stop hook never asks Hub", async () => {
    const r = await rig({
      hub: async () => ({
        url: "https://hub.example.test",
        token: TOKEN,
        inboxOnStop: "off",
      }),
    });
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(stop(r)).not.toContain("--hub-inbox");
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

  it("the rail's look (?rail=1) leaves Connect's one-time result for Settings", async () => {
    const st = { configured: false as const };
    let last: { ok: boolean; message: string } | null = {
      ok: true,
      message: "Connected to Hub (Acme).",
    };
    const hubConnect = {
      lastResult: () => {
        const l = last;
        last = null;
        return l;
      },
    } as unknown as import("../../../src/ui/server/hub-connect.js").HubConnect;
    const s = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleAgentRoutes(req, res, p, {
        hubStatus: async () => st,
        hubConnect,
      });
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "localhost", () => r()));
    const url = `http://localhost:${(s.address() as AddressInfo).port}/api/hub`;
    expect(await (await fetch(`${url}?rail=1`)).json()).toEqual(st);
    expect(await (await fetch(url)).json()).toEqual({
      ...st,
      connect: { ok: true, message: "Connected to Hub (Acme)." },
    });
    expect(await (await fetch(url)).json()).toEqual(st);
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
        role: "member",
      },
      "Acme",
    );
    expect(up.lines.join("\n")).toContain(
      "hub  ✓  https://hub.example.test: connected (company Acme, install north-box, role member)",
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
    const revoked = hubLines(
      {
        configured: true,
        url: "https://hub.example.test",
        connected: false,
        state: "rejected",
        problem: "Hub doesn't accept this install's token",
      },
      "Acme",
    );
    expect(revoked.check?.detail).toMatch(
      /Settings › Agents › Hub: Reconnect\)$/,
    );
  });
});
