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
let userYml = "";
beforeAll(async () => {
  s = await startAgentsPageServer();
  userYml = path.join(s.tmp, "dist", "config", "local", "user.yml");
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

const userAgents = () =>
  ((
    (yaml.parse(
      fs.existsSync(userYml) ? fs.readFileSync(userYml, "utf-8") : "",
    ) ?? {}) as Record<string, unknown>
  ).agents ?? {}) as Record<string, unknown>;

const limits = async () =>
  (await s.settingsGet()).agents_limits as Record<string, unknown>;

async function post(
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${s.base}/api/settings`, {
    method: "POST",
    headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

describe("issue 1631: Settings reads and saves the two subagent limits", () => {
  it("unset: twice the agents at once, and the load hold respected", async () => {
    const l = await limits();
    expect(typeof l.max_concurrent).toBe("number");
    expect(l.max_subagents).toBe(2 * (l.max_concurrent as number));
    expect(l.subagents_respect_load_hold).toBe(true);
  });

  it("a person's save lands in user.yml and is read back", async () => {
    const r = await post({
      agents_limits: { max_subagents: 12, subagents_respect_load_hold: false },
    });
    expect(r.status).toBe(200);
    expect(userAgents().max_subagents).toBe(12);
    expect(userAgents().subagents_respect_load_hold).toBe(false);
    const l = await limits();
    expect(l.max_subagents).toBe(12);
    expect(l.subagents_respect_load_hold).toBe(false);
  });

  it("a bad value is refused, naming the setting, and nothing is written", async () => {
    const a = await post({ agents_limits: { max_subagents: 0 } });
    expect(a.status).toBe(400);
    expect(String(a.json.error)).toMatch(/agents\.max_subagents/);
    const b = await post({
      agents_limits: { subagents_respect_load_hold: "no" },
    });
    expect(b.status).toBe(400);
    expect(String(b.json.error)).toMatch(/agents\.subagents_respect_load_hold/);
    expect(userAgents().max_subagents).toBe(12);
    expect(userAgents().subagents_respect_load_hold).toBe(false);
  });

  it("cleared: back to the defaults", async () => {
    const r = await post({
      agents_limits: { max_subagents: null, subagents_respect_load_hold: null },
    });
    expect(r.status).toBe(200);
    expect(userAgents().max_subagents).toBeUndefined();
    const l = await limits();
    expect(l.max_subagents).toBe(2 * (l.max_concurrent as number));
    expect(l.subagents_respect_load_hold).toBe(true);
  });
});
