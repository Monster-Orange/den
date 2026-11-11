/**
 * D32's routes: GET /api/workspaces/:ws/agents/:id/helpers (the list) and
 * …/helpers/:helper (one transcript, its last `?limit` lines), read-only.
 * The agents' route handler on a rig (a scripted PTY, nothing runs), with
 * Claude Code's files under the rig's own HOME, never this machine's.
 * Invented workspaces and helpers only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import * as fs from "fs";
import {
  agentFilesDir,
  writeRecord,
} from "../../../src/shared/agents/records.js";
import { recentActions } from "../../../src/ui/server/audit.js";
import { agentRefusal } from "../../../src/ui/server/request-guard.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";
import { HELPERS_READ_ONLY_NOTE } from "../../../src/shared/agents/helpers.js";
import { resetHelperCache } from "../../../src/shared/agents/claude-helpers.js";
import { cleanupRigs, rig, type Rig } from "../agents/helpers/rig.js";
import {
  H0,
  H1,
  TOKEN,
  seedScout,
  writeHelper,
} from "../agents/helpers/seed-helpers.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
  resetHelperCache();
});

async function api() {
  const r = await rig();
  // Claude Code's files: under the rig's own HOME.
  const home = path.join(r.dir, "home");
  r.deps.env = { ...r.deps.env, HOME: home };
  const server = http.createServer((req, res) => {
    jsonApiErrors(res, newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    handleAgentRoutes(req, res, p, { agents: r.deps }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const port = (server.address() as AddressInfo).port;
  return {
    r,
    home,
    async call(
      method: string,
      p: string,
      headers: Record<string, string> = {},
    ) {
      const res = await fetch(`http://localhost:${port}${p}`, {
        method,
        headers,
      });
      const text = await res.text();
      return {
        status: res.status,
        allow: res.headers.get("allow"),
        json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
      };
    },
  };
}

const seed = (r: Rig, home: string, lines?: number) =>
  seedScout(r.stateDir, r.wsDir("north"), home, { lines });

describe("GET /api/workspaces/:ws/agents/:id/helpers", () => {
  it("lists the agent's helpers, read-only, with the note that says why", async () => {
    const a = await api();
    seed(a.r, a.home);
    const { status, json } = await a.call(
      "GET",
      "/api/workspaces/north/agents/scout/helpers",
    );
    expect(status).toBe(200);
    expect(json).toMatchObject({
      agent: "scout",
      workspace: "north",
      supported: true,
      live: false,
      note: HELPERS_READ_ONLY_NOTE,
    });
    const hs = json.helpers as Array<Record<string, unknown>>;
    expect(hs.map((h) => [h.id, h.status, h.description, h.type])).toEqual([
      [H1, "done", "Count the notes", "Explore"],
    ]);
  });

  it("an agent with no conversation yet: none, still supported", async () => {
    const a = await api();
    seed(a.r, a.home);
    writeRecord(a.r.stateDir, {
      id: "quiet",
      persona: "builder",
      runtime: "den-claude",
      workspace: "north",
      cwd: a.r.wsDir("north"),
      session: { backend: "den-pty", id: "gone-quiet" },
      sessionName: "acme-north:quiet",
      startedAt: "2026-11-01T09:59:00.000Z",
    });
    const { status, json } = await a.call(
      "GET",
      "/api/workspaces/north/agents/quiet/helpers",
    );
    expect(status).toBe(200);
    expect(json.helpers).toEqual([]);
    expect(json.supported).toBe(true);
  });

  it("a workspace or agent that doesn't exist: 404", async () => {
    const a = await api();
    seed(a.r, a.home);
    expect(
      (await a.call("GET", "/api/workspaces/west/agents/scout/helpers")).status,
    ).toBe(404);
    expect(
      (await a.call("GET", "/api/workspaces/north/agents/nobody/helpers"))
        .status,
    ).toBe(404);
  });

  it("read-only: anything but GET or HEAD is 405, Allow: GET", async () => {
    const a = await api();
    seed(a.r, a.home);
    for (const m of ["POST", "DELETE", "PUT"]) {
      const r = await a.call(m, "/api/workspaces/north/agents/scout/helpers");
      expect([m, r.status, r.allow]).toEqual([m, 405, "GET"]);
      const t = await a.call(
        m,
        `/api/workspaces/north/agents/scout/helpers/${H1}`,
      );
      expect([m, t.status]).toEqual([m, 405]);
    }
  });
});

describe("GET /api/workspaces/:ws/agents/:id/helpers/:helper", () => {
  it("its transcript: the prompt, then its lines, never more than ?limit", async () => {
    const a = await api();
    seed(a.r, a.home, 6);
    const all = await a.call(
      "GET",
      `/api/workspaces/north/agents/scout/helpers/${H1}`,
    );
    expect(all.status).toBe(200);
    const items = all.json.items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ kind: "prompt", text: "Count the notes" });
    expect(items.map((i) => i.text)).toContain("step 5");
    expect(all.json.omitted).toBe(0);
    expect((all.json.helper as Record<string, unknown>).id).toBe(H1);

    const last = await a.call(
      "GET",
      `/api/workspaces/north/agents/scout/helpers/${H1}?limit=2`,
    );
    const li = last.json.items as Array<Record<string, unknown>>;
    expect(li.map((i) => i.text)).toEqual(["step 4", "step 5"]);
    expect(last.json.omitted).toBe(items.length - 2);
  });

  it("a helper the agent doesn't have: 404 naming it", async () => {
    const a = await api();
    seed(a.r, a.home);
    const r = await a.call(
      "GET",
      "/api/workspaces/north/agents/scout/helpers/a9f0c0ffee0000009",
    );
    expect(r.status).toBe(404);
    expect(String(r.json.error)).toContain('no helper "a9f0c0ffee0000009"');
  });

  it("a helper id that is a path: 404, nothing read outside", async () => {
    const a = await api();
    seed(a.r, a.home);
    const r = await a.call(
      "GET",
      "/api/workspaces/north/agents/scout/helpers/..%2F..%2Fsecret",
    );
    expect(r.status).toBe(404);
  });
});

describe("D34: POST .../agents/:id/clear-helpers (Clear done)", () => {
  const LIST = "/api/workspaces/north/agents/scout/helpers";
  const CLEAR = "/api/workspaces/north/agents/scout/clear-helpers";
  const ids = (j: Record<string, unknown>, k = "helpers") =>
    ((j[k] as { id: string }[] | undefined) ?? []).map((h) => h.id);

  it("hides every finished helper, this conversation's and earlier ones'; ?all=1 lists them", async () => {
    const a = await api();
    seedScout(a.r.stateDir, a.r.wsDir("north"), a.home, { earlier: true });
    const before = (await a.call("GET", LIST)).json;
    expect([ids(before).sort(), before.clearedCount]).toEqual([
      [H0, H1].sort(),
      0,
    ]);
    const r = await a.call("POST", CLEAR);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, agent: "scout" });
    const after = (await a.call("GET", LIST)).json;
    expect([ids(after), after.clearedCount, "cleared" in after]).toEqual([
      [],
      2,
      false,
    ]);
    const all = (await a.call("GET", `${LIST}?all=1`)).json;
    expect([ids(all), ids(all, "cleared").sort()]).toEqual([
      [],
      [H0, H1].sort(),
    ]);
    // A cleared helper's transcript still reads (read-only, as now).
    expect((await a.call("GET", `${LIST}/${H1}`)).status).toBe(200);
  });

  it("a mark in the agent's own files; Claude Code's are untouched; it survives a restart", async () => {
    const a = await api();
    seedScout(a.r.stateDir, a.r.wsDir("north"), a.home);
    const sub = path.join(
      a.home,
      ".claude",
      "projects",
      "-work-north",
      TOKEN,
      "subagents",
    );
    const snap = () =>
      fs
        .readdirSync(sub)
        .sort()
        .map((f) => [f, fs.readFileSync(path.join(sub, f), "utf-8")]);
    const was = snap();
    await a.call("POST", CLEAR);
    expect(snap()).toEqual(was);
    const mark = path.join(
      agentFilesDir(a.r.stateDir, "scout"),
      "helpers-cleared.json",
    );
    expect(fs.statSync(mark).mode & 0o777).toBe(0o600);
    // A new server over the same state: still cleared.
    resetHelperCache();
    expect((await a.call("GET", LIST)).json.clearedCount).toBe(1);
  });

  it("a helper that ends after the mark shows as usual", async () => {
    const a = await api();
    seedScout(a.r.stateDir, a.r.wsDir("north"), a.home);
    await a.call("POST", CLEAR);
    const later = "a7f0c0ffee0000007";
    writeHelper(a.home, TOKEN, later, "Count again", 3, Date.now() + 60_000);
    resetHelperCache();
    const j = (await a.call("GET", LIST)).json;
    expect([ids(j), j.clearedCount]).toEqual([[later], 1]);
  });

  it("a person's only: an agent's claim is refused, nothing written; audited either way", async () => {
    const a = await api();
    seedScout(a.r.stateDir, a.r.wsDir("north"), a.home);
    const r = await a.call("POST", CLEAR, {
      "content-type": "application/json",
      "x-den-actor": "agent",
      "x-den-mcp-client": "jest",
      "x-den-mcp-agent": "agent:scout",
      "x-den-mcp-workspace": "north",
    });
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/only a person can clear/);
    expect(
      fs.existsSync(
        path.join(agentFilesDir(a.r.stateDir, "scout"), "helpers-cleared.json"),
      ),
    ).toBe(false);
    expect(
      recentActions().filter(
        (e) =>
          e.detail === "clear-helpers scout in north" &&
          e.outcome === "refused",
      ).length,
    ).toBeGreaterThan(0);
    expect((await a.call("POST", CLEAR)).status).toBe(200);
    const mine = recentActions().filter((e) =>
      e.detail.includes("clear scout's finished helpers"),
    );
    expect(mine.at(-1)).toMatchObject({ verb: "agents", actor: "user" });
    expect(mine.at(-1)?.outcome).toBeUndefined();
  });

  it("the agent's row: no helpers area once nothing is left to show", async () => {
    const a = await api();
    seedScout(a.r.stateDir, a.r.wsDir("north"), a.home);
    const row = async () =>
      (
        (await a.call("GET", "/api/workspaces/north/agents")).json.agents as {
          agent: string;
          helpers?: Record<string, unknown>;
        }[]
      ).find((x) => x.agent === "scout");
    expect((await row())?.helpers).toMatchObject({
      total: 1,
      ended: 1,
      cleared: 0,
    });
    await a.call("POST", CLEAR);
    resetHelperCache();
    expect((await row())?.helpers).toBeUndefined();
  });

  it("an agent's token is refused it at the guard, saying why", () => {
    const why = agentRefusal(
      {
        kind: "agent",
        actor: "agent:scout",
        workspace: "north",
        grants: [],
        session: { id: "s1", name: "acme-north:scout" },
      },
      "POST",
      CLEAR,
      "mutating",
    );
    expect(why).toMatch(/clearing an agent's helpers is a person's/);
    expect(routeClass("POST", CLEAR)).toBe("mutating");
  });

  it("takes no fields; GET is 405", async () => {
    const a = await api();
    seedScout(a.r.stateDir, a.r.wsDir("north"), a.home);
    expect((await a.call("GET", CLEAR)).status).toBe(405);
  });
});
