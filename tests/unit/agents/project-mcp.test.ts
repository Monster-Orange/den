/**
 * Issue 335: a project's extra HTTP MCP servers (agents.mcp_servers) reach
 * that project's agents only, as Hub's entry does: an HTTP entry whose
 * headersHelper reads the bearer from the install's store at each connect.
 * The bearer (a secrets.refs name in config) is never in the MCP file, the
 * agent's env, a record or the CLI's output.
 *
 * A real host on a temp socket and a scripted PTY; a fake secrets store
 * (files in a temp dir). Invented names and values only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readRecord } from "../../../src/shared/agents/records.js";
import {
  parseProjectMcpServers,
  projectMcpHeaders,
} from "../../../src/shared/agents/project-mcp.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const BEARER = "trk_TESTONLY_bearer_value_9f8e7d";
const URL_A = "https://mcp.tracker.example.test";
const CONFIG: Record<string, unknown> = {
  north: [{ name: "tracker", url: URL_A, bearer: "tracker_token" }],
};

const stores: string[] = [];
afterEach(async () => {
  for (const d of stores.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
  await cleanupRigs();
});

/** A fake secrets store: one file per secrets.refs name, in a temp dir. */
function fakeStore(values: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-fake-store-"));
  stores.push(dir);
  for (const [k, v] of Object.entries(values))
    fs.writeFileSync(path.join(dir, k), v, { mode: 0o600 });
  return {
    dir,
    secret: async (ref: string) => {
      try {
        return fs.readFileSync(path.join(dir, ref), "utf-8");
      } catch {
        throw new Error(`no secret ${ref}`);
      }
    },
  };
}

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
type Cfg = {
  mcpServers: Record<
    string,
    { type?: string; url?: string; headersHelper?: string }
  >;
};
const cfgOf = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(
      path.join(r.stateDir, "agent-files", id, "mcp.json"),
      "utf-8",
    ),
  ) as Cfg;

function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesIn(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function twoProjects(): Promise<Rig> {
  const r = await rig({ workspaceMcpServers: (ws) => CONFIG[ws] });
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  expect(await agents(r, "start", "-w", "south", "--persona", "reviewer")).toBe(
    0,
  );
  return r;
}

describe("issue 335: a project's extra MCP server in its agents' --mcp-config", () => {
  it("an agent in project A gets the server; an agent in project B doesn't", async () => {
    const r = await twoProjects();
    const a = cfgOf(r, "planner").mcpServers.tracker;
    expect(a).toMatchObject({ type: "http", url: URL_A });
    expect(a.headersHelper).toMatch(/ mcp headers tracker$/);
    expect(Object.keys(cfgOf(r, "reviewer").mcpServers)).not.toContain(
      "tracker",
    );
    // Den's own server is still first.
    expect(Object.keys(cfgOf(r, "planner").mcpServers)[0]).toBe("acme");
  });

  it("the written config, the env, the record and the output hold no token value", async () => {
    const r = await twoProjects();
    await settle();
    for (const f of filesIn(r.stateDir))
      expect([f, fs.readFileSync(f, "utf-8").includes(BEARER)]).toEqual([
        f,
        false,
      ]);
    for (const p of r.made) {
      expect(p.args.join(" ")).not.toContain(BEARER);
      expect(JSON.stringify(p.opts.env ?? {})).not.toContain(BEARER);
      expect(JSON.stringify(p.opts.env ?? {})).not.toContain("tracker_token");
    }
    expect(JSON.stringify(readRecord(r.stateDir, "planner"))).not.toContain(
      BEARER,
    );
    expect([...r.out, ...r.err].join("\n")).not.toContain(BEARER);
  });

  it("the headers helper's output carries the bearer, for the agent's own project only", async () => {
    const r = await twoProjects();
    const store = fakeStore({ tracker_token: `${BEARER}\n` });
    const deps = (env: NodeJS.ProcessEnv | undefined) => ({
      env: env ?? {},
      stateDir: r.stateDir,
      servers: (ws: string) => parseProjectMcpServers(CONFIG[ws]).servers,
      secret: store.secret,
    });
    const a = await projectMcpHeaders(
      "tracker",
      deps(r.made[0].opts.env as NodeJS.ProcessEnv),
    );
    expect(a.ok && JSON.parse(a.json)).toEqual({
      Authorization: `Bearer ${BEARER}`,
    });
    // Project B's agent can't name A's server: its token says south.
    const b = await projectMcpHeaders(
      "tracker",
      deps(r.made[1].opts.env as NodeJS.ProcessEnv),
    );
    expect(b).toEqual({
      ok: false,
      error: 'project south has no MCP server "tracker"',
    });
    // Not an agent: nothing.
    const none = await projectMcpHeaders("tracker", deps({}));
    expect(none.ok).toBe(false);
    expect(JSON.stringify(none)).not.toContain(BEARER);
  });

  it("a store error never carries a secret-shaped value into the helper's stderr", async () => {
    const r = await twoProjects();
    const a = await projectMcpHeaders("tracker", {
      env: r.made[0].opts.env as NodeJS.ProcessEnv,
      stateDir: r.stateDir,
      servers: (ws: string) => parseProjectMcpServers(CONFIG[ws]).servers,
      secret: async () => {
        throw new Error(`store said: Authorization: Bearer ${BEARER}`);
      },
    });
    expect(a.ok).toBe(false);
    expect(JSON.stringify(a)).not.toContain(BEARER);
    expect(JSON.stringify(a)).toContain("secrets.refs.tracker_token");
  });

  it("a server without a bearer has no headers helper; a bad entry and Den's own names are left out", async () => {
    const r = await rig({
      workspaceMcpServers: () => [
        { name: "open", url: "http://localhost:4999/mcp" },
        { name: "acme", url: URL_A },
        { name: "plain", url: "http://tracker.example.test/mcp" },
        { name: "leak", url: URL_A, bearer: "x y z = a value" },
      ],
    });
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    const servers = cfgOf(r, "planner").mcpServers;
    expect(servers.open).toEqual({
      type: "http",
      url: "http://localhost:4999/mcp",
    });
    expect(servers.acme.type).toBeUndefined();
    expect(Object.keys(servers)).not.toContain("plain");
    expect(Object.keys(servers)).not.toContain("leak");
  });
});
