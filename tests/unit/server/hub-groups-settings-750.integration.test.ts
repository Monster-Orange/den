/**
 * Issue 750: Settings › Hub › Groups from Hub (POST /api/settings
 * hub_groups) is a person's setting, like the other Settings › Hub rows:
 * an agent's claim, or the fixture person's, is refused before anything
 * is written (PERSON_ONLY_SETTINGS; FIXTURE_PAGE_SETTINGS doesn't name
 * it). A person's save lands in user.yml as every Den reads it: on and
 * off as true and false, auto as no key.
 *
 * The demo distribution in a temp folder. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import {
  FIXTURE_PAGE_SETTINGS,
  PERSON_ONLY_SETTINGS,
} from "../../../src/shared/settings-cli-rows.js";
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

const hubBlock = () =>
  ((
    (yaml.parse(
      fs.readFileSync(
        path.join(s.tmp, "dist", "config", "local", "user.yml"),
        "utf-8",
      ),
    ) ?? {}) as Record<string, unknown>
  ).hub ?? {}) as Record<string, unknown>;

const AGENT_CLAIM = {
  "x-den-actor": "agent",
  "x-den-mcp-agent": "agent:planner",
};

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
const settings = () =>
  fetch(`${s.base}/api/settings`, { headers: denAuth(s.stateDir) }).then(
    (x) => x.json() as Promise<Record<string, unknown>>,
  );

describe("issue 750: Groups from Hub is a person's setting", () => {
  it("is person-only, and not one of the fixture person's page settings", () => {
    expect(PERSON_ONLY_SETTINGS).toContain("hub_groups");
    expect(FIXTURE_PAGE_SETTINGS).not.toContain("hub_groups");
  });

  it("a person's save lands in user.yml; Settings reads it back", async () => {
    expect((await settings()).hub_groups).toEqual({
      mode: "auto",
      cache_seconds: 30,
    });
    let r = await post({ hub_groups: { mode: "on", cache_seconds: 90 } });
    expect(r.status).toBe(200);
    expect(hubBlock()).toMatchObject({
      groups: true,
      groups_cache_seconds: 90,
    });
    expect((await settings()).hub_groups).toEqual({
      mode: "on",
      cache_seconds: 90,
    });
    r = await post({ hub_groups: { mode: "off" } });
    expect(hubBlock().groups).toBe(false);
    r = await post({ hub_groups: { mode: null, cache_seconds: null } });
    expect(r.status).toBe(200);
    expect(hubBlock().groups).toBeUndefined();
    expect(hubBlock().groups_cache_seconds).toBeUndefined();
  });

  it("a value out of range is refused, and nothing is written", async () => {
    const before = JSON.stringify(hubBlock());
    const r = await post({ hub_groups: { cache_seconds: 4 } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(hubBlock())).toBe(before);
  });

  it("an agent's claim is refused before anything is written", async () => {
    await post({ hub_groups: { mode: "off" } });
    const claim = await post({ hub_groups: { mode: "on" } }, AGENT_CLAIM);
    expect(claim.status).toBe(403);
    expect(String(claim.json.error)).toMatch(/only a person can change/);
    expect(String(claim.json.error)).toMatch(/hub_groups/);
    expect(hubBlock().groups).toBe(false);
  });
});
