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
const southAgents = () =>
  (
    local("workspaces.yml").workspaces as Record<
      string,
      { agents?: Record<string, unknown> }
    >
  ).south.agents;

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
const settings = () =>
  fetch(`${s.base}/api/workspaces/settings?workspace=south`, {
    headers: denAuth(s.stateDir),
  }).then((x) => x.json() as Promise<Record<string, unknown>>);
const setOwn = (v: unknown, extra?: Record<string, string>) =>
  post(
    "/api/workspaces/settings",
    { workspace: "south", agents_max_per_project: v },
    extra,
  );

describe("issue 1634: a project's own agent cap, in Project setup", () => {
  it("unset by default; a person sets it in workspaces.yml and clears it", async () => {
    expect((await settings()).agents_max_per_project).toBeNull();
    expect((await setOwn(2)).status).toBe(200);
    expect(southAgents()?.max_per_project).toBe(2);
    expect((await settings()).agents_max_per_project).toBe(2);
    expect((await setOwn(null)).status).toBe(200);
    expect(southAgents()?.max_per_project).toBeUndefined();
    expect((await settings()).agents_max_per_project).toBeNull();
  });

  it("a bad value is refused by its key", async () => {
    for (const bad of [-1, 2.5, "3"]) {
      const r = await setOwn(bad);
      expect(r.status).toBe(400);
      expect(String(r.json.error)).toMatch(
        /workspaces\.south\.agents\.max_per_project/,
      );
    }
    expect(southAgents()?.max_per_project).toBeUndefined();
  });

  it("it can only lower the install's", async () => {
    expect(
      (await post("/api/settings", { agents_limits: { max_per_project: 3 } }))
        .status,
    ).toBe(200);
    const r = await setOwn(5);
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/agents\.max_per_project is 3/);
    expect((await setOwn(3)).status).toBe(200);
    await setOwn(null);
    await post("/api/settings", { agents_limits: { max_per_project: null } });
  });

  it("a person's only: an agent asks with project_agent_cap", async () => {
    const r = await setOwn(1, AGENT_CLAIM);
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/project_agent_cap/);
    expect(southAgents()?.max_per_project).toBeUndefined();
  });
});
