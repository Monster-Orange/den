/**
 * The page's Close for a shell: POST /api/sessions/<id>/close stops a
 * plain session the way closing a terminal does (HUP, then KILL after
 * sessions.close_grace_seconds) and forgets it, so closing tabs never
 * fills sessions.max_concurrent. An agent's session is refused (Stop is
 * its way); an agent's token is refused. The demo distribution,
 * the scripted PTY. Invented names only.
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

async function call(
  method: string,
  p: string,
  token?: string,
  body: unknown = {},
) {
  const r = await fetch(`${s.base}${p}`, {
    method,
    headers: token
      ? { authorization: `Bearer ${token}`, "content-type": "application/json" }
      : { ...denAuth(s.stateDir), "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const listed = async () =>
  (
    (await call("GET", "/api/sessions?ws=north")).json.sessions as {
      id: string;
      name: string;
      exited?: boolean;
    }[]
  ).map((x) => x.name);

describe("Close a shell", () => {
  it("one that ends on HUP: stopped, forgotten, audited", async () => {
    const open = await call("POST", "/api/workspaces/north/sessions");
    expect(open.status).toBe(200);
    const { id, name } = open.json.session as { id: string; name: string };
    const pty = s.made.at(-1)!;
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      if (sig === "SIGHUP") setTimeout(() => pty.exit(129), 10);
    };
    expect(await listed()).toContain(name);
    const r = await call(
      "POST",
      `/api/sessions/${encodeURIComponent(id)}/close`,
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, result: "stopped" });
    expect(pty.signals).toEqual(["SIGHUP"]);
    expect(await listed()).not.toContain(name);
  }, 30_000);

  it("one that ignores HUP: KILL after the grace", async () => {
    const open = await call("POST", "/api/workspaces/north/sessions");
    const { id } = open.json.session as { id: string };
    const pty = s.made.at(-1)!;
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      if (sig === "SIGKILL") setTimeout(() => pty.exit(137), 10);
    };
    const r = await call(
      "POST",
      `/api/sessions/${encodeURIComponent(id)}/close`,
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, result: "killed" });
    expect(pty.signals).toEqual(["SIGHUP", "SIGKILL"]);
  }, 30_000);

  it("an agent's session: refused, Stop is its way; an agent's token: refused; unknown: 404", async () => {
    const start = await call(
      "POST",
      "/api/workspaces/north/agents",
      undefined,
      { persona: "planner" },
    );
    expect(start.status).toBe(200);
    const pty = s.made.at(-1)!;
    const token = actorTokenOf(pty.opts.env) ?? "";
    const id =
      (
        (await call("GET", "/api/sessions?ws=north")).json.sessions as {
          id: string;
          agent?: string;
        }[]
      ).find((x) => x.agent === "planner")?.id ?? "";
    expect(id).toBeTruthy();
    const r = await call(
      "POST",
      `/api/sessions/${encodeURIComponent(id)}/close`,
    );
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("agent_session");
    expect(pty.signals).toEqual([]);
    expect(
      (
        await call(
          "POST",
          `/api/sessions/${encodeURIComponent(id)}/close`,
          token,
        )
      ).status,
    ).toBe(403);
    expect((await call("POST", "/api/sessions/nope/close")).status).toBe(404);
  }, 30_000);
});
