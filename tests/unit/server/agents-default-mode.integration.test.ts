/**
 * 0.4.46 MODE-UI: the install's mode for every agent, set once in Settings
 * (/api/settings `agents_default_mode`, user.yml agents.default_mode).
 * Only a person sets it: an agent's claim is refused (it could widen
 * every agent's mode). A bad mode is refused; null clears it.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
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

const userYml = () =>
  fs.readFileSync(
    path.join(s.tmp, "dist", "config", "local", "user.yml"),
    "utf-8",
  );

describe("0.4.46: Settings › the agents' mode", () => {
  it("unset at first; a person sets it, it lands in user.yml, and GET shows it", async () => {
    expect((await s.settingsGet()).agents_default_mode).toBeNull();
    expect(await s.settings({ agents_default_mode: "auto" })).toBe(200);
    expect(userYml()).toMatch(/agents:\n(?:\s+.*\n)*?\s+default_mode: auto/);
    expect((await s.settingsGet()).agents_default_mode).toBe("auto");
  });

  it("an agent's claim is refused; a bad mode is refused; null clears it", async () => {
    const r = await fetch(`${s.base}/api/settings`, {
      method: "POST",
      headers: {
        ...denAuth(s.stateDir),
        "content-type": "application/json",
        "x-den-actor": "agent",
        "x-den-mcp-agent": "agent:planner",
      },
      body: JSON.stringify({ agents_default_mode: "all" }),
    });
    expect(r.status).toBe(403);
    expect((await s.settingsGet()).agents_default_mode).toBe("auto");
    expect(await s.settings({ agents_default_mode: "yolo" })).toBe(400);
    expect(await s.settings({ agents_default_mode: null })).toBe(200);
    expect((await s.settingsGet()).agents_default_mode).toBeNull();
    expect(userYml()).not.toContain("default_mode");
  });
});
