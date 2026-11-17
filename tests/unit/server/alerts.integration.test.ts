/**
 * Issue 172 on the real server: an agent's wait (its own token says so)
 * and its write held for the person's Allow each put one alert in the
 * feed an open tab reads (GET /api/alerts), in the bell's words, linking
 * to the agent; never the tool line or the write's summary. An agent
 * can't read the person's alerts.
 * The demo distribution, the scripted PTY. Invented names only.
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
  s.made.at(-1)!.emit("> ");
}, 90_000);
afterAll(async () => {
  await s?.stop();
});

async function call(
  method: string,
  p: string,
  body?: unknown,
  as: "person" | "agent" = "person",
) {
  const r = await fetch(`${s.base}${p}`, {
    method,
    headers: {
      ...(as === "person"
        ? denAuth(s.stateDir)
        : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

type A = { body: string; link: string; why: string; title: string };

describe("issue 172: alerts on the real server", () => {
  it("a wait and a held write each alert once; an agent can't read them", async () => {
    const first = await call("GET", "/api/alerts");
    expect(first.status).toBe(200);
    expect(first.json.alerts).toEqual([]);
    const seq = first.json.seq as number;

    expect(
      (
        await call(
          "POST",
          "/api/agents/self/attention",
          {
            event: "waiting",
            why: "permission",
            what: "Bash: curl -H 'x-key: sk-live-9'",
            hooked: true,
          },
          "agent",
        )
      ).status,
    ).toBe(200);
    // The held write: the agent asks for the person's Allow.
    const held = await call(
      "POST",
      "/api/approvals",
      {
        action: "workspace_create",
        args: { name: "southward" },
        ask: true,
        note: "the person should pick",
      },
      "agent",
    );
    expect(held.status).toBe(202);

    const got = await call("GET", `/api/alerts?after=${seq}`);
    const alerts = got.json.alerts as A[];
    expect(alerts.map((a) => [a.why, a.body, a.link])).toEqual([
      [
        "permission",
        "planner needs your permission",
        "/agents?project=north&agent=planner",
      ],
      [
        "allow",
        "planner needs your Allow",
        "/agents?project=north&agent=planner",
      ],
    ]);
    const text = JSON.stringify(alerts);
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("southward");
    expect(alerts[0].title).toBeTruthy();

    const byAgent = await call("GET", "/api/alerts", undefined, "agent");
    expect(byAgent.status).toBe(403);
  }, 60_000);
});
