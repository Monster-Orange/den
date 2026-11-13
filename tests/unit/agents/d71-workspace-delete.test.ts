/**
 * D71: a workspace delete never leaves its agents running with no
 * workspace. With agents and no choice it is refused, naming them; "stop"
 * stops and removes them (Undo keeps them an hour); "move" moves them
 * (D72): a stopped one now, a running one once its turn ends. An agent
 * whose workspace is gone anyway is listed (orphan), so it can be moved.
 *
 * A real host on a temp socket, a scripted PTY (nothing runs). Invented
 * names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  disposeWorkspaceAgents,
  resolveAgentsDeps,
  workspaceAgents,
} from "../../../src/ui/cli/agent-ops.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);

function endOnTerm(r: Rig): void {
  r.deps.stopWaitMs = 3_000;
  const push = r.made.push.bind(r.made);
  r.made.push = (...ps) => {
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

function idle(r: Rig, token: string): void {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: r.wsDir("north"), message: { content: "Plan" } },
      {
        type: "assistant",
        message: {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done." }],
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

/** north: a running planner (idle) and a stopped reviewer. */
async function twoAgents(): Promise<Rig> {
  const r = await rig();
  endOnTerm(r);
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  idle(r, readRecord(r.stateDir, "planner")!.resumeToken!);
  writeRecord(r.stateDir, {
    id: "reviewer",
    persona: "reviewer",
    runtime: "den-claude",
    workspace: "north",
    cwd: r.wsDir("north"),
    session: { backend: "den-pty", id: "gone-reviewer" },
    sessionName: "acme-north:reviewer",
    startedAt: "2026-11-06T09:30:00.000Z",
    stoppedAt: "2026-11-06T10:30:00.000Z",
  });
  return r;
}

describe("D71: a workspace delete and its agents", () => {
  it("lists them, running or not", async () => {
    const r = await twoAgents();
    const d = resolveAgentsDeps(r.deps);
    expect(
      (await workspaceAgents(d, "north")).map((a) => [a.id, a.running]).sort(),
    ).toEqual([
      ["planner", true],
      ["reviewer", false],
    ]);
    expect(await workspaceAgents(d, "south")).toEqual([]);
  });

  it("no choice: refused (409 has_agents), naming them; nothing changes", async () => {
    const r = await twoAgents();
    const d = resolveAgentsDeps(r.deps);
    await expect(
      disposeWorkspaceAgents(d, "north", undefined),
    ).rejects.toMatchObject({
      status: 409,
      code: "has_agents",
      message: expect.stringMatching(/2 agents \(planner, reviewer\)/),
    });
    expect(readRecord(r.stateDir, "planner")?.workspace).toBe("north");
    // None: nothing to ask.
    expect(await disposeWorkspaceAgents(d, "south", undefined)).toEqual({
      stopped: [],
      moved: [],
    });
  });

  it("stop: the running one stops, both are removed", async () => {
    const r = await twoAgents();
    const d = resolveAgentsDeps(r.deps);
    const out = await disposeWorkspaceAgents(d, "north", "stop");
    expect(out.stopped).toEqual(["planner"]);
    expect(r.made[0].signals.length).toBeGreaterThan(0);
    expect(readRecord(r.stateDir, "planner")).toBeNull();
    expect(readRecord(r.stateDir, "reviewer")).toBeNull();
  });

  it("move: the stopped one at once, the running one once its turn ends; same conversation", async () => {
    const r = await twoAgents();
    const d = resolveAgentsDeps(r.deps);
    const token = readRecord(r.stateDir, "planner")!.resumeToken!;
    const out = await disposeWorkspaceAgents(d, "north", "move", "south");
    expect(out.moved).toEqual(
      expect.arrayContaining([
        { id: "reviewer", pending: false },
        { id: "planner", pending: true },
      ]),
    );
    expect(readRecord(r.stateDir, "reviewer")?.workspace).toBe("south");
    for (let i = 0; i < 100; i++) {
      if (readRecord(r.stateDir, "planner")?.workspace === "south") break;
      await settle();
    }
    expect(readRecord(r.stateDir, "planner")).toMatchObject({
      workspace: "south",
      resumeToken: token,
    });
    expect(r.made[r.made.length - 1].args.slice(0, 2)).toEqual([
      "--resume",
      token,
    ]);
  });

  it("move: refused to the same workspace, or one that doesn't exist", async () => {
    const r = await twoAgents();
    const d = resolveAgentsDeps(r.deps);
    await expect(disposeWorkspaceAgents(d, "north", "move")).rejects.toThrow(
      /give the project/,
    );
    await expect(
      disposeWorkspaceAgents(d, "north", "move", "north"),
    ).rejects.toThrow(/another project/);
    await expect(
      disposeWorkspaceAgents(d, "north", "move", "nowhere"),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("D71: an agent whose workspace is gone", () => {
  it("is listed, marked orphan, and moves like any other", async () => {
    const r = await rig();
    writeRecord(r.stateDir, {
      id: "stray",
      persona: "planner",
      runtime: "den-claude",
      workspace: "gone",
      cwd: r.wsDir("north"),
      session: { backend: "den-pty", id: "gone-stray" },
      sessionName: "acme-gone:stray",
      startedAt: "2026-11-06T09:30:00.000Z",
      stoppedAt: "2026-11-06T10:30:00.000Z",
    });
    const base = {
      stateDir: () => r.stateDir,
      dist: () => "acme",
      activeWorkspaces: () => ["north", "south"],
    };
    // Without the check (an older caller): not listed, as before.
    expect(
      listedSessions([], base).find((x) => x.agent === "stray"),
    ).toBeUndefined();
    const row = listedSessions([], {
      ...base,
      workspaceExists: (ws: string) => ws === "north" || ws === "south",
    }).find((x) => x.agent === "stray");
    expect(row).toMatchObject({ workspace: "gone", orphan: true });
    expect(await agents(r, "move", "stray", "-w", "south")).toBe(0);
    expect(readRecord(r.stateDir, "stray")?.workspace).toBe("south");
  });
});
