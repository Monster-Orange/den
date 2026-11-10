/**
 * D28: rotation by itself, and the callout's actions.
 *
 *   - on_due auto (the default): a running agent whose rotation is due is,
 *     at idle (never mid-turn), relaunched from its handoff when it passes,
 *     or asked for it (at most twice, a gap apart), then auto falls back
 *     to ask. ask and off: nothing happens by itself.
 *   - Relaunch now before a handoff: asked once; once it passes, Den
 *     relaunches it whatever on_due says.
 *   - Keep this conversation: the count starts again; "don't ask again"
 *     sets the agent's override to never.
 *   - The settings' scopes reach a launch's limit and the hook follows a
 *     change; the service scope is the service whose folder holds the
 *     agent's.
 *   - The routes (keep and the settings: a person's only) and the CLI.
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
  readRotateFile,
  setRotateValue,
} from "../../../src/shared/agents/rotate-settings.js";
import { rotationHookOutput } from "../../../src/shared/agents/guardrails/rotation-hook.js";
import {
  askForHandoff,
  effectiveRotation,
  keepAgentConversation,
  resolveAgentsDeps,
  rotationTick,
  type AgentsResolved,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
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
const writeHandoff = (r: Rig, id: string) =>
  fs.writeFileSync(path.join(files(r, id), "handoff.md"), GOOD_HANDOFF);

async function started(r: Rig, id = "be-dev"): Promise<string> {
  // A transcript dir of its own: busy or idle is what the test writes.
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: path.join(r.dir, "cc") };
  // A relaunch stops the running session first: it ends on TERM, as a
  // real runtime does.
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

/** Its transcript's last record: mid-turn (a tool call) or idle. */
function turn(r: Rig, id: string, busy: boolean): void {
  const dir = path.join(r.dir, "cc", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: "assistant",
    message: {
      stop_reason: busy ? "tool_use" : "end_turn",
      content: [{ type: "text", text: "ok" }],
    },
  });
  fs.writeFileSync(
    path.join(dir, `${rec(r, id).resumeToken}.jsonl`),
    `${line}\n`,
  );
}

/** A send that records what it typed (the real one types into the PTY). */
function sender() {
  const sent: { session: string; text: string }[] = [];
  const send = async (
    _d: AgentsResolved,
    session: string,
    _rt: string,
    text: string,
  ) => {
    sent.push({ session, text });
    return true;
  };
  return { sent, send };
}

const T0 = new Date("2026-11-10T12:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("rotationTick (on_due auto)", () => {
  it("relaunches a due, idle agent whose handoff passes, by itself", async () => {
    const r = await rig();
    const t1 = await started(r);
    compact(r, "be-dev", 3);
    writeHandoff(r, "be-dev");
    turn(r, "be-dev", false);
    const d = resolveAgentsDeps(r.deps);
    const ev = await rotationTick(d, T0, { send: sender().send });
    expect(ev).toEqual([
      {
        kind: "relaunched",
        agent: "be-dev",
        workspace: "north",
        why: "3 compactions",
        old: t1,
      },
    ]);
    const now = rec(r, "be-dev");
    expect(now.resumeToken).not.toBe(t1);
    expect(now.rotations?.[0]).toMatchObject({ auto: true, conversation: t1 });
    // The new conversation counts from 0: nothing more to do.
    expect(await rotationTick(d, later(1000))).toEqual([]);
  });

  it("never mid-turn: a busy agent waits for its turn to end", async () => {
    const r = await rig();
    const t1 = await started(r);
    compact(r, "be-dev", 3);
    writeHandoff(r, "be-dev");
    turn(r, "be-dev", true);
    const d = resolveAgentsDeps(r.deps);
    expect(await rotationTick(d, T0)).toEqual([]);
    expect(rec(r, "be-dev").resumeToken).toBe(t1);
    turn(r, "be-dev", false);
    expect((await rotationTick(d, later(1000)))[0]?.kind).toBe("relaunched");
  });

  it("no handoff: asks twice, a gap apart, then falls back to ask", async () => {
    const r = await rig();
    await started(r);
    compact(r, "be-dev", 3);
    turn(r, "be-dev", false);
    const d = resolveAgentsDeps(r.deps);
    const { sent, send } = sender();
    const o = { send, askGapMs: 60_000 };
    expect(await rotationTick(d, T0, o)).toEqual([
      { kind: "asked", agent: "be-dev", workspace: "north", asked: 1 },
    ]);
    expect(sent[0].session).toBe(rec(r, "be-dev").session.id);
    expect(sent[0].text).toContain("Write your handoff now");
    // Within the gap: nothing.
    expect(await rotationTick(d, later(30_000), o)).toEqual([]);
    expect((await rotationTick(d, later(61_000), o))[0]).toMatchObject({
      kind: "asked",
      asked: 2,
    });
    expect(await rotationTick(d, later(130_000), o)).toEqual([
      { kind: "fell-back", agent: "be-dev", workspace: "north" },
    ]);
    expect(sent).toHaveLength(2);
    // Fallen back: no more asks; the row says so.
    expect(await rotationTick(d, later(400_000), o)).toEqual([]);
    expect(readRotation(files(r, "be-dev"))).toMatchObject({
      asked: 2,
      fellBack: true,
    });
  });

  it("ask and off: nothing happens by itself", async () => {
    for (const mode of ["ask", "off"]) {
      const r = await rig();
      const t1 = await started(r);
      compact(r, "be-dev", 3);
      writeHandoff(r, "be-dev");
      turn(r, "be-dev", false);
      setRotateValue(r.stateDir, "install", undefined, "on_due", mode);
      const { sent, send } = sender();
      const d = resolveAgentsDeps(r.deps);
      expect([mode, await rotationTick(d, T0, { send })]).toEqual([mode, []]);
      expect(sent).toEqual([]);
      expect(rec(r, "be-dev").resumeToken).toBe(t1);
      await cleanupRigs();
    }
  });

  it("after_compactions never: never due, whatever the count", async () => {
    const r = await rig();
    const t1 = await started(r);
    setRotateValue(r.stateDir, "agent", "be-dev", "after_compactions", "never");
    compact(r, "be-dev", 5);
    writeHandoff(r, "be-dev");
    turn(r, "be-dev", false);
    const d = resolveAgentsDeps(r.deps);
    expect(await rotationTick(d, T0, { send: sender().send })).toEqual([]);
    expect(rec(r, "be-dev").resumeToken).toBe(t1);
  });

  it("a lower limit set while it runs: due at it; the hook counts against it", async () => {
    const r = await rig();
    const t1 = await started(r);
    compact(r, "be-dev", 1);
    turn(r, "be-dev", false);
    const d = resolveAgentsDeps(r.deps);
    expect(await rotationTick(d, T0, { send: sender().send })).toEqual([]);
    setRotateValue(r.stateDir, "persona", "be-dev", "after_compactions", 1);
    const ev = await rotationTick(d, later(1000), { send: sender().send });
    expect(ev[0]).toMatchObject({ kind: "asked" });
    expect(readRotation(files(r, "be-dev"))?.after).toBe(1);
    // The hook (launched with --after 3) follows rotation.json's limit.
    const out = rotationHookOutput(
      { hook_event_name: "SessionStart", source: "resume", session_id: t1 },
      { files: files(r, "be-dev"), after: 3 },
    );
    expect(out).toContain("Write your handoff now");
  });
});

