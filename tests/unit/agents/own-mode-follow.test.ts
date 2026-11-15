/**
 * Issue 199: a project mode change says which agents keep their own mode,
 * and can make them follow.
 *
 * - project_mode: the Allow lists the agents with their own mode ("own
 *   mode: auto") and offers one choice, "follow" (off by default). Allow
 *   without it leaves their own mode; with it, clears it. The result says
 *   which agents follow now and which keep their own.
 * - The Agents page row: an agent's own mode, and the project's it does
 *   not follow.
 * - agent_mode: an agent (or Den's own) asks to clear another agent's own
 *   mode; the person's Allow only; Den restarts it on the same
 *   conversation, in the project's mode.
 *
 * A real host on a temp socket, a scripted PTY (nothing runs). Invented
 * names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import {
  checkAgentMode,
  checkProjectMode,
  modeCheck,
  modeResolver,
  resolveAgentsDeps,
  runAgentMode,
  runProjectMode,
} from "../../../src/ui/cli/agent-ops.js";
import { clearPermissionModesCache } from "../../../src/shared/agents/den-claude.js";
import {
  SERVER_AGENT_ID,
  SERVER_SCOPE,
} from "../../../src/shared/agents/server-agent.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  clearPermissionModesCache();
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) =>
  cmdAgents(args, { ...r.deps, loginPath: async () => {} });
const modeOf = (args: string[]) => args[args.indexOf("--permission-mode") + 1];
const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;

function persona(r: Rig, name: string): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n---\nYou work.\n`,
  );
  r.config.personaPacks = ["personas"];
}

/** A turn that ended: its transcript, so after-turn sees it idle. */
async function endedTurn(r: Rig, id: string): Promise<void> {
  const sid = (record(r, id).session as { id: string }).id;
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(sid, Buffer.from("go\r"));
  await settle();
  c.close();
  const token = record(r, id).resumeToken as string;
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: r.wsDir("north"), message: { content: "go" } },
      {
        type: "assistant",
        message: {
          model: "opus",
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

/** Stop waits for the session to end; each scripted one ends on TERM. */
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

/** Project north on auto: scout follows it, pinned has its own mode (auto). */
async function twoAgents(): Promise<Rig> {
  const r = await rig();
  endOnTerm(r);
  persona(r, "scout");
  persona(r, "pinned");
  r.wsPermission.north = "auto";
  expect(await agents(r, "start", "-w", "north", "--persona", "scout")).toBe(0);
  expect(await agents(r, "start", "-w", "north", "--persona", "pinned")).toBe(
    0,
  );
  expect(await agents(r, "permission", "pinned", "auto")).toBe(0);
  return r;
}

describe("issue 199: project_mode names the agents that keep their own mode", () => {
  it("the Allow lists them and why, and offers to make them follow (off)", async () => {
    const r = await twoAgents();
    const c = checkProjectMode(resolveAgentsDeps(r.deps), {
      project: "north",
      mode: "all",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.ownMode).toEqual([{ agent: "pinned", mode: "auto" }]);
    expect(c.choices).toEqual(["follow"]);
    expect(c.details).toContain(
      "These keep their own mode and won't follow the project: pinned (own mode: auto)",
    );
    // Off by default: the args don't clear anything.
    expect(c.args).toEqual({ project: "north", mode: "all" });
  }, 30_000);

  it("Allow without the choice leaves the agent's own mode; the result names who follows and who keeps theirs", async () => {
    const r = await twoAgents();
    const out = await runProjectMode(resolveAgentsDeps(r.deps), {
      project: "north",
      mode: "all",
    });
    expect(out).toEqual({
      ok: true,
      project: "north",
      mode: "all",
      following: ["scout"],
      ownMode: [{ agent: "pinned", mode: "auto" }],
    });
    expect(r.wsPermission.north).toBe("all");
    expect(record(r, "pinned").overrides).toContain("permission");
    expect(record(r, "pinned").permission).toBe("auto");
  }, 30_000);

  it("Allow with the choice clears their own mode: every agent follows", async () => {
    const r = await twoAgents();
    const d = resolveAgentsDeps(r.deps);
    const c = checkProjectMode(d, {
      project: "north",
      mode: "all",
      follow: true,
    });
    expect(c.ok && c.args).toEqual({
      project: "north",
      mode: "all",
      follow: true,
    });
    expect(c.ok && c.details).toContain(
      "And makes them follow the project: their own mode is cleared.",
    );
    const out = await runProjectMode(d, {
      project: "north",
      mode: "all",
      follow: true,
    });
    expect(out).toEqual({
      ok: true,
      project: "north",
      mode: "all",
      following: ["pinned", "scout"],
      ownMode: [],
    });
    expect(record(r, "pinned").overrides ?? []).not.toContain("permission");
  }, 30_000);

  it("no agent with its own mode: no choice, the words as before", async () => {
    const r = await rig();
    r.wsPermission.north = "auto";
    const c = checkProjectMode(resolveAgentsDeps(r.deps), {
      project: "north",
      mode: "all",
    });
    expect(c.ok && c.choices).toBeUndefined();
    expect(c.ok && c.ownMode).toBeUndefined();
  });
});

describe("issue 199: the Agents page row says an agent's own mode", () => {
  it("own mode, and the project's it doesn't follow", async () => {
    const r = await twoAgents();
    r.wsPermission.north = "all";
    const of = modeResolver(resolveAgentsDeps(r.deps), () => null);
    expect(of(record(r, "pinned") as never)).toMatchObject({
      want: "auto",
      own: true,
      followed: "all",
    });
    const follows = of(record(r, "scout") as never);
    expect(follows?.want).toBe("all");
    expect(follows).not.toHaveProperty("own");
    // The row the Agents page draws.
    const c = await connectHost(sessionPaths(r.stateDir).socket);
    const live = await c.list();
    c.close();
    const rows = listedSessions(live, {
      stateDir: () => r.stateDir,
      dist: () => "acme",
      activeWorkspaces: () => ["north"],
      modeOf: () => modeResolver(resolveAgentsDeps(r.deps), () => null),
    });
    expect(rows.find((x) => x.agent === "pinned")).toMatchObject({
      mode: "auto",
      modeOwn: true,
      modeFollowed: "all",
    });
    expect(rows.find((x) => x.agent === "scout")).not.toHaveProperty("modeOwn");
  }, 30_000);
});

describe("issue 199: agent_mode, an ask to make an agent follow its project", () => {
  it("the person sees what it lets the agent do; person-only", async () => {
    const r = await twoAgents();
    r.wsPermission.north = "all";
    const c = checkAgentMode(
      resolveAgentsDeps(r.deps),
      { agent: "pinned" },
      { agent: "scout", project: "north" },
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.summary).toBe(
      "This lets pinned act without asking you: auto → follow project (all)",
    );
    expect(c.params).toEqual({
      agent: "pinned",
      from: "auto",
      to: "all",
      loosens: "1",
    });
    expect(c.personOnly).toBe(true);
    expect(c.args).toEqual({ agent: "pinned", project: "north" });
    expect(c.details.join("\n")).toMatch(
      /Den restarts it after its turn, on the same conversation, in all/,
    );
    // A tightening says it plainly; still the person's.
    r.wsPermission.north = "ask";
    const tight = checkAgentMode(resolveAgentsDeps(r.deps), {
      agent: "pinned",
    });
    expect(tight.ok && tight.summary).toBe(
      "pinned: auto → follow project (ask)",
    );
    expect(tight.ok && tight.personOnly).toBe(true);
  }, 30_000);

  it("refuses: no own mode, another project's agent, Den's own agent, a mode to set", async () => {
    const r = await twoAgents();
    const d = resolveAgentsDeps(r.deps);
    const err = (a: Record<string, unknown>, who = {}) => {
      const c = checkAgentMode(d, a, who);
      return c.ok ? "" : c.error;
    };
    expect(err({ agent: "scout" })).toMatch(
      /scout has no own mode: it follows its project's already/,
    );
    expect(err({ agent: "pinned" }, { agent: "lead", project: "south" })).toBe(
      "lead works in project south: it can ask for that project's agents only, not pinned in project north",
    );
    expect(err({ agent: SERVER_AGENT_ID, project: SERVER_SCOPE })).not.toBe("");
    expect(err({ agent: "pinned", mode: "all" })).toMatch(
      /clears an agent's own mode only/,
    );
    expect(err({ agent: "ghost" })).toMatch(/ghost/);
  }, 30_000);

  it("on Allow: its own mode is cleared and Den restarts it on the same conversation, in the project's mode", async () => {
    const r = await twoAgents();
    r.wsPermission.north = "all";
    await endedTurn(r, "pinned");
    const token = record(r, "pinned").resumeToken;
    const d = resolveAgentsDeps(r.deps);
    const mc = modeCheck(d, { pollMs: 20 });
    const out = await runAgentMode(
      d,
      { agent: "pinned", project: "north" },
      { apply: () => mc.tick() },
    );
    expect(out).toEqual({
      ok: true,
      agent: "pinned",
      project: "north",
      from: "auto",
      mode: "all",
      restarts: true,
    });
    await mc.pending();
    expect(record(r, "pinned").overrides ?? []).not.toContain("permission");
    const last = r.made.at(-1)!;
    expect(last.args.slice(0, 2)).toEqual(["--resume", token]);
    expect(modeOf(last.args)).toBe("bypassPermissions");
  }, 30_000);
});
