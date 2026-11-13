/**
 * AG-14: resume a stopped or interrupted agent, start it fresh, remove it.
 *
 *   - Resume is always the runtime's own resume with the record's token
 *     (den-claude: `--resume <token>`), in the record's cwd and workspace
 *     with the grants it had, never more than the config gives now: after
 *     a normal stop, and after a restart (the session host gone).
 *   - A record with no token, or a runtime that can't resume, is never
 *     resumed: its row says why, and only Start fresh applies.
 *   - A restart marks agents Interrupted (never dropped); a host that
 *     survived marks nothing. Standing personas and `resume_on_restart:
 *     true` resume on their own; others wait.
 *   - Remove forgets a stopped agent (Undo brings it back), never a
 *     running one; `rm --stopped`, `list --stopped`, and the user.yml
 *     setting that forgets old stopped ones (interrupted ones never).
 *
 * A real host on a temp socket, a scripted PTY (nothing runs), and a
 * `claude` shim that must never run. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { configuredRemoveStoppedAfter } from "../../../src/shared/den-config.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  markInterrupted,
  pruneStopped,
  removeAgent,
  resolveAgentsDeps,
  restoreAgents,
  resumeAgent,
  startFresh,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;
const ops = (r: Rig) => resolveAgentsDeps(r.deps);

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

async function typeInto(r: Rig, id: string, text: string): Promise<void> {
  const sid = (record(r, id).session as { id: string }).id;
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(sid, Buffer.from(text));
  await settle();
  c.close();
  // Claude Code writes the conversation's transcript once prompted.
  const token = record(r, id).resumeToken as string | undefined;
  if (token) {
    const claude = path.join(r.dir, "claude-config");
    const dir = path.join(claude, "projects", "-work");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${token}.jsonl`), "{}\n");
    r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
  }
}

async function listRows(r: Rig, ws: string, ...more: string[]) {
  r.out.length = 0;
  expect(await agents(r, "list", "-w", ws, "--json", ...more)).toBe(0);
  return JSON.parse(r.out.join("\n")) as Array<Record<string, unknown>>;
}

function persona(r: Rig, name: string, extra: string): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n${extra}---\nYou work.\n`,
  );
  r.config.personaPacks = ["personas"];
}

/** A started, prompted agent with a grant: there is a conversation. */
async function prompted(r: Rig, id = "planner"): Promise<string> {
  r.config.agents = { [id]: { grants: ["south"] } };
  expect(await agents(r, "start", "-w", "north", "--persona", id)).toBe(0);
  await typeInto(r, id, "plan the release\r");
  return record(r, id).resumeToken as string;
}

