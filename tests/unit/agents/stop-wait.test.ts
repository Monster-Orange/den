/**
 * 0.4.8: `agents stop` returns once the agent's session has ended, so
 * `agents stop X && agents resume X` never finds X still running. It waits
 * up to stopWaitMs (5 s by default); a session still running then is
 * "still stopping" (exit 1). `--no-wait` returns once TERM is sent, as
 * before. The stop route answers the same way: 200 once ended, 202 with
 * `stillStopping: true` otherwise.
 *
 * A real host on a temp socket and a scripted PTY: a test decides when (or
 * whether) a session ends after TERM. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);

/** A started, prompted planner whose program ends `afterMs` after TERM. */
async function planner(r: Rig, afterMs: number | null): Promise<ScriptedPty> {
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  const rec = JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", "planner.json"), "utf-8"),
  ) as { session: { id: string } };
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(rec.session.id, Buffer.from("plan the release\r"));
  await settle();
  c.close();
  const p = r.made[r.made.length - 1];
  const kill = p.kill.bind(p);
  p.kill = (signal: string) => {
    kill(signal);
    if (afterMs !== null) setTimeout(() => p.exit(143), afterMs);
  };
  return p;
}

describe("agents stop waits for the session to end", () => {
  it("a session that ends ~1 s after TERM: stop waits, and resume right after it works", async () => {
    const r = await rig({ stopWaitMs: 5000 });
    await planner(r, 1000);
    const t0 = Date.now();
    expect(await agents(r, "stop", "planner")).toBe(0);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(4000);
    expect(r.out.join("\n")).toMatch(/stopped agent planner .*it has ended/);
    expect(await agents(r, "resume", "planner")).toBe(0);
    expect(r.made).toHaveLength(2);
    expect(r.made[1].args.slice(0, 1)).toEqual(["--resume"]);
  }, 20_000);

  it("a session that never ends: still stopping, exit 1, at the bound", async () => {
    const r = await rig({ stopWaitMs: 400 });
    await planner(r, null);
    const t0 = Date.now();
    expect(await agents(r, "stop", "planner")).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(r.err.join("\n")).toMatch(/^planner is still stopping/m);
  }, 20_000);

  it("--no-wait returns once TERM is sent, as before", async () => {
    const r = await rig({ stopWaitMs: 5000 });
    const p = await planner(r, null);
    const t0 = Date.now();
    expect(await agents(r, "stop", "planner", "--no-wait")).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(p.signals).toContain("SIGTERM");
    expect(r.out.join("\n")).toMatch(/stopping agent planner|sent TERM/);
  }, 20_000);
});

async function route(
  r: Rig,
): Promise<
  (p: string) => Promise<{ status: number; json: Record<string, unknown> }>
> {
  const server = http.createServer((req, res) => {
    jsonApiErrors(res, newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleAgentRoutes(req, res, p, { agents: r.deps });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const port = (server.address() as AddressInfo).port;
  return async (p) => {
    const res = await fetch(`http://localhost:${port}${p}`, { method: "POST" });
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
}

describe("the stop route waits the same way", () => {
  it("200 with stopped: true once the session has ended", async () => {
    const r = await rig({ stopWaitMs: 5000 });
    await planner(r, 500);
    const post = await route(r);
    const out = await post("/api/workspaces/north/agents/planner/stop");
    expect(out).toEqual({
      status: 200,
      json: { ok: true, agent: "planner", wasRunning: true, stopped: true },
    });
    expect(
      (await post("/api/workspaces/north/agents/planner/resume")).status,
    ).toBe(200);
  }, 20_000);

  it("202 with stillStopping: true when it hasn't ended in time", async () => {
    const r = await rig({ stopWaitMs: 300 });
    await planner(r, null);
    const post = await route(r);
    expect(await post("/api/workspaces/north/agents/planner/stop")).toEqual({
      status: 202,
      json: {
        ok: true,
        agent: "planner",
        wasRunning: true,
        stopped: false,
        stillStopping: true,
      },
    });
  }, 20_000);
});
