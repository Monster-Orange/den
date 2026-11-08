/**
 * The server agent (ON-6): the Den server's own agent, in the reserved
 * server scope, a normal Den agent underneath. A real host on a temp
 * socket, a scripted PTY (nothing really runs) and a `claude` shim that
 * only answers --version. Invented names only (acme, north, south).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  listPersonas,
  resolveAgentsDeps,
  stopAgent,
} from "../../../src/ui/cli/agent-ops.js";
import {
  pickRuntime,
  serverAgentStatus,
  startServerAgent,
  type ServerAgentDeps,
} from "../../../src/ui/cli/server-agent-ops.js";
import {
  SERVER_SCOPE,
  serverAgentDir,
} from "../../../src/shared/agents/server-agent.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { workspaceCreateRefusal } from "../../../src/ui/server/workspace-routes.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const server = (fresh: boolean, saved: { id?: string | null } = {}) =>
  ({
    title: () => "Acme",
    fresh: () => fresh,
    readSetting: () => saved.id ?? undefined,
    saveSetting: (id) => {
      saved.id = id;
    },
  }) satisfies ServerAgentDeps;

const d = (r: Rig) => resolveAgentsDeps(r.deps);

/** The MCP config den-claude was given (its --mcp-config file). */
function mcpOf(r: Rig): { command: string; args: string[] } {
  const p = r.made[r.made.length - 1];
  const file = p.args[p.args.indexOf("--mcp-config") + 1];
  const cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  return Object.values(cfg.mcpServers)[0];
}

describe("the server agent", () => {
  it("starts as agent server, persona server, in no workspace: an empty folder of its own, Den's MCP for the whole Den", async () => {
    const r = await rig();
    const s = await startServerAgent(d(r), {}, server(false));
    expect(s.how).toBe("started");
    const rec = readRecord(r.stateDir, "server")!;
    expect(rec).toMatchObject({
      id: "server",
      persona: "server",
      workspace: SERVER_SCOPE,
      runtime: "den-claude",
      displayName: "Acme agent",
      sessionName: `acme-${SERVER_SCOPE}:server`,
    });
    const p = r.made[0];
    expect(p.opts.cwd).toBe(serverAgentDir(r.stateDir));
    expect(fs.readdirSync(p.opts.cwd!)).toEqual([]);
    const mcp = mcpOf(r);
    expect(mcp.args).toEqual(
      expect.arrayContaining([
        "mcp",
        "--workspace",
        SERVER_SCOPE,
        "--actor",
        "agent:server",
      ]),
    );
    // The persona: Den's server pack, with the plain-writing rule.
    const prompt = p.args[p.args.indexOf("--append-system-prompt") + 1];
    expect(prompt).toMatch(/this Den's own server agent/);
    expect(prompt).toMatch(/You belong to no workspace/);
    expect(prompt).toMatch(/Write plainly\. Use short sentences\./);
    expect(prompt).toMatch(/repos_detect/);
    // Asks before every write: the runtime's own permission prompt too.
    expect(p.args[p.args.indexOf("--permission-mode") + 1]).toBe("default");
    // Not a fresh Den: no onboarding prompt.
    expect(p.args.some((a) => /Where are your repos\?/.test(a))).toBe(false);
    expect(fs.existsSync(r.ran)).toBe(false);
  });

  it("on a fresh Den, its first prompt is the onboarding one", async () => {
    const r = await rig();
    await startServerAgent(d(r), {}, server(true));
    const last = r.made[0].args[r.made[0].args.length - 1];
    expect(last).toMatch(/^Set up Acme with me\. Start with onboard_status/);
    expect(last).toMatch(/Let's set up Acme\. Where are your repos\?/);
  });

  it("is never a workspace's persona, and no workspace may take its scope's name", async () => {
    const r = await rig();
    expect(listPersonas(d(r)).map((p) => p.id)).not.toContain("server");
    expect(workspaceCreateRefusal(SERVER_SCOPE)).toMatch(
      /reserved for the server agent/,
    );
  });

  it("running, a second start leaves it as it is; stopped, it resumes its conversation (AG-14)", async () => {
    const r = await rig();
    const first = await startServerAgent(d(r), {}, server(false));
    const again = await startServerAgent(d(r), {}, server(false));
    expect(again).toMatchObject({ how: "running", sessionId: first.sessionId });
    expect(r.made).toHaveLength(1);
    await stopAgent(d(r), "server", SERVER_SCOPE);
    r.made[0].exit(0);
    await settle();
    const back = await startServerAgent(d(r), {}, server(false));
    expect(back.how).toBe("resumed");
    // The same conversation: its id again (den-claude resumes by it).
    const conv = (a: string[]) => a[a.indexOf("--session-id") + 1];
    expect(conv(r.made[1].args)).toBe(conv(r.made[0].args));
  });

  it("is listed with the sessions under no workspace (server: true)", async () => {
    const r = await rig();
    await startServerAgent(d(r), {}, server(false));
    const c = await connectHost(sessionPaths(r.stateDir).socket);
    const sessions = await c.list();
    c.close();
    const rows = listedSessions(sessions, {
      stateDir: () => r.stateDir,
      dist: () => "acme",
      activeWorkspaces: () => ["north"],
    });
    expect(rows).toEqual([
      expect.objectContaining({
        agent: "server",
        workspace: SERVER_SCOPE,
        server: true,
        displayName: "Acme agent",
      }),
    ]);
  });

  it("with no runtime that can run it: no runtime, and the manual path", async () => {
    const r = await rig();
    fs.rmSync(r.claude);
    const st = await serverAgentStatus(d(r), server(true));
    expect(st).toMatchObject({
      name: "Acme agent",
      fresh: true,
      runtime: null,
      state: "none",
      manual: [
        "npm i -g @monster-orange/den",
        "den create <name>",
        "acme repo add <path>",
        "acme up",
      ],
    });
    expect(st.runtimes.find((x) => x.id === "den-claude")).toMatchObject({
      available: false,
      usable: false,
      install: "npm i -g @anthropic-ai/claude-code",
    });
    await expect(startServerAgent(d(r), {}, server(true))).rejects.toThrow(
      /no runtime can run the server agent/,
    );
    expect(r.made).toHaveLength(0);
  });

  it("runs on the person's choice when it can, else the first that can", () => {
    const row = (id: string, available: boolean, denTools = true) => ({
      id,
      available,
      denTools,
      resume: true,
      default: false,
      models: [],
    });
    const rows = [row("a", true), row("b", true), row("c", true, false)];
    expect(pickRuntime(rows, "b")?.id).toBe("b");
    expect(pickRuntime(rows, "c")?.id).toBe("a");
    expect(pickRuntime(rows, undefined)?.id).toBe("a");
    expect(pickRuntime([row("x", false)], undefined)).toBeNull();
  });
});

describe("its folder", () => {
  it("is under the state dir, the person's alone", async () => {
    const r = await rig();
    const dir = serverAgentDir(r.stateDir);
    expect(dir).toBe(path.join(r.stateDir, "server-agent"));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});
