/**
 * SRV-1a on the real server: the server agent restarts its own Den and
 * carries on. With server_agent.self_update: auto, its own den_restart
 * runs at once; the server restarts on the same port (D64's path, a new
 * pid); its session lives on in the session host; and the new server
 * types "Server is back on <version> (pid …)" into it. The audit trail,
 * which persists across the restart, has the ask, the auto Allow, the
 * restart and the return. With ask (the default), the same ask waits.
 *
 * The demo distribution, the scripted PTY. Invented names only. The new
 * server is this test's own: afterAll stops it by the pid it reports.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer;
let agentToken = "";
let newPid = 0;

beforeAll(async () => {
  s = await startAgentsPageServer({});
}, 60_000);
afterAll(async () => {
  // The restarted server is a daemon this test made: stop it by its pid.
  if (newPid) {
    try {
      process.kill(newPid, "SIGTERM");
    } catch {
      /* gone already */
    }
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(newPid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await s?.stop().catch(() => undefined);
}, 30_000);

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

const den = () => path.join(s.tmp, "dist", "config", "acme.yml");
const setSelfUpdate = (v: "ask" | "auto") => {
  const base = fs
    .readFileSync(den(), "utf8")
    .replace(/\nserver_agent:\n {2}self_update: \w+\n/, "\n");
  fs.writeFileSync(den(), `${base}\nserver_agent:\n  self_update: ${v}\n`);
};

const typed = () => Buffer.concat(s.made.at(-1)?.writes ?? []).toString("utf8");

const audit = (): { verb: string; detail: string }[] => {
  try {
    return fs
      .readFileSync(path.join(s.stateDir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { verb: string; detail: string });
  } catch {
    return [];
  }
};

async function until<T>(
  f: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  ms: number,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("SRV-1a: the server agent restarts its own Den", () => {
  it("started by the person; with ask (the default) its restart waits for the Allow", async () => {
    const st = await call("POST", "/api/server-agent/start", {});
    expect(st.status).toBe(200);
    agentToken = s.made.at(-1)!.opts.env.DEN_ACTOR_TOKEN ?? "";
    // Its prompt, as Claude Code draws it.
    s.made.at(-1)!.emit("> ");
    expect(agentToken).toBeTruthy();
    const r = await call(
      "POST",
      "/api/approvals",
      { action: "den_restart", args: { reason: "check the held path" } },
      "agent",
    );
    expect([r.status, r.json.state]).toEqual([202, "pending"]);
  }, 30_000);

  it('auto: it runs at once; a new server on the same port types "Server is back" into its session', async () => {
    setSelfUpdate("auto");
    const before = await call("GET", "/api/server-info");
    const oldPid = Number(before.json.pid);
    expect(oldPid).toBeGreaterThan(0);
    // What `web up` leaves for this server (the helper started it itself),
    // so the restart finds the server it stops.
    fs.writeFileSync(
      path.join(s.stateDir, "web.json"),
      JSON.stringify({
        pid: oldPid,
        port: s.port,
        root: path.join(s.tmp, "dist"),
        logPath: path.join(s.stateDir, "logs", "acme", "web.log"),
        startedAt: new Date().toISOString(),
        command: "the test's server",
      }),
    );
    const r = await call(
      "POST",
      "/api/approvals",
      { action: "den_restart", args: { reason: "pick up the new pin" } },
      "agent",
    );
    expect(r.json.state).toBe("done");
    expect(r.json.result).toMatchObject({ ok: true, restarting: true });
    // A new server answers on the same port.
    newPid = await until(async () => {
      const i = await fetch(`${s.base}/api/server-info`)
        .then((x) => x.json() as Promise<{ pid?: number }>)
        .catch(() => null);
      return i?.pid && i.pid !== oldPid ? i.pid : null;
    }, 60_000);
    // The agent's session lived on, and is told.
    const line = await until(
      () =>
        /Server is back on \S+ \(pid (\d+)\)\. You restarted it: pick up the new pin\./.exec(
          typed(),
        ),
      30_000,
    );
    expect(Number(line[1])).toBe(newPid);
    // Every step is in the trail, across the restart.
    const rows = await until(() => {
      const a = audit();
      return a.some((e) => e.verb === "server-back") ? a : null;
    }, 10_000);
    const verbs = rows.map((e) => e.verb);
    expect(verbs).toEqual(
      expect.arrayContaining([
        "approval-ask",
        "approval-decide",
        "server-restart",
        "server-back",
      ]),
    );
    expect(
      rows.find(
        (e) => e.verb === "approval-decide" && /auto-allow/.test(e.detail),
      ),
    ).toBeTruthy();
    expect(rows.find((e) => e.verb === "server-back")?.detail).toMatch(
      new RegExp(
        `pid ${newPid}\\), was \\S+ \\(pid ${oldPid}\\): pick up the new pin .*told`,
      ),
    );
  }, 120_000);
});
