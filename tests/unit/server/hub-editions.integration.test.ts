/**
 * 0.4.45: the Hub editions reach Settings from the distribution's own
 * config: den.yml (here acme.yml) `hub_editions`, through GET /api/hub's
 * `editions`. The config reader keeps the key (it drops keys it doesn't
 * list). Invented hosts only.
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
  const yml = path.join(s.tmp, "dist", "config", "acme.yml");
  fs.writeFileSync(
    yml,
    fs.readFileSync(yml, "utf-8") +
      "\nhub_editions:\n  teams_host: hub.example.test\n  enterprise_domain: example.test\n  talk_url: https://example.test/den#enterprise\n",
  );
}, 90_000);

afterAll(async () => {
  await s?.stop();
});

describe("GET /api/hub: the editions", () => {
  it("names them from the config file", async () => {
    const r = await fetch(`${s.base}/api/hub`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { editions?: unknown }).editions).toEqual({
      teamsHost: "hub.example.test",
      enterpriseDomain: "example.test",
      talkUrl: "https://example.test/den#enterprise",
    });
  });
});