describe("Relaunch now, Keep this conversation (D28)", () => {
  it("Relaunch now before a handoff, under ask: asked once, relaunched once it passes", async () => {
    const r = await rig();
    const t1 = await started(r);
    compact(r, "be-dev", 3);
    turn(r, "be-dev", false);
    setRotateValue(r.stateDir, "install", undefined, "on_due", "ask");
    const d = resolveAgentsDeps(r.deps);
    const { sent, send } = sender();
    await askForHandoff(d, "be-dev", "north", send, { relaunch: true });
    expect(sent).toHaveLength(1);
    expect(readRotation(files(r, "be-dev"))?.relaunchWanted).toBe(true);
    // No handoff yet: no relaunch, and no more asks.
    expect(await rotationTick(d, later(500_000), { send })).toEqual([]);
    expect(sent).toHaveLength(1);
    writeHandoff(r, "be-dev");
    expect((await rotationTick(d, later(600_000), { send }))[0]).toMatchObject({
      kind: "relaunched",
      old: t1,
    });
  });

  it("Write handoff is refused mid-turn; Relaunch now on a stopped agent resumes it to write one", async () => {
    const r = await rig();
    const t1 = await started(r);
    compact(r, "be-dev", 3);
    turn(r, "be-dev", true);
    const d = resolveAgentsDeps(r.deps);
    await expect(
      askForHandoff(d, "be-dev", "north", sender().send),
    ).rejects.toThrow(/mid-turn/);
    expect(await agents(r, "stop", "be-dev")).toBe(0);
    r.made[r.made.length - 1].exit(0);
    await settle();
    await expect(
      askForHandoff(d, "be-dev", "north", sender().send),
    ).rejects.toThrow(/not running: resume it/);
    const out = await askForHandoff(d, "be-dev", "north", sender().send, {
      relaunch: true,
    });
    expect(out.resumed).toBe(true);
    expect(r.made[r.made.length - 1].args.slice(0, 2)).toEqual([
      "--resume",
      t1,
    ]);
    expect(readRotation(files(r, "be-dev"))?.relaunchWanted).toBe(true);
  });

  it("Keep this conversation: the count starts again; never sets the agent's override", async () => {
    const r = await rig();
    const t1 = await started(r);
    compact(r, "be-dev", 3);
    const d = resolveAgentsDeps(r.deps);
    keepAgentConversation(d, "be-dev", "north");
    expect(readRotation(files(r, "be-dev"))).toEqual({
      conversation: t1,
      compactions: 0,
      after: 3,
    });
    keepAgentConversation(d, "be-dev", "north", { never: true });
    expect(readRotateFile(r.stateDir).overrides?.agent).toEqual({
      "be-dev": { after_compactions: "never" },
    });
  });
});

