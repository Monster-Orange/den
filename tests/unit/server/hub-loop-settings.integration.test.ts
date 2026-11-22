/**
 * Issue 158: the Hub delivery loop's Settings rows reach the config: the
 * install's (Settings › Hub: user.yml hub.delivery_loop) and a project's
 * (Project setup: workspaces.yml <project>.hub_delivery_loop and its
 * addition; both read by hub-loop.ts). A person's only: an agent's claim
 * is refused.
 *
 * The demo distribution in a temp folder. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer;
beforeAll(async () => {
  s = await startAgentsPageServer();
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

const local = (f: string) =>
  (yaml.parse(
    fs.readFileSync(path.join(s.tmp, "dist", "config", "local", f), "utf-8"),
  ) ?? {}) as Record<string, unknown>;
const south = () =>
  (
    local("workspaces.yml").workspaces as Record<
      string,
      Record<string, unknown>
    >
  ).south;

const AGENT_CLAIM = {
  "x-den-actor": "agent",
  "x-den-mcp-agent": "agent:planner",
};

async function post(
  url: string,
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${s.base}${url}`, {
    method: "POST",
    headers: {
      ...denAuth(s.stateDir),
      "content-type": "application/json",
      ...extra,
    },
    body: JSON.stringify(body),
  });
  return {
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}
const get = (url: string) =>
  fetch(`${s.base}${url}`, { headers: denAuth(s.stateDir) }).then(
    (x) => x.json() as Promise<Record<string, unknown>>,
  );

describe("issue 158: the Hub delivery loop's settings", () => {
  it("the install's: on by default; off lands in user.yml; on clears it", async () => {
    expect((await get("/api/settings")).hub_delivery_loop).toBe(true);
    expect(
      (await post("/api/settings", { hub_delivery_loop: false })).status,
    ).toBe(200);
    expect(
      (local("user.yml").hub as Record<string, unknown> | undefined)
        ?.delivery_loop,
    ).toBe(false);
    expect((await get("/api/settings")).hub_delivery_loop).toBe(false);
    await post("/api/settings", { hub_delivery_loop: null });
    expect((await get("/api/settings")).hub_delivery_loop).toBe(true);
  });

  it("a project's: as the install by default; off and an addition land in workspaces.yml; an agent's claim is refused", async () => {
    const before = await get("/api/workspaces/settings?workspace=south");
    expect(before).toMatchObject({
      hub_delivery_loop: null,
      hub_delivery_loop_extra: "",
    });
    const r = await post("/api/workspaces/settings", {
      workspace: "south",
      hub_delivery_loop: false,
      hub_delivery_loop_extra: "Name the design.",
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      hub_delivery_loop: false,
      hub_delivery_loop_extra: "Name the design.",
    });
    expect(south()).toMatchObject({
      hub_delivery_loop: false,
      hub_delivery_loop_extra: "Name the design.",
    });
    const claim = await post(
      "/api/workspaces/settings",
      { workspace: "south", hub_delivery_loop: true },
      AGENT_CLAIM,
    );
    expect(claim.status).toBe(403);
    expect(south().hub_delivery_loop).toBe(false);
    // "As everywhere" and an empty addition clear the project's own.
    await post("/api/workspaces/settings", {
      workspace: "south",
      hub_delivery_loop: null,
      hub_delivery_loop_extra: "",
    });
    expect(south().hub_delivery_loop).toBeUndefined();
    expect(south().hub_delivery_loop_extra).toBeUndefined();
  });
});
