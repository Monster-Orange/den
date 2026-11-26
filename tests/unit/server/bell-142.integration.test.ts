/**
 * Issue 142 on the real server, as the 11-18 repro ran it: the person's
 * page shows the agent (POST /api/notifications/looking, as the agents
 * page does every 4 s), and the agent's turn-end hook posts exactly what
 * attention-hook.ts makes of Claude Code's Stop input.
 *   1. A turn ending on a question: a counted needs item.
 *   2. A plain turn end, "finished" on: an item under Updates, not counted.
 *   3. Opening the agent: its Updates items go, and the count drops.
 * The demo distribution, the scripted PTY. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";
import { attentionOf } from "../../../src/shared/agents/guardrails/attention-hook.js";

let s: AgentsPageServer;
let agentToken = "";

beforeAll(async () => {
  // As the test install had it: finished on, a low ask limit.
  s = await startAgentsPageServer({
    userYml:
      "notifications:\n  asks_per_hour: 2\n  kinds:\n    finished: true\n",
  });
}, 60_000);
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
        : { authorization: `Bearer ${agentToken}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** Claude Code's Stop input, through the hook: what Den is POSTed. */
const turnEnd = (last: string) =>
  call(
    "POST",
    "/api/agents/self/attention",
    attentionOf({
      session_id: "0b7c2c3e-1111-4222-8333-944445555666",
      transcript_path: "/nonexistent/den-142/t.jsonl",
      cwd: "/nonexistent/den-142",
      permission_mode: "default",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: last,
    }),
    "agent",
  );

const looking = () =>
  call("POST", "/api/notifications/looking", { agents: ["planner"] });

type Groups = { subjects: { subject: string; items: { read: boolean }[] }[] }[];
const mine = (g: unknown) =>
  ((g ?? []) as Groups)
    .flatMap((x) => x.subjects)
    .filter((x) => x.subject === "agent:planner")
    .flatMap((x) => x.items);

describe("issue 142 on the real server", () => {
  it("clause 1: a turn ending on a question, while the page showed it, counts", async () => {
    const start = await call("POST", "/api/workspaces/north/agents", {
      persona: "planner",
    });
    expect(start.status).toBe(200);
    agentToken = actorTokenOf(s.made.at(-1)!.opts.env) ?? "";
    expect(agentToken).toBeTruthy();
    expect((await looking()).status).toBe(200);
    expect(
      (await turnEnd("Built it.\n\nShall I merge the branch now?")).status,
    ).toBe(200);
    const b = (await call("GET", "/api/notifications")).json;
    expect(b.waiting).toEqual([
      expect.objectContaining({ agent: "planner", why: "asked" }),
    ]);
    expect(mine(b.groups).filter((n) => !n.read)).toHaveLength(1);
    expect(b.unread).toBe(1);
    // The page shows it on: a need stays until answered.
    await looking();
    expect((await call("GET", "/api/notifications")).json.unread).toBe(1);
    // The person answers (a prompt, past RESUME_AFTER_MS): it goes.
    await new Promise((r) => setTimeout(r, 1100));
    await call(
      "POST",
      "/api/agents/self/attention",
      { event: "resumed", from: "prompt" },
      "agent",
    );
    expect((await call("GET", "/api/notifications")).json.unread).toBe(0);
  }, 60_000);

  it("clause 2: a plain turn end, page just closed, shows once, in Done (no badge; issue 773)", async () => {
    await looking();
    expect((await turnEnd("Noted.")).status).toBe(200);
    const b = (await call("GET", "/api/notifications")).json;
    expect(b.unread).toBe(0);
    expect(b.waiting).toEqual([]);
    expect(b.done).toEqual([expect.objectContaining({ agent: "planner" })]);
    expect(mine((b.updates as { groups: unknown }).groups)).toHaveLength(0);
    expect(b.updates).toMatchObject({ count: 0, unread: 0 });
  }, 30_000);

  it("clause 3: opening the agent removes its Updates items, and the count drops", async () => {
    await looking();
    const b = (await call("GET", "/api/notifications")).json;
    expect(mine((b.updates as { groups: unknown }).groups)).toHaveLength(0);
    expect(b.updates).toMatchObject({ count: 0 });
  }, 30_000);
});