describe("scopes reach the agent", () => {
  it("the service scope: the service whose folder holds its folder", async () => {
    const r = await rig({
      workspaceServices: (ws) =>
        ws === "north"
          ? [
              { address: "shop", path: "/elsewhere/shop" },
              {
                address: "notes",
                path: path.join(r.dir, "workspaces", "north"),
              },
            ]
          : [],
    });
    setRotateValue(r.stateDir, "service", "notes", "on_due", "ask");
    await started(r);
    const d = resolveAgentsDeps(r.deps);
    const p = effectiveRotation(
      d,
      d.agentsConfig(),
      rec(r, "be-dev"),
      undefined,
    );
    expect(p).toMatchObject({ onDue: "ask" });
    expect(p.from?.on_due).toBe("service notes");
  });

  it("a launch counts against the effective limit (persona in a workspace)", async () => {
    const r = await rig();
    setRotateValue(
      r.stateDir,
      "persona-workspace",
      "be-dev@north",
      "after_compactions",
      2,
    );
    await started(r);
    expect(readRotation(files(r, "be-dev"))?.after).toBe(2);
  });
});

describe("the routes", () => {
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
    return async (
      method: string,
      p: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const res = await fetch(`http://localhost:${port}${p}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    };
  }

  it("GET and PUT /api/agents/rotation; a bad value is a 400 naming it", async () => {
    const r = await rig();
    await started(r);
    const call = await server(r);
    const put = await call("PUT", "/api/agents/rotation", {
      scope: "persona",
      target: "be-dev",
      key: "after_compactions",
      value: 5,
    });
    expect(put.status).toBe(200);
    const got = await call("GET", "/api/agents/rotation?ws=north&agent=be-dev");
    expect(got.json).toMatchObject({
      defaults: { after_compactions: 3, on_due: "auto", on_pr_merged: true },
      overrides: { persona: { "be-dev": { after_compactions: 5 } } },
      effective: {
        agent: "be-dev",
        afterCompactions: 5,
        from: { after_compactions: "persona be-dev" },
      },
    });
    const bad = await call("PUT", "/api/agents/rotation", {
      scope: "install",
      key: "on_due",
      value: "sometimes",
    });
    expect(bad.status).toBe(400);
    expect(String(bad.json.error)).toMatch(/auto, ask or off/);
    const clear = await call("PUT", "/api/agents/rotation", {
      scope: "persona",
      target: "be-dev",
      key: "after_compactions",
      value: null,
    });
    expect(clear.status).toBe(200);
    expect(readRotateFile(r.stateDir)).toEqual({});
  });

  it("keep resets the count; never sets the agent's override", async () => {
    const r = await rig();
    await started(r);
    compact(r, "be-dev", 3);
    const call = await server(r);
    const bad = await call("POST", "/api/workspaces/north/agents/be-dev/keep", {
      forever: true,
    });
    expect(bad.status).toBe(400);
    const ok = await call("POST", "/api/workspaces/north/agents/be-dev/keep", {
      never: true,
    });
    expect(ok.status).toBe(200);
    expect(readRotation(files(r, "be-dev"))?.compactions).toBe(0);
    expect(readRotateFile(r.stateDir).overrides?.agent?.["be-dev"]).toEqual({
      after_compactions: "never",
    });
  });
});

describe("agents rotate, keep (CLI)", () => {
  it("sets, shows and clears; -w with --persona is the persona in that workspace", async () => {
    const r = await rig();
    await started(r);
    expect(await agents(r, "rotate", "on_due", "ask")).toBe(0);
    expect(
      await agents(
        r,
        "rotate",
        "--persona",
        "be-dev",
        "-w",
        "north",
        "after_compactions",
        "never",
      ),
    ).toBe(0);
    expect(readRotateFile(r.stateDir)).toEqual({
      install: { on_due: "ask" },
      overrides: {
        "persona-workspace": { "be-dev@north": { after_compactions: "never" } },
      },
    });
    r.out.length = 0;
    expect(await agents(r, "rotate", "be-dev", "--show")).toBe(0);
    expect(r.out).toEqual([
      "agent be-dev:",
      "  after_compactions  never  (from persona be-dev in north)",
      "  on_due             ask  (from this install)",
      "  on_pr_merged       true  (from default)",
    ]);
    expect(await agents(r, "rotate", "--unset", "on_due")).toBe(0);
    expect(readRotateFile(r.stateDir).install).toBeUndefined();
    r.err.length = 0;
    expect(await agents(r, "rotate", "on_due", "later")).toBe(2);
    expect(r.err.join("\n")).toMatch(/auto, ask or off/);
  });

  it("refused in an agent's session", async () => {
    const r = await rig();
    await started(r);
    r.deps.env = { ...r.deps.env, [ACTOR_TOKEN_ENV]: "x" };
    expect(await agents(r, "rotate", "on_due", "off")).toBe(1);
    expect(r.err.join("\n")).toMatch(/only a person can change rotation/);
    expect(await agents(r, "keep", "be-dev", "--never")).toBe(1);
    expect(fs.existsSync(path.join(r.stateDir, "agent-rotation.json"))).toBe(
      false,
    );
  });
});
