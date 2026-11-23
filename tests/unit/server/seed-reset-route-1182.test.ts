/**
 * Issue 1182: `workspace seed` and `init` with a reset go through the
 * server.
 *
 *   POST /api/workspaces/seed { reset: true }: resets the blueprint's
 *       projects to the committed config, a person's (request-guard's
 *       AGENT_PERSON_WRITES too), audited
 *
 * The CLI's side (seedResetViaServer) sends it with the person token; a
 * refusal changes nothing, and with no server the CLI resets as before.
 *
 * Invented names.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  seedResetRoute,
  type SeedResetDeps,
} from "../../../src/ui/server/workspace-routes.js";
import { seedResetViaServer } from "../../../src/ui/cli/workspace-person.js";
import type { PersonServer } from "../../../src/ui/cli/person-server.js";
import { agentRefusal } from "../../../src/ui/server/request-guard.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise((r) => s.close(() => r(null)));
});

async function world() {
  const seeded: number[] = [];
  const audited: string[] = [];
  const d: SeedResetDeps = {
    isAgent: (req) => req.headers["x-test-agent"] === "1",
    seed: () => {
      seeded.push(1);
      return [{ name: "north", repos: ["shop", "api"] }];
    },
    audit: (req, line, refused) =>
      audited.push(`${refused ? "refused: " : ""}${line}`),
  };
  const server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    void seedResetRoute(req, res, p, d).then((done) => {
      if (!done) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown, agent = false) => {
    const r = await fetch(`${base}/api/workspaces/seed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(agent ? { "x-test-agent": "1" } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      status: r.status,
      json: (await r.json()) as Record<string, unknown>,
    };
  };
  return { post, seeded, audited };
}

describe("issue 1182: POST /api/workspaces/seed", () => {
  it("a person's reset runs the seed, and is audited", async () => {
    const w = await world();
    const r = await w.post({ reset: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      seeded: [{ name: "north", repos: ["shop", "api"] }],
    });
    expect(w.seeded).toEqual([1]);
    expect(w.audited.join("\n")).toMatch(/north/);
  });

  it("an agent is refused, and nothing is seeded", async () => {
    const w = await world();
    const r = await w.post({ reset: true }, true);
    expect(r.status).toBe(403);
    expect(w.seeded).toEqual([]);
    expect(w.audited.join("\n")).toMatch(/^refused: /m);
  });

  it("takes reset: true and nothing else", async () => {
    const w = await world();
    expect((await w.post({})).status).toBe(400);
    expect((await w.post({ reset: true, more: 1 })).status).toBe(400);
    expect(w.seeded).toEqual([]);
  });

  it("is a known route, and an agent's token never reaches it", () => {
    const cls = routeClass("POST", "/api/workspaces/seed");
    expect(cls).not.toBeNull();
    expect(
      agentRefusal(
        { actor: "agent:lead" } as never,
        "POST",
        "/api/workspaces/seed",
        cls as never,
      ),
    ).not.toBeNull();
  });
});

describe("issue 1182: seedResetViaServer (the CLI's side)", () => {
  type Call = { method: string; path: string; body: unknown };
  function fake(answer: { status: number; json: unknown } | null) {
    const calls: Call[] = [];
    const server: PersonServer = async (method, p, body) => {
      calls.push({ method, path: p, body });
      return answer;
    };
    return { server, calls };
  }

  it("asks the server to reset, and answers what it seeded", async () => {
    const f = fake({
      status: 200,
      json: { ok: true, seeded: [{ name: "north", repos: ["shop"] }] },
    });
    const r = await seedResetViaServer(f.server);
    expect(f.calls).toEqual([
      { method: "POST", path: "/api/workspaces/seed", body: { reset: true } },
    ]);
    expect(r).toEqual({
      kind: "done",
      seeded: [{ name: "north", repos: ["shop"] }],
    });
  });

  it("a refusal says why; no server is unanswered", async () => {
    const no = fake({ status: 403, json: { ok: false, error: "nope" } });
    expect(await seedResetViaServer(no.server)).toEqual({
      kind: "refused",
      error: "nope",
    });
    expect(await seedResetViaServer(fake(null).server)).toEqual({
      kind: "unanswered",
    });
  });
});