describe("Resume keeps the conversation, the folder and the scope", () => {
  it("after a normal stop: --resume <token>, the record's cwd, workspace and grants", async () => {
    const r = await rig();
    const token = await prompted(r);
    expect(record(r, "planner").grants).toEqual(["south"]);
    expect(await agents(r, "stop", "planner")).toBe(0);
    r.made[0].exit(0);
    await settle();
    const [row] = await listRows(r, "north");
    expect(row).toMatchObject({ state: "stopped", resumable: true });
    expect(typeof row.stoppedAt).toBe("string");

    expect(await agents(r, "resume", "planner")).toBe(0);
    const p = r.made[1];
    expect(p.args.slice(0, 2)).toEqual(["--resume", token]);
    expect(p.args).not.toContain("--session-id");
    expect(p.opts.cwd).toBe(record(r, "planner").cwd);
    expect(p.opts.cwd).toBe(r.wsDir("north"));
    expect(record(r, "planner").workspace).toBe("north");
    expect(record(r, "planner").grants).toEqual(["south"]);
    const args = mcpArgs(r, "planner");
    expect(
      args.slice(args.indexOf("--workspace"), args.indexOf("--workspace") + 2),
    ).toEqual(["--workspace", "north"]);
    expect(args.filter((a, i) => args[i - 1] === "--grant")).toEqual(["south"]);
    expect(fs.existsSync(r.ran)).toBe(false);
  });

  it("after a restart: Interrupted, then --resume <token> in its own cwd with its grants", async () => {
    const r = await rig();
    const token = await prompted(r);
    const cwd = record(r, "planner").cwd;
    await r.restartHost();
    const [row] = await listRows(r, "north");
    expect(row).toMatchObject({
      agent: "planner",
      state: "interrupted",
      resumable: true,
    });

    const found = await markInterrupted(ops(r), { autoResume: false });
    expect(found.interrupted).toEqual(["planner"]);
    expect(typeof record(r, "planner").interruptedAt).toBe("string");

    const s = await resumeAgent(ops(r), "planner");
    expect(s.fresh).toBe(false);
    const p = r.made[r.made.length - 1];
    expect(p.args.slice(0, 2)).toEqual(["--resume", token]);
    expect(p.opts.cwd).toBe(cwd);
    expect(record(r, "planner")).toMatchObject({
      workspace: "north",
      grants: ["south"],
    });
    expect(record(r, "planner").interruptedAt).toBeUndefined();
    const args = mcpArgs(r, "planner");
    expect(args).toEqual(
      expect.arrayContaining(["--workspace", "north", "--grant", "south"]),
    );
    expect((await listRows(r, "north"))[0].state).toBe("running");
  });

  it("a resume never widens the scope: a grant taken out of the config is gone, one added isn't taken", async () => {
    const r = await rig();
    await prompted(r);
    await r.restartHost();
    r.config.agents = { planner: { grants: [] } };
    await resumeAgent(ops(r), "planner");
    expect(record(r, "planner").grants).toEqual([]);
    expect(mcpArgs(r, "planner")).not.toContain("--grant");
  });

  it("a record without a resume token is never resumed: only Start fresh, which is a new conversation", async () => {
    const r = await rig();
    await prompted(r);
    const old = record(r, "planner").resumeToken;
    const rec = record(r, "planner");
    delete rec.resumeToken;
    writeRecord(r.stateDir, rec as never);
    await r.restartHost();
    const [row] = await listRows(r, "north");
    expect(row).toMatchObject({ state: "interrupted", resumable: false });
    expect(row.noResume).toMatch(/no conversation to resume/);
    const before = r.made.length;
    expect(await agents(r, "resume", "planner")).toBe(1);
    expect(r.err.join("\n")).toMatch(/no conversation to resume/);
    expect(r.made).toHaveLength(before);

    await startFresh(ops(r), "planner");
    const p = r.made[r.made.length - 1];
    expect(p.args[0]).toBe("--session-id");
    expect(p.args).not.toContain("--resume");
    expect(record(r, "planner").resumeToken).not.toBe(old);
    expect(record(r, "planner").persona).toBe("planner");
  });

  // Ward, 0.4.36: relaunch refused `model: "claude-opus-5-5" is not one of
  // den-claude's (opus, sonnet, haiku)` for agents whose record kept the
  // transcript's full model name. The same choices go to Relaunch.
  // #56: ten records on the 0.4.36 install came from a CLI start that
  // named `--model claude-opus-5-5` (kept as given, no version) in a
  // project with a default mode (the permission override).
  it("agents start --model <full name> stores its alias, pinned; it runs on the same model", async () => {
    const r = await rig();
    const code = await agents(
      r,
      "start",
      "-w",
      "north",
      "--persona",
      "planner",
      "--model",
      "claude-opus-5-5",
    );
    expect([code, r.err.join("\n")]).toEqual([0, ""]);
    const p = r.made[r.made.length - 1];
    expect(p.args[p.args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    expect(record(r, "planner")).toMatchObject({
      model: "opus",
      version: "claude-opus-5-5",
    });
    expect(record(r, "planner").overrides).toContain("model");
  });

  it("a record holding a full model name starts fresh on it, and is stored as its alias, pinned", async () => {
    const r = await rig();
    await prompted(r);
    const rec = record(r, "planner");
    writeRecord(r.stateDir, {
      ...rec,
      model: "claude-opus-5-5",
      version: "latest",
    } as never);
    await r.restartHost();
    await startFresh(ops(r), "planner");
    const p = r.made[r.made.length - 1];
    expect(p.args[p.args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    expect(record(r, "planner")).toMatchObject({
      model: "opus",
      version: "claude-opus-5-5",
    });
  });

  it("a runtime that can't resume (codex) shows why, and Resume is refused", async () => {
    const r = await rig();
    writeRecord(r.stateDir, {
      id: "coder",
      persona: "be-dev",
      runtime: "codex",
      workspace: "north",
      cwd: r.wsDir("north"),
      session: { backend: "den-pty", id: "gone-coder" },
      sessionName: "acme-north:coder",
      startedAt: "2026-11-06T09:30:00.000Z",
      stoppedAt: "2026-11-06T10:30:00.000Z",
    });
    const [row] = await listRows(r, "north");
    expect(row).toMatchObject({
      state: "stopped",
      resumable: false,
      noResume: "codex can't resume a conversation",
    });
    expect(await agents(r, "resume", "coder")).toBe(1);
    expect(r.err.join("\n")).toMatch(/codex can't resume a conversation/);
    expect(r.made).toHaveLength(0);
  });
});

describe("after a restart (AG-14.3)", () => {
  it("a host that survived a web-server-only restart marks nothing", async () => {
    const r = await rig();
    await prompted(r);
    const found = await markInterrupted(ops(r), { autoResume: false });
    expect(found.interrupted).toEqual([]);
    expect(record(r, "planner").interruptedAt).toBeUndefined();
  });

  it("standing personas and resume_on_restart resume on their own; others wait for a click", async () => {
    const r = await rig();
    persona(r, "planner", "standing: true\n");
    persona(r, "helper", "resume_on_restart: true\n");
    persona(r, "reviewer", "");
    for (const id of ["planner", "helper", "reviewer"]) {
      expect(await agents(r, "start", "-w", "north", "--persona", id)).toBe(0);
      await typeInto(r, id, "go\r");
    }
    await r.restartHost();
    const found = await markInterrupted(ops(r));
    expect(found.interrupted.sort()).toEqual(["helper", "planner", "reviewer"]);
    expect(found.resumed.sort()).toEqual(["helper", "planner"]);
    const rows = await listRows(r, "north");
    const st = Object.fromEntries(rows.map((x) => [x.agent, x.state]));
    expect(st).toEqual({
      helper: "running",
      planner: "running",
      reviewer: "interrupted",
    });
    // Each resumed with its own conversation.
    const resumed = r.made.slice(3);
    for (const p of resumed) expect(p.args[0]).toBe("--resume");
  });

  it("D59: an agent's own Resume after a restart is over its persona's; default goes back to the persona's", async () => {
    const r = await rig();
    persona(r, "planner", "standing: true\n");
    persona(r, "reviewer", "");
    for (const id of ["planner", "reviewer"]) {
      expect(await agents(r, "start", "-w", "north", "--persona", id)).toBe(0);
      await typeInto(r, id, "go\r");
    }
    let rows = await listRows(r, "north");
    const of = (id: string) => rows.find((x) => x.agent === id)!;
    expect(of("planner").resumesOnRestart).toBe(true);
    expect(of("reviewer").resumesOnRestart).toBe(false);
    expect(of("reviewer").resumeOnRestart).toBeUndefined();
    expect(await agents(r, "set", "reviewer", "resume_on_restart", "on")).toBe(
      0,
    );
    expect(
      await agents(
        r,
        "set",
        "planner",
        "-w",
        "north",
        "resume_on_restart",
        "off",
      ),
    ).toBe(0);
    rows = await listRows(r, "north");
    expect(of("reviewer")).toMatchObject({
      resumeOnRestart: true,
      resumesOnRestart: true,
    });
    expect(of("planner").resumesOnRestart).toBe(false);
    await r.restartHost();
    const found = await markInterrupted(ops(r));
    expect(found.resumed).toEqual(["reviewer"]);
    // Default: the persona's again (standing: on).
    expect(
      await agents(r, "set", "planner", "resume_on_restart", "default"),
    ).toBe(0);
    expect(record(r, "planner").resumeOnRestart).toBeUndefined();
    expect(
      (await listRows(r, "north")).find((x) => x.agent === "planner")!
        .resumesOnRestart,
    ).toBe(true);
  });

  it("D59: `agents set` takes only resume_on_restart on|off|default, and only from a person", async () => {
    const r = await rig();
    await prompted(r);
    expect(await agents(r, "set", "planner", "resume_on_restart", "yes")).toBe(
      2,
    );
    expect(await agents(r, "set", "planner", "colour", "on")).toBe(2);
    r.deps.env = { ...r.deps.env, DEN_ACTOR_TOKEN: "x" };
    expect(
      await agents(r, "set", "planner", "resume_on_restart", "on"),
    ).not.toBe(0);
    expect(record(r, "planner").resumeOnRestart).toBeUndefined();
  });

  it("den#48: an agent resumes in the mode it started in, after its persona and workspace change, by a click, Resume all, and on its own after a restart", async () => {
    const r = await rig();
    persona(r, "planner", "permission_mode: auto\nstanding: true\n");
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    await typeInto(r, "planner", "go\r");
    const modeOf = (args: string[]) =>
      args[args.indexOf("--permission-mode") + 1];
    expect(modeOf(r.made[0].args)).toBe("auto");
    // Later, the persona asks and the workspace says edits.
    persona(r, "planner", "permission_mode: ask\nstanding: true\n");
    r.wsPermission.north = "edits";
    // On its own after a restart of the session host.
    await r.restartHost();
    expect((await markInterrupted(ops(r))).resumed).toEqual(["planner"]);
    expect(modeOf(r.made.at(-1)!.args)).toBe("auto");
    // Resume all.
    await r.restartHost();
    await markInterrupted(ops(r), { autoResume: false });
    expect(await agents(r, "resume", "--all-interrupted")).toBe(0);
    expect(modeOf(r.made.at(-1)!.args)).toBe("auto");
    // A click.
    expect(await agents(r, "stop", "planner")).toBe(0);
    r.made.at(-1)!.exit(0);
    await settle();
    expect(await agents(r, "resume", "planner")).toBe(0);
    expect(r.made.at(-1)!.args[0]).toBe("--resume");
    expect(modeOf(r.made.at(-1)!.args)).toBe("auto");
  });

  it("`agents resume --all-interrupted` resumes each interrupted agent that can", async () => {
    const r = await rig();
    await prompted(r);
    await r.restartHost();
    r.out.length = 0;
    expect(await agents(r, "resume", "--all-interrupted")).toBe(0);
    expect(r.out.join("\n")).toMatch(/resumed agent planner/);
    expect(r.made[r.made.length - 1].args[0]).toBe("--resume");
    r.out.length = 0;
    expect(await agents(r, "resume", "--all-interrupted")).toBe(0);
    expect(r.out.join("\n")).toMatch(/no interrupted agents/);
  });

  it("an agent whose session exited is Exited (code n), even after the host forgets it", async () => {
    const r = await rig();
    await prompted(r);
    r.made[0].exit(3);
    await settle();
    expect((await listRows(r, "north"))[0].state).toBe("exited (3)");
    await r.restartHost();
    expect((await listRows(r, "north"))[0].state).toBe("exited (3)");
    expect(
      (await markInterrupted(ops(r), { autoResume: false })).interrupted,
    ).toEqual([]);
  });
});

describe("Remove (AG-14.1b)", () => {
  it("a running agent can't be removed; a stopped one goes, and Undo brings it back", async () => {
    const r = await rig();
    await prompted(r);
    expect(await agents(r, "rm", "planner")).toBe(1);
    expect(r.err.join("\n")).toMatch(/agent planner is running: stop it first/);
    await agents(r, "stop", "planner");
    r.made[0].exit(0);
    await settle();
    r.out.length = 0;
    expect(await agents(r, "rm", "planner")).toBe(0);
    expect(r.out.join("\n")).toMatch(/removed agent planner/);
    expect(await listRows(r, "north")).toEqual([]);
    expect(restoreAgents(ops(r), ["planner"])).toEqual(["planner"]);
    const [row] = await listRows(r, "north");
    expect(row).toMatchObject({ agent: "planner", state: "stopped" });
  });

  it("`rm --stopped` removes every stopped, interrupted or exited agent, never a running one; `list --stopped` shows them", async () => {
    const r = await rig();
    persona(r, "a1", "");
    persona(r, "a2", "");
    persona(r, "a3", "");
    for (const id of ["a1", "a2", "a3"])
      await agents(r, "start", "-w", "north", "--persona", id);
    await agents(r, "stop", "a1");
    r.made[0].exit(0);
    r.made[1].exit(2);
    await settle();
    const stopped = await listRows(r, "north", "--stopped");
    expect(stopped.map((x) => x.agent).sort()).toEqual(["a1", "a2"]);
    r.out.length = 0;
    expect(await agents(r, "rm", "--stopped", "-w", "north")).toBe(0);
    expect(r.out.join("\n")).toMatch(/removed 2 stopped agents: a1, a2/);
    expect((await listRows(r, "north")).map((x) => x.agent)).toEqual(["a3"]);
  });

  it("removing leaves the runtime's own history alone and revokes nothing it shouldn't", async () => {
    const r = await rig();
    await prompted(r);
    await agents(r, "stop", "planner");
    r.made[0].exit(0);
    await settle();
    const gone = await removeAgent(ops(r), "planner");
    expect(gone).toEqual([{ agent: "planner", workspace: "north" }]);
    expect(fs.existsSync(path.join(r.stateDir, "agents", "planner.json"))).toBe(
      false,
    );
  });
});

describe("agents.remove_stopped_after (user.yml)", () => {
  it("reads never (the default), 1d and 7d, and refuses anything else naming the key", () => {
    expect(configuredRemoveStoppedAfter(() => ({}))).toBe(0);
    expect(
      configuredRemoveStoppedAfter(() => ({
        agents: { remove_stopped_after: "never" },
      })),
    ).toBe(0);
    expect(
      configuredRemoveStoppedAfter(() => ({
        agents: { remove_stopped_after: "1d" },
      })),
    ).toBe(1);
    expect(
      configuredRemoveStoppedAfter(() => ({
        agents: { remove_stopped_after: "7d" },
      })),
    ).toBe(7);
    expect(() =>
      configuredRemoveStoppedAfter(() => ({
        agents: { remove_stopped_after: "3d" },
      })),
    ).toThrow(/agents\.remove_stopped_after.*never, 1d or 7d/);
  });

  it("forgets stopped and exited agents older than the setting; never an interrupted one", async () => {
    const r = await rig();
    const base = {
      persona: "reviewer",
      runtime: "den-claude",
      workspace: "north",
      cwd: r.wsDir("north"),
      startedAt: "2026-11-01T09:00:00.000Z",
      resumeToken: "00000000-0000-4000-8000-000000000001",
    };
    const now = Date.parse("2026-11-07T12:00:00.000Z");
    writeRecord(r.stateDir, {
      ...base,
      id: "old",
      session: { backend: "den-pty", id: "g1" },
      sessionName: "acme-north:old",
      stoppedAt: "2026-11-05T09:00:00.000Z",
    });
    writeRecord(r.stateDir, {
      ...base,
      id: "recent",
      session: { backend: "den-pty", id: "g2" },
      sessionName: "acme-north:recent",
      stoppedAt: "2026-11-07T09:00:00.000Z",
    });
    writeRecord(r.stateDir, {
      ...base,
      id: "lost",
      session: { backend: "den-pty", id: "g3" },
      sessionName: "acme-north:lost",
      interruptedAt: "2026-11-01T10:00:00.000Z",
    });
    writeRecord(r.stateDir, {
      ...base,
      id: "ended",
      session: { backend: "den-pty", id: "g4" },
      sessionName: "acme-north:ended",
      endedAt: "2026-11-02T10:00:00.000Z",
      exitCode: 0,
    });
    expect(await pruneStopped(ops(r), 0, now)).toEqual([]);
    expect((await pruneStopped(ops(r), 1, now)).sort()).toEqual([
      "ended",
      "old",
    ]);
    expect((await listRows(r, "north")).map((x) => x.agent).sort()).toEqual([
      "lost",
      "recent",
    ]);
  });
});
