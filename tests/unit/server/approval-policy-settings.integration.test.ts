/**
 * Issue 160 (0.4.65): Settings rows for the approval policy, the install's
 * (POST /api/settings approvals_*: user.yml approvals) and a project's
 * (POST /api/workspaces/settings approvals_*: workspaces.yml
 * <project>.approvals). Permissive defaults: notify, nothing watched,
 * nothing on the critical list. Only a person changes the policy: an
 * agent's claim is refused at both routes (an agent asks with the held
 * write approval_policy: approval-policy.test.ts).
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
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
  yaml.parse(
    fs.readFileSync(path.join(s.tmp, "dist", "config", "local", f), "utf-8"),
  ) as Record<string, unknown>;

const AGENT_CLAIM = {
  "x-den-actor": "agent",
  "x-den-mcp-agent": "agent:planner",
};

async function wsPost(
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${s.base}/api/workspaces/settings`, {
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
    json: (await r.json()) as Record<string, unknown>,
  };
}

describe("issue 160: Settings › the approval policy", () => {
  it("the install's: permissive defaults; a person sets it; it lands in user.yml", async () => {
    const first = await s.settingsGet();
    expect([
      first.approvals_policy,
      first.approvals_watch,
      first.approvals_critical,
    ]).toEqual([null, [], []]);
    expect(
      await s.settings({
        approvals_policy: "auto",
        approvals_watch: "repo:notes, project:south",
        approvals_critical: ["repo_clone"],
      }),
    ).toBe(200);
    expect(local("user.yml").approvals).toEqual({
      policy: "auto",
      watch: ["repo:notes", "project:south"],
      critical: ["repo_clone"],
    });
    const now = await s.settingsGet();
    expect(now.approvals_watch).toEqual(["repo:notes", "project:south"]);
    // A bad value is refused, naming the key; null clears.
    expect(await s.settings({ approvals_policy: "always" })).toBe(400);
    expect(await s.settings({ approvals_critical: ["Not A Kind"] })).toBe(400);
    expect(
      await s.settings({ approvals_watch: null, approvals_critical: null }),
    ).toBe(200);
    expect(local("user.yml").approvals).toEqual({ policy: "auto" });
  });

  it("an agent's claim to change the install's policy is refused", async () => {
    const r = await fetch(`${s.base}/api/settings`, {
      method: "POST",
      headers: {
        ...denAuth(s.stateDir),
        "content-type": "application/json",
        ...AGENT_CLAIM,
      },
      body: JSON.stringify({ approvals_policy: "ask" }),
    });
    expect(r.status).toBe(403);
    expect((await s.settingsGet()).approvals_policy).toBe("auto");
  });

  it("a project's: set from its Settings rows into workspaces.yml; an agent's claim is refused", async () => {
    const r = await wsPost({
      workspace: "south",
      approvals_policy: "ask",
      approvals_watch: "service:blog/web",
      approvals_critical: "service_try",
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      approvals_policy: "ask",
      approvals_watch: ["service:blog/web"],
      approvals_critical: ["service_try"],
    });
    const south = (
      local("workspaces.yml").workspaces as Record<
        string,
        Record<string, unknown>
      >
    ).south;
    expect(south.approvals).toEqual({
      policy: "ask",
      watch: ["service:blog/web"],
      critical: ["service_try"],
    });
    const got = await fetch(
      `${s.base}/api/workspaces/settings?workspace=south`,
      { headers: denAuth(s.stateDir) },
    ).then((x) => x.json() as Promise<Record<string, unknown>>);
    expect(got.approvals_policy).toBe("ask");
    // "As everywhere" (null) clears the project's own policy.
    expect(
      (await wsPost({ workspace: "south", approvals_policy: null })).json
        .approvals_policy,
    ).toBeNull();
    // An agent's claim: refused, nothing written.
    const claim = await wsPost(
      { workspace: "south", approvals_policy: "auto" },
      AGENT_CLAIM,
    );
    expect(claim.status).toBe(403);
    expect(
      (
        (
          local("workspaces.yml").workspaces as Record<
            string,
            Record<string, unknown>
          >
        ).south.approvals as Record<string, unknown>
      ).policy,
    ).toBeUndefined();
  });
});
