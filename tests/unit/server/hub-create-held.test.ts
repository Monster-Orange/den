/**
 * Issue 271: the server agent's held write hub_project_create. Its check
 * turns the ask into Den's own words for the Allow (refusing a linked
 * project, one with an ask waiting, Den's own place, another project for
 * a project's agent); its run is the same code Settings runs
 * (askHubCreate), asking Hub with the agent's headers so Hub's answer
 * reaches it. The policy places it as routine: Hub's owner still decides.
 * A stub Hub on localhost plays Hub. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  checkHubCreateHeld,
  runHubCreateHeld,
} from "../../../src/ui/server/hub-create-routes.js";
import { HELD_WRITE_RISK } from "../../../src/shared/approval-policy.js";
import type {
  HubCreate,
  HubCreateDeps,
} from "../../../src/shared/hub/hub-project-create.js";
import type { HubProjectLink } from "../../../src/shared/hub/hub-project-link.js";

const TOKEN = "hubi_TESTONLYabc987";
const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function setup() {
  const seen: { agent: string; body: unknown }[] = [];
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({
        agent: String(req.headers["x-den-agent-id"] ?? ""),
        body: JSON.parse(raw || "{}"),
      });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ held: "held_1", state: "pending" }));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const kept = new Map<string, HubCreate | null>();
  const links = new Map<string, HubProjectLink>([
    ["south", { id: "proj_s1", slug: "south", name: "South" }],
  ]);
  const d: HubCreateDeps = {
    exists: (ws) => ["north", "south"].includes(ws),
    linked: (ws) => links.get(ws) ?? null,
    asked: (ws) => kept.get(ws) ?? null,
    hub: async () => ({ url: base, token: TOKEN }),
    taken: async () => [],
    keep: (ws, c) => void kept.set(ws, c),
    link: () => undefined,
    changed: () => undefined,
  };
  const look = { ...d, name: (ws: string) => (ws === "north" ? "North" : ws) };
  return { d, look, seen, kept };
}

describe("issue 271: hub_project_create, the held write", () => {
  it("check: Den's words for the Allow; the name defaults to the project's", async () => {
    const s = await setup();
    const c = checkHubCreateHeld(s.look, { project: "north" }, {});
    expect(c).toMatchObject({
      ok: true,
      args: { project: "north", name: "North" },
      params: { project: "north", name: "North" },
      summary: "ask Hub to create the Hub project North for project north",
    });
    expect(
      checkHubCreateHeld(s.look, { project: "north", name: " Polaris " }, {}),
    ).toMatchObject({ ok: true, args: { name: "Polaris" } });
  });

  it("check refuses: linked (1:1), waiting, unknown, Den's own place, another project, a long name", async () => {
    const s = await setup();
    const no = (a: Record<string, unknown>, who = {}) =>
      checkHubCreateHeld(s.look, a, who);
    expect(no({ project: "south" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already linked/),
    });
    expect(no({ project: "east" })).toMatchObject({ ok: false });
    expect(no({ project: "den-server" })).toMatchObject({ ok: false });
    expect(
      no({ project: "north" }, { agent: "planner", project: "south" }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/south/) });
    expect(no({ project: "north", name: "n".repeat(81) })).toMatchObject({
      ok: false,
    });
    s.kept.set("north", {
      held: "h",
      name: "North",
      slug: "north",
      askedAt: "2026-11-17T17:00:00.000Z",
      by: "agent",
    });
    expect(no({ project: "north" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/waiting/),
    });
  });

  it("run: the same ask as Settings, with the agent's headers; kept for Den to link", async () => {
    const s = await setup();
    const r = await runHubCreateHeld(
      s.d,
      { project: "north", name: "North" },
      { id: "req1", agent: "agt_den1" },
      () => "Den",
    );
    expect(r).toMatchObject({ ok: true, project: "north" });
    expect(s.seen[0].agent).toBe("agt_den1");
    expect(s.kept.get("north")).toMatchObject({
      held: "held_1",
      by: "agent",
      agent: "agt_den1",
    });
  });

  it("the policy places it: routine (Hub's owner still decides)", () => {
    expect(HELD_WRITE_RISK.hub_project_create?.risk).toBe("routine");
  });
});
