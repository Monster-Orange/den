/**
 * D72: move an agent to another workspace, keeping its conversation.
 *
 *   - A stopped agent's record moves: workspace and session name.
 *   - A running one waits for its turn to end (or --now), then resumes
 *     the same conversation in the new workspace, with that workspace's
 *     tools; its name, folder and service link stay.
 *   - Refused: the same workspace, one that doesn't exist, from an
 *     agent's session.
 *   - Import right after Den's own stop and remove isn't taken as "open
 *     in another terminal" (Den's stop wrote that last line).
 *
 * A real host on a temp socket, a scripted PTY (nothing runs). Invented
 * names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { claudeSlug } from "../../../src/shared/agents/conversations.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  DEN_STOP_WRITE_MS,
  moveAgent,
  openOutsideDen,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
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

const ENDED = {
  type: "assistant",
  message: {
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Planned." }],
  },
};
const WORKING = {
  type: "assistant",
  message: {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t1", name: "Bash" }],
  },
};

function transcript(r: Rig, token: string, last: unknown, ageMs = 60_000) {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: r.wsDir("north"), message: { content: "Plan" } },
      last,
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

async function started(
  last: unknown = ENDED,
): Promise<{ r: Rig; token: string }> {
  const r = await rig();
  endOnTerm(r);
  expect(
    await agents(
      r,
      "start",
      "-w",
      "north",
      "--persona",
      "planner",
      "--name",
      "Release plan",
    ),
  ).toBe(0);
  expect(await agents(r, "link", "release-plan", "notes")).toBe(0);
  const token = readRecord(r.stateDir, "release-plan")!.resumeToken!;
  transcript(r, token, last);
  return { r, token };
}

/** The MCP server's argv in the agent's own config (its scope). */
function mcpArgs(r: Rig, id: string): string[] {
  const cfg = JSON.parse(
    fs.readFileSync(
      path.join(r.stateDir, "agent-files", id, "mcp.json"),
      "utf-8",
    ),
  ) as { mcpServers: Record<string, { args: string[] }> };
  return Object.values(cfg.mcpServers)[0].args;
}

describe("D72: agents move", () => {
  it("a stopped agent: its record moves; nothing starts", async () => {
    const { r } = await started();
    expect(await agents(r, "stop", "release-plan")).toBe(0);
    await settle();
    const before = r.made.length;
    expect(await agents(r, "move", "release-plan", "-w", "south")).toBe(0);
    expect(r.out.join("\n")).toContain(
      "moved agent release-plan from north to south; it was stopped",
    );
    const rec = readRecord(r.stateDir, "release-plan")!;
    expect(rec.workspace).toBe("south");
    expect(rec.sessionName).toMatch(/south/);
    expect(rec.displayName).toBe("Release plan");
    expect(rec.services).toEqual(["notes"]);
    expect(r.made).toHaveLength(before);
  });

  it("a running, idle one: the same conversation resumes in the new workspace, with its tools", async () => {
    const { r, token } = await started();
    expect(await agents(r, "move", "release-plan", "-w", "south")).toBe(0);
    expect(r.out.join("\n")).toMatch(
      /moved agent release-plan from north to south; same conversation/,
    );
    const p = r.made[r.made.length - 1];
    expect(p.args.slice(0, 2)).toEqual(["--resume", token]);
    const rec = readRecord(r.stateDir, "release-plan")!;
    expect(rec).toMatchObject({
      workspace: "south",
      resumeToken: token,
      cwd: r.wsDir("north"),
      displayName: "Release plan",
      services: ["notes"],
    });
    expect(mcpArgs(r, "release-plan").join(" ")).toContain("south");
    expect(mcpArgs(r, "release-plan").join(" ")).not.toContain("north");
  });

  it("mid-turn: waits for the turn to end, never cuts it", async () => {
    const { r, token } = await started(WORKING);
    const d = resolveAgentsDeps(r.deps);
    let done = false;
    const m = moveAgent(d, "release-plan", "north", "south", "after-turn", {
      pollMs: 20,
    }).then((x) => {
      done = true;
      return x;
    });
    await new Promise((res) => setTimeout(res, 150));
    expect(done).toBe(false);
    expect(r.made[0].signals).toEqual([]);
    expect(readRecord(r.stateDir, "release-plan")!.workspace).toBe("north");
    transcript(r, token, ENDED);
    const out = await m;
    expect(out.from).toBe("north");
    expect(out.rec.workspace).toBe("south");
    expect(r.made[1].args.slice(0, 2)).toEqual(["--resume", token]);
  });

  it("--now moves at once", async () => {
    const { r, token } = await started(WORKING);
    expect(
      await agents(r, "move", "release-plan", "-w", "south", "--now"),
    ).toBe(0);
    expect(r.made[0].signals.length).toBeGreaterThan(0);
    expect(r.made[1].args.slice(0, 2)).toEqual(["--resume", token]);
  });

  it("refuses the same workspace, one that doesn't exist, and an agent's session", async () => {
    const { r } = await started();
    expect(await agents(r, "move", "release-plan", "-w", "north")).toBe(2);
    expect(await agents(r, "move", "release-plan", "-w", "nowhere")).toBe(1);
    expect(await agents(r, "move", "release-plan")).toBe(2);
    const inAgent = {
      ...r.deps,
      env: { ...r.deps.env, DEN_ACTOR_TOKEN: "den_at_x" },
    };
    expect(
      await cmdAgents(["move", "release-plan", "-w", "south"], inAgent),
    ).toBe(1);
    expect(readRecord(r.stateDir, "release-plan")!.workspace).toBe("north");
  });
});

