/**
 * D65 v2: an agent belongs to a project (its workspace, until H5's
 * projects) and, often, one repo. Stored on its record, never guessed
 * from its folder after it is set:
 *
 *   - start proposes the repo from its folder; Start agent here (a repo)
 *     or None says it outright;
 *   - an agent started in the workspace's own folder (Ward's case) and
 *     linked to a repo keeps that repo through every path: stop and
 *     resume, Restart, Start fresh, a persona change, rotation's relaunch
 *     from its handoff, Den's restart (interrupted, resumed), bring-in
 *     after a remove, and a move;
 *   - `agents link --repo`, `agents unlink`; a repo the workspace doesn't
 *     have is refused;
 *   - the one-time migration links old records from their folder and
 *     doctor lists what it couldn't.
 *
 * A real host on a temp socket, a scripted PTY (nothing runs). Invented
 * names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  noteCompaction,
  readRotation,
} from "../../../src/shared/agents/rotation.js";
import {
  readRecord,
  writeRecord,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";
import { claudeSlug } from "../../../src/shared/agents/conversations.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  agentLinkReport,
  changePersona,
  markInterrupted,
  migrateAgentLinks,
  moveAgent,
  proposeRepo,
  resolveAgentsDeps,
  restartAgent,
  startAgent,
  startFresh,
} from "../../../src/ui/cli/agent-ops.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const rec = (r: Rig, id = "planner") => readRecord(r.stateDir, id)!;
const link = (r: Rig, id = "planner") => {
  const x = readRecord(r.stateDir, id);
  return x ? { project: x.project, repo: x.repo } : undefined;
};
const files = (r: Rig, id: string) => path.join(r.stateDir, "agent-files", id);

/** north has notes (two services) and shop; south has notes too. */
async function linkedRig(): Promise<Rig> {
  let wsDir: (ws: string) => string = () => "";
  const r = await rig({
    workspaceServices: (ws) =>
      ws === "north"
        ? [
            { address: "notes/api", path: path.join(wsDir("north"), "notes") },
            { address: "notes/web", path: path.join(wsDir("north"), "notes") },
            { address: "shop", path: path.join(wsDir("north"), "shop") },
          ]
        : ws === "south"
          ? [{ address: "notes/api", path: path.join(wsDir("south"), "notes") }]
          : [],
  });
  wsDir = r.wsDir;
  for (const ws of ["north", "south"])
    for (const repo of ["notes", "shop"])
      fs.mkdirSync(path.join(r.wsDir(ws), repo), { recursive: true });
  // Its PTY ends on TERM, as a real one does.
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
  return r;
}

