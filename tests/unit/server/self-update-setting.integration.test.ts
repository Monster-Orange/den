/**
 * SRV-P6 (0.4.48): Settings › Server › New versions sets
 * server_agent.self_update (user.yml), ask or auto. Only a person sets it:
 * an agent's claim is refused (auto lets Den update itself unasked). null
 * is ask, written down, and a value set here no longer says it came from
 * the team file.
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

describe("SRV-P6: Settings › New versions", () => {
  it("ask at first; a person sets auto, it lands in user.yml, and GET shows it", async () => {
    const first = await s.settingsGet();
    expect(first.server_agent_self_update).toBe("ask");
    // Where it came from (Den's first start wrote ask to user.yml), and
    // the update checks.
    expect(first.server_agent_self_update_from).toBe("user");
    expect(first).toHaveProperty("update_check");
    expect(await s.settings({ server_agent_self_update: "auto" })).toBe(200);
    expect(userYml()).toMatch(
      /server_agent:\n(?:\s+.*\n)*?\s+self_update: auto/,
    );
    expect(userYml()).not.toContain("self_update_from");
    expect((await s.settingsGet()).server_agent_self_update).toBe("auto");
    expect((await s.settingsGet()).server_agent_self_update_from).toBe("user");
  });

  it("an agent's claim is refused; a bad value is refused; null is ask", async () => {
    const r = await fetch(`${s.base}/api/settings`, {
      method: "POST",
      headers: {
        ...denAuth(s.stateDir),
        "content-type": "application/json",
        "x-den-actor": "agent",
        "x-den-mcp-agent": "agent:planner",
      },
      body: JSON.stringify({ server_agent_self_update: "ask" }),
    });
    expect(r.status).toBe(403);
    expect((await s.settingsGet()).server_agent_self_update).toBe("auto");
    expect(await s.settings({ server_agent_self_update: "always" })).toBe(400);
    expect(await s.settings({ server_agent_self_update: null })).toBe(200);
    expect((await s.settingsGet()).server_agent_self_update).toBe("ask");
    expect(userYml()).toMatch(/self_update: ask/);
  });
});
