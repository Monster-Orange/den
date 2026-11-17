/**
 * Issue 327: a wait never outlives its agent. On a live gate an agent's
 * "needs your permission" stayed in the bell and /api/notifications a
 * minute and more after `agents stop`. Stopped or removed: its wait and
 * its bell row go at once. Its session ending by itself ends a dialog;
 * an ask_human question stays (Den holds it for a resume) until the agent
 * is stopped or removed.
 * The real server on the demo distribution, the scripted PTY. Invented
 * names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

let s: AgentsPageServer;

beforeAll(async () => {
  s = await startAgentsPageServer();
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, p: string, body?: unknown, token = "") {
  const r = await fetch(`${s.base}${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : denAuth(s.stateDir)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** What the bell says about agent `id`: its wait, and its rows. */
async function bellFor(id: string) {
  const { json } = await call("GET", "/api/notifications");
  const waiting = (json.waiting as { agent: string; why: string }[]).find(
    (w) => w.agent === id,
  );
  const groups = json.groups as {
    subjects: { subject: string; items: { text: string }[] }[];
  }[];
  const rows = groups
    .flatMap((g) => g.subjects)
    .filter((x) => x.subject === `agent:${id}`)
    .flatMap((x) => x.items.map((i) => i.text));
  return { why: waiting?.why ?? null, rows };
}

/** Agent `id` runs (started, or resumed) and says it waits on `why`. */
async function waits(
  id: string,
  how: "start" | "resume",
  why: "permission" | "asked",
) {
  const r =
    how === "start"
      ? await call("POST", "/api/workspaces/north/agents", { persona: id })
      : await call("POST", `/api/workspaces/north/agents/${id}/resume`);
  expect(r.status).toBe(200);
  const pty = s.made.at(-1)!;
  const token = actorTokenOf(pty.opts.env) ?? "";
  expect(token).toBeTruthy();
  pty.emit("> ");
  await pause(300);
  const said = await call(
    "POST",
    "/api/agents/self/attention",
    why === "asked"
      ? { event: "waiting", why, text: "Ship the north fix?", hooked: true }
      : { event: "waiting", why, what: "Bash", hooked: true },
    token,
  );
  expect(said.status).toBe(200);
  expect((await bellFor(id)).why).toBe(why);
  expect((await bellFor(id)).rows).toHaveLength(1);
  return pty;
}

describe("issue 327: a wait never outlives its agent", () => {
  it("stopped: its permission wait and its bell row go at once", async () => {
    const pty = await waits("planner", "start", "permission");
    // TERM ends the session soon after, as it would.
    const stop = call("POST", "/api/workspaces/north/agents/planner/stop");
    setTimeout(() => pty.exit(0), 300);
    expect((await stop).status).toBe(200);
    expect(await bellFor("planner")).toEqual({ why: null, rows: [] });
  }, 60_000);

  it("its session ends by itself: its permission wait goes", async () => {
    const pty = await waits("planner", "resume", "permission");
    pty.exit(0);
    // The server's 2 s check, twice over.
    await pause(5000);
    expect(await bellFor("planner")).toEqual({ why: null, rows: [] });
  }, 60_000);

  it("an ask stays when its session ends by itself; removed, it goes at once", async () => {
    const pty = await waits("reviewer", "start", "asked");
    pty.exit(0);
    await pause(5000);
    expect((await bellFor("reviewer")).why).toBe("asked");
    const rm = await call(
      "POST",
      "/api/workspaces/north/agents/reviewer/remove",
    );
    expect(rm.status).toBe(200);
    expect(await bellFor("reviewer")).toEqual({ why: null, rows: [] });
  }, 60_000);
});
