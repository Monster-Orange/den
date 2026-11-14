/**
 * 0.4.45-dev.3: `hub_editions` in the distribution's den.yml (beside
 * `product:`), as the CHANGELOG and docs/distributions.md say, reaches
 * GET /api/hub's `editions`. The line is in the flow form a distribution
 * writes; dev.2 read only the team config file (config/<product>.yml) and
 * showed nothing. Invented hosts only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer;

beforeAll(async () => {
  s = await startAgentsPageServer();
  const yml = path.join(s.tmp, "dist", "den.yml");
  fs.writeFileSync(
    yml,
    fs.readFileSync(yml, "utf-8") +
      "\nhub_editions: { teams_host: hub.example.test, enterprise_domain: example.test, talk_url: https://example.test/den#enterprise, teams_note: Closed beta by invite. }\n",
  );
}, 90_000);

afterAll(async () => {
  await s?.stop();
});

describe("GET /api/hub: the editions from den.yml", () => {
  it("names them from den.yml's hub_editions", async () => {
    const r = await fetch(`${s.base}/api/hub`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { editions?: unknown }).editions).toEqual({
      teamsHost: "hub.example.test",
      enterpriseDomain: "example.test",
      talkUrl: "https://example.test/den#enterprise",
      teamsNote: "Closed beta by invite.",
    });
  });
});
