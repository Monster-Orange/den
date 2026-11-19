/**
 * Issue 473: a project MCP server's bearer comes from the install, not the
 * agent's own process. The headers helper (`<cli> mcp headers <name>`,
 * run by the agent's MCP client at each connect) asks the running Den
 * server, proving itself with the agent's token; the server reads its own
 * secrets store. With secrets.provider env, the bearer is in the server's
 * env only, never the agent's.
 *
 * The real web server on the demo distribution, the scripted PTY, the real
 * helper command from the agent's --mcp-config. Invented names and a
 * test-only value; the env provider only (no keychain, op or doppler).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

const BEARER = "trk_TESTONLY_bearer_473_5c4b3a2918";
const KEY = "TRACKER_TOKEN_TESTONLY_473";
const SERVER = {
  name: "tracker",
  url: "https://mcp.tracker.example.test",
  bearer: "tracker_token",
};

let s: AgentsPageServer;

beforeAll(async () => {
  s = await startAgentsPageServer({
    userYml: [
      "secrets:",
      "  provider: env",
      "  refs:",
      `    tracker_token: { key: ${KEY} }`,
      "    wiki_token: { key: WIKI_TOKEN_TESTONLY_473 }",
      "",
    ].join("\n"),
    // wiki's ref names a key the server's env doesn't have.
    mcpServers: {
      north: [
        SERVER,
        {
          name: "wiki",
          url: "https://wiki.example.test",
          bearer: "wiki_token",
        },
      ],
    },
    // The bearer is in the server's own env, and nowhere else.
    serverEnv: { [KEY]: BEARER },
  });
  // The helper finds the server as `<cli> mcp` does: web.port.
  const user = path.join(s.tmp, "dist", "config", "local", "user.yml");
  const doc = (parseYaml(fs.readFileSync(user, "utf-8")) ?? {}) as {
    web?: Record<string, unknown>;
  };
  doc.web = { ...doc.web, port: s.port };
  fs.writeFileSync(user, stringifyYaml(doc));
  // The distribution's bin/acme runs Den from its node_modules: this one.
  const pkg = path.join(s.tmp, "dist", "node_modules", "@monster-orange");
  fs.mkdirSync(pkg, { recursive: true });
  fs.symlinkSync(path.resolve(__dirname, "../../.."), path.join(pkg, "den"));
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

async function startAgent(ws: string, persona: string) {
  const r = await fetch(`${s.base}/api/workspaces/${ws}/agents`, {
    method: "POST",
    headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
    body: JSON.stringify({ persona }),
  });
  if (r.status !== 200) throw new Error(`start: ${r.status} ${await r.text()}`);
  const pty = s.made.at(-1)!;
  return { env: pty.opts.env as NodeJS.ProcessEnv, id: persona };
}

function helperOf(id: string): string {
  const cfg = JSON.parse(
    fs.readFileSync(
      path.join(s.stateDir, "agent-files", id, "mcp.json"),
      "utf-8",
    ),
  ) as { mcpServers: Record<string, { headersHelper?: string }> };
  const h = cfg.mcpServers.tracker?.headersHelper;
  expect(h).toBeTruthy();
  return h!;
}

/** The helper as the agent's MCP client runs it: a shell, the agent's env. */
function runHelper(cmd: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync("/bin/sh", ["-c", cmd], {
    env,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("issue 473: the headers helper asks the running Den server", () => {
  let north: { env: NodeJS.ProcessEnv; id: string };
  let southEnv: NodeJS.ProcessEnv = {};

  it("env provider, the bearer only in the server's env: the helper prints the header", async () => {
    north = await startAgent("north", "planner");
    const r = runHelper(helperOf(north.id), north.env);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(r.out)).toEqual({ Authorization: `Bearer ${BEARER}` });
  }, 90_000);

  it("the env the agent's session is launched with never holds the bearer", () => {
    expect(JSON.stringify(north.env)).not.toContain(BEARER);
    expect(north.env[KEY]).toBeUndefined();
    // Nor the helper command, nor the MCP file.
    expect(helperOf(north.id)).not.toContain(BEARER);
    expect(
      fs.readFileSync(
        path.join(s.stateDir, "agent-files", north.id, "mcp.json"),
        "utf-8",
      ),
    ).not.toContain(BEARER);
  });

  it("a token for project B can't get project A's server's header", async () => {
    const south = await startAgent("south", "reviewer");
    southEnv = south.env;
    // North's helper command, south's token.
    const r = runHelper(helperOf(north.id), south.env);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain('project south has no MCP server "tracker"');
    expect(r.err).not.toContain(BEARER);
    // The route takes the project from the token, never the body.
    const t = actorTokenOf(south.env);
    const direct = await fetch(`${s.base}/api/agents/self/mcp-headers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${t}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "tracker", project: "north" }),
    });
    expect(direct.status).toBe(400);
    expect(await direct.text()).not.toContain(BEARER);
    // A person's token is no agent's: nothing.
    const person = await fetch(`${s.base}/api/agents/self/mcp-headers`, {
      method: "POST",
      headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
      body: JSON.stringify({ name: "tracker" }),
    });
    expect(person.status).toBe(403);
    expect(await person.text()).not.toContain(BEARER);
  }, 90_000);

  it("Den not running: a clear failure, and never the agent's own env", async () => {
    await s.webDown();
    try {
      // Even with the value in the agent's env, the helper won't read it.
      const r = runHelper(helperOf(north.id), { ...north.env, [KEY]: BEARER });
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/Den isn't running/);
      expect(r.err).not.toContain(BEARER);
    } finally {
      await s.webUp();
    }
  }, 120_000);

  it("doctor's check: the server says which bearers it can't serve, and why, never a value", async () => {
    const r = await fetch(`${s.base}/api/mcp-servers/bearers`, {
      headers: denAuth(s.stateDir),
    });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).not.toContain(BEARER);
    expect(JSON.parse(text).servers).toEqual([
      { project: "north", name: "tracker", served: true },
      {
        project: "north",
        name: "wiki",
        served: false,
        why: "secrets.refs.wiki_token can't be read: Secret WIKI_TOKEN_TESTONLY_473 is not set in the environment",
      },
    ]);
    // An agent's token sees its own project's only.
    const south = await fetch(`${s.base}/api/mcp-servers/bearers`, {
      headers: { authorization: `Bearer ${actorTokenOf(southEnv)}` },
    });
    expect(((await south.json()) as { servers: unknown[] }).servers).toEqual(
      [],
    );
  });

  it("a bearer the server can't read: the helper fails clearly, with no value", () => {
    const helper = helperOf(north.id).replace(/ '?tracker'?$/, " wiki");
    const r = runHelper(helper, { ...north.env, [KEY]: BEARER });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("secrets.refs.wiki_token can't be read");
    expect(r.err).not.toContain(BEARER);
  }, 60_000);

  it("the value never reaches the server's log", () => {
    expect(s.log()).not.toContain(BEARER);
  });
});
