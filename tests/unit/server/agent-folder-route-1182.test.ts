/**
 * Issue 1182: `agents folder` goes through the server.
 *
 *   POST /api/workspaces/:ws/agents/:id/folder  { repo } | { folder }: a
 *       stopped agent's folder, a person's (an agent asks with the held
 *       write agent_folder)
 *
 * The CLI sends it there with the person token. A refusal changes nothing;
 * with no server listening the CLI changes the record as before.
 *
 * Invented names.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import { agentRefusal } from "../../../src/ui/server/request-guard.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import type {
  PersonServer,
  ServerAnswer,
} from "../../../src/ui/cli/person-server.js";
import { cleanupRigs, rig, type Rig } from "../agents/helpers/rig.js";
import { seedScout } from "../agents/helpers/seed-helpers.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const FOLDER = "/api/workspaces/north/agents/scout/folder";

/** A rig with a stopped scout in project north, and a folder to move to. */
async function stopped(): Promise<{
  r: Rig;
  file: string;
  to: string;
  record: () => Record<string, unknown>;
}> {
  const r = await rig();
  const home = path.join(r.dir, "home");
  r.deps.env = { ...r.deps.env, HOME: home };
  seedScout(r.stateDir, r.wsDir("north"), home);
  const file = path.join(r.stateDir, "agents", "scout.json");
  const rec = JSON.parse(fs.readFileSync(file, "utf-8"));
  writeRecord(r.stateDir, { ...rec, stoppedAt: "2026-11-01T10:00:00.000Z" });
  const to = path.join(r.wsDir("north"), "notes");
  fs.mkdirSync(to, { recursive: true });
  const record = () =>
    JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  return { r, file, to, record };
}

async function api(r: Rig) {
  const server = http.createServer((req, res) => {
    jsonApiErrors(res, newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleAgentRoutes(req, res, p, { agents: r.deps }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const port = (server.address() as AddressInfo).port;
  return async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://localhost:${port}${FOLDER}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
}

const AGENT_HEADERS = {
  "x-den-actor": "agent",
  "x-den-mcp-client": "jest",
  "x-den-mcp-agent": "agent:lead",
  "x-den-mcp-workspace": "north",
};

describe("issue 1182: POST .../agents/:id/folder", () => {
  it("a person moves a stopped agent's folder", async () => {
    const s = await stopped();
    const post = await api(s.r);
    const r = await post({ folder: s.to });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, agent: "scout" });
    expect(fs.realpathSync(String(s.record().cwd))).toBe(fs.realpathSync(s.to));
  });

  it("an agent's direct write is refused, nothing changed", async () => {
    const s = await stopped();
    const before = fs.readFileSync(s.file, "utf-8");
    const post = await api(s.r);
    const r = await post({ folder: s.to }, AGENT_HEADERS);
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/only a person/);
    expect(fs.readFileSync(s.file, "utf-8")).toBe(before);
  });

  it("takes repo or folder, one of them", async () => {
    const s = await stopped();
    const before = fs.readFileSync(s.file, "utf-8");
    const post = await api(s.r);
    expect((await post({})).status).toBe(400);
    expect((await post({ folder: s.to, repo: "shop" })).status).toBe(400);
    expect((await post({ folder: s.to, extra: 1 })).status).toBe(400);
    expect(fs.readFileSync(s.file, "utf-8")).toBe(before);
  });

  it("is a known route, and an agent's token never reaches it", () => {
    const cls = routeClass("POST", FOLDER);
    expect(cls).not.toBeNull();
    expect(
      agentRefusal(
        { actor: "agent:lead" } as never,
        "POST",
        FOLDER,
        cls as never,
      ),
    ).not.toBeNull();
  });
});

describe("issue 1182: the CLI's agents folder", () => {
  type Call = { method: string; path: string; body: unknown };
  function fake(answer: ServerAnswer | null) {
    const calls: Call[] = [];
    const server: PersonServer = async (method, p, body) => {
      calls.push({ method, path: p, body });
      return answer;
    };
    return { server, calls };
  }
  const run = (r: Rig, server: PersonServer, ...args: string[]) =>
    cmdAgents(args, { ...r.deps, server, loginPath: async () => {} });

  it("the server changes it; the CLI writes nothing", async () => {
    const s = await stopped();
    const before = fs.readFileSync(s.file, "utf-8");
    const yes = fake({
      status: 200,
      json: { ok: true, agent: "scout", cwd: s.to },
    });
    expect(
      await run(s.r, yes.server, "folder", "scout", "--folder", s.to),
    ).toBe(0);
    expect(yes.calls).toEqual([
      { method: "POST", path: FOLDER, body: { folder: s.to } },
    ]);
    expect(fs.readFileSync(s.file, "utf-8")).toBe(before);
  });

  it("a refusal is shown, exits non-zero and changes nothing", async () => {
    const s = await stopped();
    const before = fs.readFileSync(s.file, "utf-8");
    const no = fake({
      status: 403,
      json: { ok: false, error: "only a person can do that" },
    });
    expect(
      await run(s.r, no.server, "folder", "scout", "--folder", s.to),
    ).not.toBe(0);
    expect(fs.readFileSync(s.file, "utf-8")).toBe(before);
    expect(s.r.err.join("\n")).toContain("only a person can do that");
  });

  it("with no server, the CLI changes it as before", async () => {
    const s = await stopped();
    expect(
      await run(s.r, fake(null).server, "folder", "scout", "--folder", s.to),
    ).toBe(0);
    expect(fs.realpathSync(String(s.record().cwd))).toBe(fs.realpathSync(s.to));
  });
});
