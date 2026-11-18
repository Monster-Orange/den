/**
 * Issue 271: Den asks Hub to create a project with Hub's project plan path:
 * POST /api/projects/plan {changes: [{op: "create", slug, name}], reason}
 * with the install's token, and reads what became of it with GET
 * /api/projects/plan/:held. Den proposes the slug from the name; a slug
 * Hub says is taken is re-picked before anyone is asked. A stub Hub on
 * localhost plays Hub. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  HubCallError,
  hubPlanCreate,
  hubPlanOutcome,
  hubSlugFor,
} from "../../../src/shared/hub.js";

const TOKEN = "hubi_TESTONLYabc987";
const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

interface Seen {
  method: string;
  path: string;
  auth: string;
  agent: string;
  body: Record<string, unknown> | null;
}

/** A stub Hub: `taken` slugs are refused; asks are held as held_<n>. */
async function stubHub(
  o: {
    taken?: string[];
    outcome?: Record<string, unknown>;
    status?: number;
  } = {},
) {
  const seen: Seen[] = [];
  let base = "";
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        auth: String(req.headers.authorization ?? ""),
        agent: String(req.headers["x-den-agent-id"] ?? ""),
        body,
      });
      const send = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.method === "POST" && req.url === "/api/projects/plan") {
        if (o.status) return send(o.status, { error: "nope" });
        const c = (body?.changes as { slug: string }[])[0];
        if (o.taken?.includes(c.slug))
          return send(400, {
            error: `change 1: the short name ${c.slug} is taken, or is an old short name that still opens its project`,
          });
        return send(201, {
          held: `held_${seen.length}`,
          state: "pending",
          summary: "1 project change",
          report: { steps: [], errors: [] },
          url: `${base}/acme/held/held_${seen.length}`,
        });
      }
      if (req.method === "GET" && req.url?.startsWith("/api/projects/plan/")) {
        if (!o.outcome) return send(404, { error: "not found" });
        return send(200, o.outcome);
      }
      send(404, { error: "no route" });
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { base, seen };
}

describe("hubSlugFor", () => {
  it("lowercase letters, digits and hyphens, up to 39, from the name", () => {
    expect(hubSlugFor("North Star")).toBe("north-star");
    expect(hubSlugFor("  Café & Bar!! 2 ")).toBe("cafe-bar-2");
    expect(hubSlugFor("x".repeat(60))).toHaveLength(39);
    expect(hubSlugFor("東京")).toBe("project");
  });

  it("skips slugs Hub already has", () => {
    expect(hubSlugFor("North Star", ["north-star"])).toBe("north-star-2");
    expect(hubSlugFor("North Star", ["north-star", "north-star-2"])).toBe(
      "north-star-3",
    );
    expect(hubSlugFor("x".repeat(60), ["x".repeat(39)])).toBe(
      `${"x".repeat(37)}-2`,
    );
  });
});

describe("hubPlanCreate", () => {
  it("posts one create to Hub's plan route with the token; reads the held ask", async () => {
    const h = await stubHub();
    const r = await hubPlanCreate(h.base, TOKEN, {
      name: "North Star",
      reason: "Asked in Den",
    });
    expect(r).toEqual({
      held: "held_1",
      state: "pending",
      slug: "north-star",
      name: "North Star",
      summary: "1 project change",
      url: `${h.base}/acme/held/held_1`,
    });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(h.seen[0].body).toEqual({
      changes: [{ op: "create", slug: "north-star", name: "North Star" }],
      reason: "Asked in Den",
    });
  });

  it("re-picks a slug Hub says is taken, before anyone is asked", async () => {
    const h = await stubHub({ taken: ["north-star", "north-star-2"] });
    const r = await hubPlanCreate(h.base, TOKEN, {
      name: "North Star",
      reason: "Asked in Den",
      taken: ["north-star"],
    });
    expect(r.slug).toBe("north-star-3");
    // The known-taken one isn't even tried; the one Hub refused is.
    expect(
      h.seen.map((s) => (s.body?.changes as { slug: string }[])[0].slug),
    ).toEqual(["north-star-2", "north-star-3"]);
  });

  it("sends the asking agent's headers, so Hub's answer reaches it", async () => {
    const h = await stubHub();
    await hubPlanCreate(h.base, TOKEN, {
      name: "North Star",
      reason: "Asked by Den's agent",
      caller: {
        agent: "Den",
        agentId: "agt_den1",
        session: "held-1",
        workspace: "den",
        repos: [],
      },
    });
    expect(h.seen[0].agent).toBe("agt_den1");
  });

  it("a blank reason, an empty or too long name: refused before Hub is asked", async () => {
    const h = await stubHub();
    await expect(
      hubPlanCreate(h.base, TOKEN, { name: "North", reason: "  " }),
    ).rejects.toThrow(/reason/);
    await expect(
      hubPlanCreate(h.base, TOKEN, { name: " ", reason: "r" }),
    ).rejects.toThrow(/name/);
    await expect(
      hubPlanCreate(h.base, TOKEN, { name: "n".repeat(81), reason: "r" }),
    ).rejects.toThrow(/80/);
    expect(h.seen).toHaveLength(0);
  });

  it("Hub refuses for another reason: its words, as a HubCallError", async () => {
    const h = await stubHub({ status: 403 });
    const e = await hubPlanCreate(h.base, TOKEN, {
      name: "North",
      reason: "r",
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HubCallError);
    expect(h.seen).toHaveLength(1);
  });
});

describe("hubPlanOutcome", () => {
  it("applied: the new project's hidden id, slug, name and address", async () => {
    const h = await stubHub({
      outcome: {
        held: "held_1",
        state: "applied",
        decided_at: "2026-11-17T18:00:00.000Z",
        projects: [
          {
            id: "proj_north1",
            slug: "north-star",
            name: "North Star",
            url: "http://127.0.0.1/acme?project=north-star",
          },
        ],
      },
    });
    const o = await hubPlanOutcome(h.base, TOKEN, "held_1");
    expect(o).toEqual({
      held: "held_1",
      state: "applied",
      decidedAt: "2026-11-17T18:00:00.000Z",
      projects: [
        {
          id: "proj_north1",
          slug: "north-star",
          name: "North Star",
          url: "http://127.0.0.1/acme?project=north-star",
        },
      ],
    });
    expect(h.seen[0].path).toBe("/api/projects/plan/held_1");
    expect(h.seen[0].auth).toBe(`Bearer ${TOKEN}`);
  });

  it("pending: id null; an unknown state reads as superseded (ask again)", async () => {
    const h = await stubHub({
      outcome: {
        held: "held_1",
        state: "pending",
        decided_at: null,
        projects: [{ id: null, slug: "north-star", name: "North Star" }],
      },
    });
    const o = await hubPlanOutcome(h.base, TOKEN, "held_1");
    expect(o.state).toBe("pending");
    expect(o.projects[0].id).toBeNull();
    const odd = await stubHub({ outcome: { held: "held_1", state: "weird" } });
    expect((await hubPlanOutcome(odd.base, TOKEN, "held_1")).state).toBe(
      "superseded",
    );
  });
});
