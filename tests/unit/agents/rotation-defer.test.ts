/**
 * Issue 765: Put off rotation until <time>.
 *
 *   - A deferred agent isn't rotated before its time (the tick leaves it,
 *     Resume resumes), and is rotated after it.
 *   - `agents rotate <id> --defer <ISO time|+Nh|+Nm|+Nd|none>`: a person's;
 *     in an agent's session it is refused, naming the held write.
 *   - POST /api/workspaces/:ws/agents/:id/defer { until }: a person's.
 *   - agent_rotation_defer, the held write an agent asks with: always the
 *     person's own Allow; on Allow it is put off.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import {
  noteCompaction,
  readRotation,
} from "../../../src/shared/agents/rotation.js";
import {
  checkRotationDefer,
  deferAgentRotation,
  parseDeferTime,
  resolveAgentsDeps,
  rotationOf,
  rotationTick,
  runRotationDefer,
  type AgentsResolved,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import { CRITICAL_HELD_ACTIONS } from "../../../src/ui/server/held-actions.js";
import { ACTOR_TOKEN_ENV } from "../../../src/shared/actor-token.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const rec = (r: Rig, id: string) => readRecord(r.stateDir, id)!;
const files = (r: Rig, id: string) => path.join(r.stateDir, "agent-files", id);

async function started(r: Rig, id = "be-dev"): Promise<string> {
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: path.join(r.dir, "cc") };
  r.deps.stopWaitMs = 2000;
  expect(await agents(r, "start", "-w", "north", "--persona", id)).toBe(0);
  for (const pty of r.made) {
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      setTimeout(() => pty.exit(0), 10);
    };
  }
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(rec(r, id).session.id, Buffer.from("build the export\r"));
  await settle();
  c.close();
  return rec(r, id).resumeToken!;
}

function compact(r: Rig, id: string, n: number): void {
  const token = rec(r, id).resumeToken!;
  const after = readRotation(files(r, id))!.after;
  for (let i = 0; i < n; i++)
    noteCompaction(files(r, id), { session_id: token, trigger: "auto" }, after);
}

function idle(r: Rig, id: string): void {
  const dir = path.join(r.dir, "cc", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: "assistant",
    message: {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
    },
  });
  fs.writeFileSync(
    path.join(dir, `${rec(r, id).resumeToken}.jsonl`),
    `${line}\n`,
  );
}

const send = async () => true;

describe("parseDeferTime", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");
  it("takes +Nm, +Nh, +Nd and an ISO time; none clears", () => {
    expect(parseDeferTime("+90m", now)?.toISOString()).toBe(
      "2026-11-20T13:30:00.000Z",
    );
    expect(parseDeferTime("+2h", now)?.toISOString()).toBe(
      "2026-11-20T14:00:00.000Z",
    );
    expect(parseDeferTime("+1d", now)?.toISOString()).toBe(
      "2026-11-21T12:00:00.000Z",
    );
    expect(parseDeferTime("2026-11-21T08:00:00Z", now)?.toISOString()).toBe(
      "2026-11-21T08:00:00.000Z",
    );
    expect(parseDeferTime("none", now)).toBeNull();
  });
  it("refuses a time already gone, or words it can't read", () => {
    expect(() => parseDeferTime("2026-11-19T08:00:00Z", now)).toThrow(
      /already/,
    );
    expect(() => parseDeferTime("later", now)).toThrow(/\+2h/);
  });
});

describe("a deferred agent (issue 765)", () => {
  it("isn't rotated before its time, and is rotated after it", async () => {
    const r = await rig();
    const t1 = await started(r);
    compact(r, "be-dev", 3);
    fs.writeFileSync(path.join(files(r, "be-dev"), "handoff.md"), GOOD_HANDOFF);
    idle(r, "be-dev");
    const d = resolveAgentsDeps(r.deps);
    const now = new Date();
    const until = new Date(now.getTime() + 1500);
    deferAgentRotation(d, "be-dev", undefined, until, now);
    expect(rotationOf(d, rec(r, "be-dev"))).toMatchObject({
      deferredUntil: until.toISOString(),
    });
    expect(rotationOf(d, rec(r, "be-dev"))?.due).toBeUndefined();
    expect(await rotationTick(d, now, { send })).toEqual([]);
    expect(rec(r, "be-dev").resumeToken).toBe(t1);
    // Its time came: the normal rule applies again.
    await new Promise((res) =>
      setTimeout(res, until.getTime() - Date.now() + 50),
    );
    expect(rotationOf(d, rec(r, "be-dev"))?.due).toBe("compactions");
    const ev = await rotationTick(d, new Date(), { send });
    expect(ev).toEqual([
      expect.objectContaining({ kind: "relaunched", agent: "be-dev" }),
    ]);
  }, 30_000);
});

describe("agents rotate <id> --defer (CLI)", () => {
  it("puts it off, clears it with none, and refuses a bad time", async () => {
    const r = await rig();
    await started(r);
    const before = Date.now();
    expect(await agents(r, "rotate", "be-dev", "--defer", "+2h")).toBe(0);
    const at = Date.parse(readRotation(files(r, "be-dev"))!.deferUntil!);
    expect(at - before).toBeGreaterThanOrEqual(2 * 3_600_000 - 1000);
    expect(at - before).toBeLessThan(2 * 3_600_000 + 60_000);
    expect(r.out.join("\n")).toMatch(/put off/);
    expect(await agents(r, "rotate", "be-dev", "--defer", "none")).toBe(0);
    expect(readRotation(files(r, "be-dev"))!.deferUntil).toBeUndefined();
    r.err.length = 0;
    expect(await agents(r, "rotate", "be-dev", "--defer", "soon")).toBe(2);
  });

  it("in an agent's session: refused, naming the held write", async () => {
    const r = await rig();
    await started(r);
    r.deps.env = { ...r.deps.env, [ACTOR_TOKEN_ENV]: "x" };
    expect(await agents(r, "rotate", "be-dev", "--defer", "+2h")).toBe(1);
    expect(r.err.join("\n")).toMatch(/agent_rotation_defer/);
    expect(readRotation(files(r, "be-dev"))!.deferUntil).toBeUndefined();
  });
});

describe("POST /api/workspaces/:ws/agents/:id/defer", () => {
  async function server(r: Rig) {
    const srv = http.createServer((req, res) => {
      void handleAgentRoutes(req, res, new URL(req.url!, "http://x").pathname, {
        agents: r.deps,
      }).then((done) => {
        if (!done) res.writeHead(404).end();
      });
    });
    servers.push(srv);
    await new Promise<void>((res) => srv.listen(0, "localhost", () => res()));
    const port = (srv.address() as AddressInfo).port;
    return async (body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(
        `http://localhost:${port}/api/workspaces/north/agents/be-dev/defer`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        },
      );
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    };
  }

  it("a person puts it off, or clears it; a bad time is a 400", async () => {
    const r = await rig();
    await started(r);
    const call = await server(r);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const ok = await call({ until });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, agent: "be-dev", until });
    expect(readRotation(files(r, "be-dev"))!.deferUntil).toBe(until);
    expect((await call({ until: null })).status).toBe(200);
    expect(readRotation(files(r, "be-dev"))!.deferUntil).toBeUndefined();
    expect((await call({ until: "yesterday" })).status).toBe(400);
    expect((await call({ until, more: 1 })).status).toBe(400);
  });

  it("an agent's own call is refused", async () => {
    const r = await rig();
    await started(r);
    const call = await server(r);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const no = await call(
      { until },
      {
        "x-den-actor": "agent",
        "x-den-mcp-client": "jest",
        "x-den-mcp-agent": "agent:be-dev",
        "x-den-mcp-workspace": "north",
      },
    );
    expect(no.status).toBe(403);
    expect(String(no.json.error)).toMatch(/agent_rotation_defer/);
    expect(readRotation(files(r, "be-dev"))!.deferUntil).toBeUndefined();
  });
});

describe("agent_rotation_defer, the held write", () => {
  it("is always the person's own Allow, and puts it off on Allow", async () => {
    expect(CRITICAL_HELD_ACTIONS.has("agent_rotation_defer")).toBe(true);
    const r = await rig();
    await started(r);
    const d: AgentsResolved = resolveAgentsDeps(r.deps);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const c = checkRotationDefer(d, { agent: "be-dev", until });
    expect(c).toMatchObject({
      ok: true,
      personOnly: true,
      params: { agent: "be-dev", until },
      args: { agent: "be-dev", project: "north", until },
    });
    expect(readRotation(files(r, "be-dev"))!.deferUntil).toBeUndefined();
    expect(
      checkRotationDefer(d, { agent: "be-dev", until: "2001-01-01T00:00:00Z" }),
    ).toMatchObject({ ok: false });
    // A project's agent asks for its own project's agents only.
    expect(
      checkRotationDefer(
        d,
        { agent: "be-dev", until },
        { agent: "x", project: "south" },
      ),
    ).toMatchObject({ ok: false });
    const out = await runRotationDefer(d, { agent: "be-dev", until });
    expect(out).toMatchObject({ ok: true, agent: "be-dev", until });
    expect(readRotation(files(r, "be-dev"))!.deferUntil).toBe(until);
  });
});