describe("D72: import after Den's own stop", () => {
  it("stop, rm, then import at once: brought in, not refused as open elsewhere", async () => {
    const r = await rig();
    endOnTerm(r);
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    const token = readRecord(r.stateDir, "planner")!.resumeToken!;
    const claude = path.join(r.dir, "claude-config");
    const dir = path.join(claude, "projects", claudeSlug(r.wsDir("north")));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${token}.jsonl`);
    r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
    const write = () =>
      fs.writeFileSync(
        file,
        [
          { type: "user", cwd: r.wsDir("north"), message: { content: "Plan" } },
          ENDED,
        ]
          .map((x) => JSON.stringify(x))
          .join("\n") + "\n",
      );
    write();
    expect(await agents(r, "stop", "planner")).toBe(0);
    await settle();
    // The runtime's last write as it exits: now, as Den stopped it.
    write();
    expect(await agents(r, "rm", "planner")).toBe(0);
    r.err.length = 0;
    expect(
      await agents(
        r,
        "import",
        "-w",
        "north",
        "--session",
        token,
        "--persona",
        "planner",
      ),
    ).toBe(0);
    expect(r.err.join("\n")).not.toMatch(/another terminal/);
    expect(readRecord(r.stateDir, "planner")?.resumeToken).toBe(token);
  });

  it("a write at Den's stop of a removed agent isn't another terminal's", () => {
    const now = Date.now();
    const lastAt = new Date(now - 2_000).toISOString();
    // Nobody stopped it: written 2 s ago is open elsewhere.
    expect(openOutsideDen(lastAt, undefined, now)).toBe(true);
    // Den stopped it then: the stop's own write.
    expect(openOutsideDen(lastAt, now - 3_000, now)).toBe(false);
    // Den stopped it long before that write: someone opened it since.
    expect(
      openOutsideDen(lastAt, now - 2_000 - DEN_STOP_WRITE_MS - 1_000, now),
    ).toBe(true);
    // Old writes are never open.
    expect(
      openOutsideDen(new Date(now - 120_000).toISOString(), undefined, now),
    ).toBe(false);
  });
});