/** A conversation whose last turn ended: idle, resumable. */
function idle(r: Rig, id = "planner"): void {
  const token = rec(r, id).resumeToken!;
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: rec(r, id).cwd, message: { content: "Plan" } },
      {
        type: "assistant",
        message: {
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

/** Ward's case: started in the workspace's own folder, then linked to notes. */
async function topFolderLinked(): Promise<Rig> {
  const r = await linkedRig();
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  expect(rec(r).cwd).toBe(r.wsDir("north"));
  // The top folder is no repo's: the proposal is none.
  expect(link(r)).toEqual({ project: "north", repo: undefined });
  expect(await agents(r, "link", "planner", "--repo", "notes")).toBe(0);
  expect(r.out.join("\n")).toContain("agent planner works on north › notes");
  expect(link(r)).toEqual({ project: "north", repo: "notes" });
  idle(r);
  return r;
}

const NOTES = { project: "north", repo: "notes" };

describe("D65 v2: set once, proposed from the folder", () => {
  it("a folder inside a repo proposes it; a worktree named for it too; the top folder none", async () => {
    const r = await linkedRig();
    const d = resolveAgentsDeps(r.deps);
    expect(
      proposeRepo(d, "north", path.join(r.wsDir("north"), "shop", "src")),
    ).toBe("shop");
    expect(proposeRepo(d, "north", "/elsewhere/trees/notes")).toBe("notes");
    expect(proposeRepo(d, "north", r.wsDir("north"))).toBeUndefined();
    const s = await startAgent(d, {
      workspace: "north",
      persona: "planner",
      folder: path.join(r.wsDir("north"), "shop"),
    });
    expect([s.rec.project, s.rec.repo]).toEqual(["north", "shop"]);
  });

  it("a start that names the repo (Start agent here) or none (null) says it outright", async () => {
    const r = await linkedRig();
    const d = resolveAgentsDeps(r.deps);
    const a = await startAgent(d, {
      workspace: "north",
      persona: "planner",
      repo: "notes",
    });
    expect(a.rec.repo).toBe("notes");
    const b = await startAgent(d, {
      workspace: "north",
      persona: "reviewer",
      folder: path.join(r.wsDir("north"), "shop"),
      repo: null,
    });
    expect(b.rec.repo).toBeUndefined();
    expect(b.rec.project).toBe("north");
  });
});

describe("D65 v2: link and unlink", () => {
  it("links to a repo of its project, refuses one it hasn't, and unlinks", async () => {
    const r = await topFolderLinked();
    expect(await agents(r, "link", "planner", "--repo", "blog")).toBe(2);
    expect(r.err.join("\n")).toMatch(
      /has no repo "blog" \(it has notes, shop\)/,
    );
    expect(await agents(r, "link", "planner", "--repo", "../x")).toBe(2);
    expect(link(r)).toEqual(NOTES);
    expect(await agents(r, "unlink", "planner")).toBe(0);
    expect(link(r)).toEqual({ project: "north", repo: undefined });
  });
});

describe("D65 v2: Ward's case keeps its repo on every path", () => {
  it("stop, then resume", async () => {
    const r = await topFolderLinked();
    expect(await agents(r, "stop", "planner")).toBe(0);
    await settle();
    expect(link(r)).toEqual(NOTES);
    expect(await agents(r, "resume", "planner")).toBe(0);
    expect(link(r)).toEqual(NOTES);
  });

  it("Restart (and a stale-tools restart, the same path)", async () => {
    const r = await topFolderLinked();
    await restartAgent(resolveAgentsDeps(r.deps), "planner", "north", "now");
    expect(link(r)).toEqual(NOTES);
  });

  it("Start fresh", async () => {
    const r = await topFolderLinked();
    expect(await agents(r, "stop", "planner")).toBe(0);
    await settle();
    await startFresh(resolveAgentsDeps(r.deps), "planner");
    expect(link(r)).toEqual(NOTES);
  });

  it("a persona change", async () => {
    const r = await topFolderLinked();
    await changePersona(resolveAgentsDeps(r.deps), "planner", "north", {
      persona: "reviewer",
      when: "now",
    });
    expect(link(r)).toEqual(NOTES);
  });

  it("rotation: relaunch from its handoff, a new conversation", async () => {
    const r = await topFolderLinked();
    const c = await connectHost(sessionPaths(r.stateDir).socket);
    c.write(rec(r).session.id, Buffer.from("plan it\r"));
    await settle();
    c.close();
    const token = rec(r).resumeToken!;
    const after = readRotation(files(r, "planner"))!.after;
    for (let i = 0; i < 3; i++)
      noteCompaction(
        files(r, "planner"),
        { session_id: token, trigger: "auto" },
        after,
      );
    fs.writeFileSync(
      path.join(files(r, "planner"), "handoff.md"),
      GOOD_HANDOFF,
    );
    expect(await agents(r, "stop", "planner")).toBe(0);
    await settle();
    expect(await agents(r, "relaunch", "planner")).toBe(0);
    expect(rec(r).resumeToken).not.toBe(token);
    expect(link(r)).toEqual(NOTES);
  });

  it("Den's restart: marked interrupted, resumed", async () => {
    const r = await topFolderLinked();
    for (const p of r.made) p.exit(0);
    await settle();
    await markInterrupted(resolveAgentsDeps(r.deps), { autoResume: false });
    expect(link(r)).toEqual(NOTES);
    expect(await agents(r, "resume", "planner")).toBe(0);
    expect(link(r)).toEqual(NOTES);
  });

  it("bring-in after a remove: the same conversation keeps its repo", async () => {
    const r = await topFolderLinked();
    const token = rec(r).resumeToken!;
    expect(await agents(r, "stop", "planner")).toBe(0);
    await settle();
    expect(await agents(r, "rm", "planner")).toBe(0);
    const claude = path.join(r.dir, "claude-config");
    const dir = path.join(claude, "projects", claudeSlug(r.wsDir("north")));
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
            content: [{ type: "text", text: "Planned." }],
          },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
    const t = new Date(Date.now() - 120_000);
    fs.utimesSync(file, t, t);
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
    expect(r.err.join("\n")).toBe("");
    expect(link(r)).toEqual(NOTES);
  });

  it("a move: its project is the new workspace; the repo stays when it has it", async () => {
    const r = await topFolderLinked();
    expect(await agents(r, "stop", "planner")).toBe(0);
    await settle();
    await moveAgent(resolveAgentsDeps(r.deps), "planner", "north", "south");
    expect(link(r)).toEqual({ project: "south", repo: "notes" });
  });
});

describe("D65 v2: the one-time migration and doctor", () => {
  it("links records from before from their folder; doctor lists the rest", async () => {
    const r = await linkedRig();
    const d = resolveAgentsDeps(r.deps);
    const old = (id: string, cwd: string): AgentRecord =>
      ({
        id,
        persona: "planner",
        runtime: "den-claude",
        workspace: "north",
        cwd,
        session: { id: `s-${id}` },
        sessionName: `acme-north:${id}`,
        startedAt: new Date().toISOString(),
      }) as unknown as AgentRecord;
    writeRecord(
      r.stateDir,
      old("in-shop", path.join(r.wsDir("north"), "shop")),
    );
    writeRecord(r.stateDir, old("at-top", r.wsDir("north")));
    const m = migrateAgentLinks(d);
    expect(m).toEqual({ linked: ["in-shop"], unlinked: ["at-top"] });
    expect(link(r, "in-shop")).toEqual({ project: "north", repo: "shop" });
    expect(link(r, "at-top")).toEqual({ project: "north", repo: undefined });
    // Once: a second run changes nothing, and a person's choice stays.
    expect(migrateAgentLinks(d)).toEqual({ linked: [], unlinked: [] });
    // A repo the workspace lost is listed, never dropped.
    writeRecord(r.stateDir, { ...rec(r, "in-shop"), repo: "gone" });
    const rep = agentLinkReport(d);
    expect(rep.missing).toEqual([
      { id: "in-shop", project: "north", repo: "gone" },
    ]);
    expect(rep.noRepo).toEqual([{ id: "at-top", project: "north" }]);
    expect(rec(r, "in-shop").repo).toBe("gone");
  });
});
