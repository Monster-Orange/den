/**
 * An agent's own token, on the real server, against writes that are a
 * person's (agent-write-routes.test.ts walks them all): each is refused
 * before its handler runs, and nothing changes. Service exec runs only
 * up, down or restart on local for it.
 *
 * The demo distribution (helpers/agents-page-server.ts), its PTY a fake.
 * Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

let s: AgentsPageServer;
let token = "";

beforeAll(async () => {
  s = await startAgentsPageServer();
  const r = await fetch(`${s.base}/api/workspaces/north/agents`, {
    method: "POST",
    headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
    body: JSON.stringify({ persona: "planner" }),
  });
  expect(r.status).toBe(200);
  token = actorTokenOf(s.made.at(-1)!.opts.env) ?? "";
  expect(token).toBeTruthy();
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

const asAgent = (method: string, p: string, body?: unknown) =>
  fetch(`${s.base}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("an agent's token and a person's writes, on the real server", () => {
  it("its token works where an agent may write", async () => {
    const r = await asAgent("POST", "/api/agents/self/attention", {
      event: "waiting",
      why: "permission",
    });
    expect(r.status).toBe(200);
  });

  it("a person's writes are refused before their handler, and change nothing", async () => {
    const before = await s.settingsGet();
    for (const [method, p, body] of [
      ["POST", "/api/approvals/abcdefghijklmnop/decide", { allow: true }],
      ["POST", "/api/settings", { cli_tabs: true }],
      ["POST", "/api/workspaces/north/agents/someone/stop", {}],
      ["POST", "/api/workspaces/rename", { from: "north", to: "south" }],
      ["POST", "/api/notifications/clear", {}],
      ["POST", "/api/hub/disconnect", {}],
      ["PUT", "/api/release/config", {}],
      ["GET", "/api/workspace/exec?ws=north&cmd=up", undefined],
    ] as const) {
      const r = await asAgent(method, p, body);
      const j = (await r.json()) as { error?: string };
      expect([method, p, r.status]).toEqual([method, p, 403]);
      expect([p, j.error]).toEqual([p, expect.stringMatching(/a person's/)]);
    }
    expect(await s.settingsGet()).toEqual(before);
  });

  it("service exec: only up, down or restart, on local", async () => {
    for (const q of [
      "repo=acme&service=api&cmd=migrate&env=local",
      "repo=acme&service=api&cmd=up&env=prod",
    ]) {
      const r = await asAgent("GET", `/api/service/exec?${q}`);
      expect([q, r.status]).toEqual([q, 403]);
      expect([q, ((await r.json()) as { error: string }).error]).toEqual([
        q,
        expect.stringMatching(/only/),
      ]);
    }
  });
});
