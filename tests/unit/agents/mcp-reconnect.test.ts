/**
 * 0.4.46: an agent that started while Hub's MCP answered 502 gets its Hub
 * tools back with no person: once Hub answers again, Den restarts it after
 * its turn (the same conversation) and says so in its pane. While Hub is
 * still down nothing restarts and no attempt is spent; the attempts are a
 * setting (0: no limit).
 *
 * A real host on a temp socket with a scripted PTY: nothing runs. A temp
 * CLAUDE_CONFIG_DIR, never ~/.claude. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { noteHubMcpInit } from "../../../src/shared/agents/hub-mcp-connect.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { readHubConfig } from "../../../src/shared/hub.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  agentTools,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import {
  RECONNECTED_LINE,
  hubToolsMissing,
  mcpReconnect,
} from "../../../src/ui/cli/mcp-reconnect.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  await cleanupRigs();
});

const HUB = "https://hub.example.test";
const TOKEN = "hubi_TESTONLY_reconnect";

/** Stop waits for the session to end, and each scripted one ends on TERM. */
function endOnTerm(r: Rig): void {
  r.deps.stopWaitMs = 3_000;
  const made = r.made;
  const push = made.push.bind(made);
  made.push = (...ps) => {
    for (const p of ps) {
      const kill = p.kill.bind(p);
      p.kill = (sig: string) => {
        kill(sig);
        setTimeout(() => p.exit(143), 5);
      };
    }
    return push(...ps);
  };
}

/** Its conversation: a prompt, then a turn that ended. */
function endedTurn(r: Rig, token: string): void {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: r.wsDir("north"), message: { content: "Plan it" } },
      {
        type: "assistant",
        message: {
          model: "opus",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Planned." }],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(file, t, t);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

/** A planner whose Hub connect got a 502 when it started. */
async function startedWhileHubFailed() {
  const r = await rig({ hub: async () => ({ url: HUB, token: TOKEN }) });
  endOnTerm(r);
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  await settle();
  const token = readRecord(r.stateDir, "planner")!.resumeToken!;
  endedTurn(r, token);
  // What Den's /hub proxy notes when Hub answers its initialize with 502.
  noteHubMcpInit(r.stateDir, "planner", {
    ok: false,
    error: "hub (502): Bad Gateway",
  });
  return { r, d: resolveAgentsDeps(r.deps), token };
}

const typed = (r: Rig, i: number) =>
  Buffer.concat(r.made[i]?.writes ?? []).toString("utf-8");

describe("0.4.46: Den reconnects an agent's Hub tools by itself", () => {
  it("Hub at 502 when it started; Hub back: restarted after its turn, the same conversation, told in its pane, Hub tools loaded", async () => {
    const { r, d, token } = await startedWhileHubFailed();
    expect((await agentTools(d, "planner", "north")).hub.loaded).toBe(false);
    expect(await hubToolsMissing(d)).toEqual([
      { id: "planner", workspace: "north" },
    ]);
    const hub = { up: false };
    const rc = mcpReconnect(d, {
      hubUp: async () => hub.up,
      attempts: () => 3,
      pollMs: 20,
    });
    // Hub still down: nothing restarts.
    expect(await rc.tick()).toEqual([]);
    expect(await rc.tick()).toEqual([]);
    expect(r.made).toHaveLength(1);
    // Hub answers again: Den restarts it, with no person.
    hub.up = true;
    expect(await rc.tick()).toEqual(["planner"]);
    await rc.pending();
    expect(r.made).toHaveLength(2);
    expect(r.made[1].args.slice(0, 2)).toEqual(["--resume", token]);
    expect(typed(r, 1)).toContain(RECONNECTED_LINE);
    // Its new connect works (the proxy's note): Hub's tools are its own.
    noteHubMcpInit(r.stateDir, "planner", { ok: true });
    expect((await agentTools(d, "planner", "north")).hub).toEqual({
      connected: true,
      loaded: true,
      restart: false,
    });
    expect(await hubToolsMissing(d)).toEqual([]);
    expect(await rc.tick()).toEqual([]);
  }, 30_000);

  it("stops after hub.mcp_retry_attempts restarts that didn't bring them; 0 never stops", async () => {
    const { d } = await startedWhileHubFailed();
    const missing = async () => [{ id: "planner", workspace: "north" }];
    const once = mcpReconnect(d, {
      hubUp: async () => true,
      attempts: () => 1,
      missing,
      pollMs: 20,
    });
    expect(await once.tick()).toEqual(["planner"]);
    await once.pending();
    expect(await once.tick()).toEqual([]);
    const always = mcpReconnect(d, {
      hubUp: async () => true,
      attempts: () => 0,
      missing: async () => [{ id: "ghost", workspace: "north" }],
      log: () => undefined,
    });
    for (let i = 0; i < 4; i++) {
      expect(await always.tick()).toEqual(["ghost"]);
      await always.pending();
    }
  }, 30_000);

  it("hub.mcp_retry_seconds (30, at least 5) and hub.mcp_retry_attempts (0: no limit) are settings", () => {
    const url = "https://hub.example.test";
    const none = () => ({});
    const c = readHubConfig({ hub: { url } }, {}, none)!;
    expect([c.mcpRetrySeconds, c.mcpRetryAttempts]).toEqual([30, 0]);
    const set = readHubConfig(
      { hub: { url, mcp_retry_seconds: 120, mcp_retry_attempts: 5 } },
      {},
      none,
    )!;
    expect([set.mcpRetrySeconds, set.mcpRetryAttempts]).toEqual([120, 5]);
    expect(() =>
      readHubConfig({ hub: { url, mcp_retry_seconds: 2 } }, {}, none),
    ).toThrow("hub.mcp_retry_seconds must be a number, at least 5");
    for (const bad of [-1, 1.5, "3"])
      expect(() =>
        readHubConfig({ hub: { url, mcp_retry_attempts: bad } }, {}, none),
      ).toThrow("hub.mcp_retry_attempts must be a whole number");
  });
});
