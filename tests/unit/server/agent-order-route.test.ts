/**
 * Issue 96: POST /api/workspaces/:ws/agents/:id/order {to}: a person
 * moves an agent up, down, to the top or bottom, or to a place, and every
 * list of the project's agents follows. The order is the person's: it is
 * stored in their user config (config/local/user.yml), never in the
 * agent's record or the project setup. A person's only. The agents' route
 * handler on a rig (nothing runs), under a temp install root. Invented
 * names only.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

type Mods = {
  handleAgentRoutes: typeof import("../../../src/ui/server/agent-routes.js").handleAgentRoutes;
  http: typeof import("../../../src/ui/server/http-errors.js");
  guard: typeof import("../../../src/ui/server/request-guard.js");
  routeClass: typeof import("../../../src/ui/server/route-classes.js").routeClass;
  rig: typeof import("../agents/helpers/rig.js");
  records: typeof import("../../../src/shared/agents/records.js");
};
let m: Mods;
let tmp = "";
let root = "";
let saved: string | undefined;
const WS_FILE = () => path.join(root, "config", "local", "workspaces.yml");
const USER_FILE = () => path.join(root, "config", "local", "user.yml");
const userYml = () => {
  try {
    return fs.readFileSync(USER_FILE(), "utf-8");
  } catch {
    return "";
  }
};

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-order-")));
  root = path.join(tmp, "den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  // Anchor BEFORE importing: workspaces.ts freezes its path at load.
  saved = process.env.DEN_ROOT;
  process.env.DEN_ROOT = root;
  m = {
    handleAgentRoutes: (await import("../../../src/ui/server/agent-routes.js"))
      .handleAgentRoutes,
    http: await import("../../../src/ui/server/http-errors.js"),
    guard: await import("../../../src/ui/server/request-guard.js"),
    routeClass: (await import("../../../src/ui/server/route-classes.js"))
      .routeClass,
    rig: await import("../agents/helpers/rig.js"),
    records: await import("../../../src/shared/agents/records.js"),
  };
});

afterAll(() => {
  if (saved === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await m.rig.cleanupRigs();
});

const AGENTS = ["scout", "coder", "fixer"];

async function api() {
  fs.rmSync(USER_FILE(), { force: true });
  fs.writeFileSync(
    WS_FILE(),
    "active: [north]\nworkspaces:\n  north:\n    services: {}\n  south:\n    services: {}\n",
  );
  const r = await m.rig.rig();
  AGENTS.forEach((id, i) =>
    m.records.writeRecord(r.stateDir, {
      id,
      persona: "builder",
      runtime: "den-claude",
      workspace: "north",
      cwd: r.wsDir("north"),
      session: { backend: "den-pty", id: `gone-${id}` },
      sessionName: `acme-north:${id}`,
      startedAt: `2026-11-15T0${i + 1}:00:00.000Z`,
    }),
  );
  const server = http.createServer((req, res) => {
    m.http.jsonApiErrors(res, m.http.newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void m
      .handleAgentRoutes(req, res, p, { agents: r.deps })
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end("{}");
        }
      });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    r,
    async list(): Promise<string[]> {
      const res = await fetch(`${base}/api/workspaces/north/agents`);
      const j = (await res.json()) as unknown;
      const rows = (
        Array.isArray(j) ? j : (j as { agents: unknown[] }).agents
      ) as {
        agent: string;
      }[];
      return rows.map((x) => x.agent);
    },
    async move(
      id: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) {
      const res = await fetch(
        `${base}/api/workspaces/north/agents/${id}/order`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        },
      );
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    },
  };
}

describe("Issue 96: POST .../agents/:id/order", () => {
  it("by start time until a person moves one; then the list follows, and the order is stored", async () => {
    const a = await api();
    expect(await a.list()).toEqual(["scout", "coder", "fixer"]);
    const r = await a.move("fixer", { to: "top" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      agent: "fixer",
      position: 1,
      of: 3,
    });
    expect(await a.list()).toEqual(["fixer", "scout", "coder"]);
    // The person's user config holds it; the project setup and the
    // agent's record don't.
    expect(userYml()).toMatch(
      /order:\s*\n\s*north:\s*\n\s*- fixer\s*\n\s*- scout\s*\n\s*- coder/,
    );
    expect(fs.readFileSync(WS_FILE(), "utf-8")).not.toMatch(/order/);
    expect(
      JSON.stringify(m.records.readRecord(a.r.stateDir, "fixer")),
    ).not.toMatch(/order/);
    await a.move("fixer", { to: "down" });
    expect(await a.list()).toEqual(["scout", "fixer", "coder"]);
    const placed = await a.move("scout", { to: 3 });
    expect(placed.json).toMatchObject({ position: 3, of: 3 });
    expect(await a.list()).toEqual(["fixer", "coder", "scout"]);
  });

  it("before or after another agent: a drop, or a move inside the page's group", async () => {
    const a = await api();
    const r = await a.move("fixer", { to: { before: "coder" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ position: 2, of: 3 });
    expect(await a.list()).toEqual(["scout", "fixer", "coder"]);
    await a.move("scout", { to: { after: "coder" } });
    expect(await a.list()).toEqual(["fixer", "coder", "scout"]);
    for (const to of [
      { before: "nobody" },
      { after: "fixer" },
      { before: "coder", after: "scout" },
      { next: "coder" },
      { before: 3 },
    ])
      expect([to, (await a.move("fixer", { to })).status]).toEqual([to, 400]);
    expect(await a.list()).toEqual(["fixer", "coder", "scout"]);
  });

  it("refuses a bad to, an unknown field, or an agent the project hasn't; nothing stored", async () => {
    const a = await api();
    for (const body of [
      { to: "sideways" },
      { to: 0 },
      { to: 1.5 },
      {},
      { to: "up", x: 1 },
    ])
      expect((await a.move("coder", body)).status).toBe(400);
    expect((await a.move("nobody", { to: "top" })).status).toBe(404);
    expect(userYml()).not.toMatch(/order/);
  });

  it("a stored order naming unknown ids is ignored; a new agent goes at the end", async () => {
    const a = await api();
    fs.writeFileSync(
      USER_FILE(),
      "agents:\n  order:\n    north: [ghost, fixer, ../x, coder, nobody]\n",
    );
    // scout isn't in the stored order (a new agent): after the others.
    expect(await a.list()).toEqual(["fixer", "coder", "scout"]);
    await a.move("scout", { to: "top" });
    // The stored order is the agents there now: the unknown ids are gone.
    expect(userYml()).not.toMatch(/ghost|nobody|\.\.\/x/);
    expect(await a.list()).toEqual(["scout", "fixer", "coder"]);
  });

  it("a person's only: an agent's claim is refused, nothing stored", async () => {
    const a = await api();
    const r = await a.move(
      "fixer",
      { to: "top" },
      {
        "x-den-actor": "agent",
        "x-den-mcp-client": "jest",
        "x-den-mcp-agent": "agent:scout",
        "x-den-mcp-workspace": "north",
      },
    );
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/only a person can reorder agents/);
    expect(await a.list()).toEqual(["scout", "coder", "fixer"]);
    expect(userYml()).not.toMatch(/order/);
  });

  it("is a known route, a person's write, and an agent's token never reaches it", () => {
    const p = "/api/workspaces/north/agents/scout/order";
    const cls = m.routeClass("POST", p);
    expect(cls).toBe("mutating");
    expect(m.guard.AGENT_PERSON_WRITES).toContain(
      "/api/workspaces/:ws/agents/:id/order",
    );
    expect(
      m.guard.agentRefusal(
        {
          actor: "agent:scout",
          session: { id: "s1", name: "acme-north:scout" },
        } as never,
        "POST",
        p,
        cls as never,
      ),
    ).toMatch(/a person's to do/);
  });
});
