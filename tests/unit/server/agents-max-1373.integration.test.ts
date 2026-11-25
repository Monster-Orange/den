/**
 * Issue 1373 on a real server: user.yml's agents.max_concurrent is the cap
 * the server reports for a project's agents (the count the Agents page
 * shows) and what Settings reads, over the distribution's den.yml. A
 * person's save (Settings › Agents › Agents at once) lands in user.yml;
 * an agent's claim is refused before anything is written.
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
let denYml = "";
let userYml = "";
let denYmlBefore = "";
beforeAll(async () => {
  s = await startAgentsPageServer();
  denYml = path.join(s.tmp, "dist", "config", "acme.yml");
  userYml = path.join(s.tmp, "dist", "config", "local", "user.yml");
  denYmlBefore = fs.readFileSync(denYml, "utf-8");
  // The distribution's cap: 8.
  const d = (yaml.parse(denYmlBefore) ?? {}) as Record<string, unknown>;
  d.agents = { ...((d.agents as object) ?? {}), max_concurrent: 8 };
  fs.writeFileSync(denYml, yaml.stringify(d));
}, 60_000);
afterAll(async () => {
  if (denYml) fs.writeFileSync(denYml, denYmlBefore);
  await s?.stop();
});

const userAgents = () =>
  ((
    (yaml.parse(
      fs.existsSync(userYml) ? fs.readFileSync(userYml, "utf-8") : "",
    ) ?? {}) as Record<string, unknown>
  ).agents ?? {}) as Record<string, unknown>;

async function cap(): Promise<unknown> {
  const r = await fetch(`${s.base}/api/workspaces/north/agents`, {
    headers: denAuth(s.stateDir),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { maxConcurrent?: unknown }).maxConcurrent;
}
const settingsCap = async () =>
  ((await s.settingsGet()).agents_limits as { max_concurrent?: unknown })
    ?.max_concurrent;

async function post(
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${s.base}/api/settings`, {
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

describe("issue 1373: user.yml's agents.max_concurrent is the cap in force", () => {
  it("den.yml alone: its 8", async () => {
    expect(await cap()).toBe(8);
    expect(await settingsCap()).toBe(8);
  });

  it("a person's save of 14 lands in user.yml and wins, on the page and in Settings", async () => {
    const r = await post({ agents_limits: { max_concurrent: 14 } });
    expect(r.status).toBe(200);
    expect(userAgents().max_concurrent).toBe(14);
    expect(await cap()).toBe(14);
    expect(await settingsCap()).toBe(14);
  });

  it("a value out of range is refused, and nothing is written", async () => {
    const r = await post({ agents_limits: { max_concurrent: 0 } });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/agents\.max_concurrent/);
    expect(userAgents().max_concurrent).toBe(14);
  });

  it("an agent's claim is refused before anything is written", async () => {
    const r = await post(
      { agents_limits: { max_concurrent: 40 } },
      { "x-den-actor": "agent", "x-den-mcp-agent": "agent:planner" },
    );
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/agents_limits/);
    expect(userAgents().max_concurrent).toBe(14);
  });

  it("cleared: den.yml's 8 again", async () => {
    const r = await post({ agents_limits: { max_concurrent: null } });
    expect(r.status).toBe(200);
    expect(userAgents().max_concurrent).toBeUndefined();
    expect(await cap()).toBe(8);
  });
});
