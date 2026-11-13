/**
 * NT-1 / NT-3 / NT-3b on the real server: an agent's own token says it
 * waits; the bell has it, grouped by project; the agents list marks it
 * waiting; its output moving clears both; the turn's end is "finished".
 * A person can't say an agent waits; an agent can't change the bell.
 * ask_human's question is the bell's text; past notifications.asks_per_hour
 * the next one is held back (429).
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
let agentToken = "";

beforeAll(async () => {
  // ask_human's limit, low enough to reach.
  s = await startAgentsPageServer({
    userYml: "notifications:\n  asks_per_hour: 2\n",
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

const planner = async () =>
  (
    (await call("GET", "/api/sessions?ws=north")).json.sessions as Record<
      string,
      unknown
    >[]
  ).find((r) => r.agent === "planner");

describe("NT: the bell on the real server", () => {
  it("an agent says it waits: the bell has it, its row says waiting", async () => {
    const start = await call("POST", "/api/workspaces/north/agents", {
      persona: "planner",
    });
    expect(start.status).toBe(200);
    const pty = s.made.at(-1)!;
    agentToken = actorTokenOf(pty.opts.env) ?? "";
    expect(agentToken).toBeTruthy();
    pty.emit("> ");
    await new Promise((r) => setTimeout(r, 300));
    const said = await call(
      "POST",
      "/api/agents/self/attention",
      { event: "waiting", why: "permission" },
      "agent",
    );
    expect(said.status).toBe(200);
    const bell = await call("GET", "/api/notifications");
    expect(bell.json.unread).toBe(1);
    const g = bell.json.groups as {
      scope: string;
      subjects: { subject: string; items: { text: string; link: string }[] }[];
    }[];
    expect(g[0].scope).toBe("workspace/north");
    expect(g[0].subjects[0].subject).toBe("agent:planner");
    expect(g[0].subjects[0].items[0].text).toMatch(/needs your permission$/);
    expect(g[0].subjects[0].items[0].link).toBe(
      "/agents?project=north&agent=planner",
    );
    expect((await planner())?.waiting).toBe(true);
    // NT-3b: and why.
    expect((await planner())?.waitingWhy).toBe("permission");
  }, 60_000);

  it("the 0.4.41 gate: its output moving doesn't clear it (Claude Code redraws its prompt); its next hook does", async () => {
    s.made.at(-1)!.emit("\x1b[2K> Do you want to proceed?\r\n");
    // Longer than the 2 s check and the settle time.
    await new Promise((r) => setTimeout(r, 5000));
    expect((await planner())?.waiting).toBe(true);
    expect(
      (
        await call(
          "POST",
          "/api/agents/self/attention",
          { event: "resumed", from: "tool", hooked: true },
          "agent",
        )
      ).status,
    ).toBe(200);
    expect((await planner())?.waiting).not.toBe(true);
    expect((await call("GET", "/api/notifications")).json.unread).toBe(0);
  }, 30_000);

  it("the turn's end: finished; mark read, then clear", async () => {
    await call(
      "POST",
      "/api/agents/self/attention",
      { event: "finished" },
      "agent",
    );
    const bell = await call("GET", "/api/notifications");
    expect(bell.json.unread).toBe(1);
    expect(
      (await call("POST", "/api/notifications/read", { all: true })).json,
    ).toMatchObject({ ok: true, changed: 1, unread: 0 });
    expect(
      (await call("POST", "/api/notifications/clear", {})).json,
    ).toMatchObject({ ok: true, changed: 1 });
  }, 30_000);

  it("a person can't say an agent waits; an agent can't change the bell", async () => {
    expect(
      (
        await call("POST", "/api/agents/self/attention", {
          event: "waiting",
          why: "input",
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("POST", "/api/notifications/read", { all: true }, "agent"))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          "POST",
          "/api/agents/self/attention",
          { event: "nope" },
          "agent",
        )
      ).status,
    ).toBe(400);
  }, 30_000);

  it("ask_human: the question is in the bell; past the limit, held back", async () => {
    await call("POST", "/api/notifications/clear", {});
    const ask = (text: string) =>
      call(
        "POST",
        "/api/agents/self/attention",
        { event: "waiting", why: "asked", text },
        "agent",
      );
    expect((await ask("Ship the north fix today?")).status).toBe(200);
    const g = (await call("GET", "/api/notifications")).json.groups as {
      subjects: { items: { text: string }[] }[];
    }[];
    expect(g[0].subjects[0].items[0].text).toMatch(
      /asked: Ship the north fix today\?$/,
    );
    expect((await planner())?.waitingWhy).toBe("asked");
    expect((await ask("And the south one?")).status).toBe(200);
    const held = await ask("A third?");
    expect(held.status).toBe(429);
    expect(held.json.code).toBe("ask_limit");
    // Other signals aren't limited.
    expect(
      (
        await call(
          "POST",
          "/api/agents/self/attention",
          { event: "waiting", why: "input" },
          "agent",
        )
      ).status,
    ).toBe(200);
    await call("POST", "/api/notifications/read", { all: true });
    await call("POST", "/api/notifications/clear", {});
  }, 30_000);

  it("muted: nothing new for that agent", async () => {
    expect(
      (
        await call("POST", "/api/notifications/mute", {
          target: "agent:planner",
          minutes: 30,
        })
      ).status,
    ).toBe(200);
    await call(
      "POST",
      "/api/agents/self/attention",
      { event: "waiting", why: "input" },
      "agent",
    );
    expect((await call("GET", "/api/notifications")).json.unread).toBe(0);
  }, 30_000);
});
