/**
 * Gap 7 (0.4.48): an agent started with no folder works in its project's
 * own repo, never in the folder above the repos:
 *
 *   - the repo it is linked to (`--repo`, Start agent here), else the
 *     project's first repo; a project with no repos keeps its own folder;
 *   - `agents start` takes `--repo <repo>` and `--folder <path>` (a
 *     worktree, say), as the web route does;
 *   - `agents folder <id> (--repo <repo> | --folder <path>)` moves a
 *     stopped agent to another folder of its project: its next start is a
 *     new conversation there (a conversation belongs to its folder).
 *
 * A real host on a temp socket, a scripted PTY (nothing runs). Invented
 * names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  resolveAgentsDeps,
  startAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const rec = (r: Rig, id = "planner") => readRecord(r.stateDir, id)!;

/** north has notes (first) and shop; empty has no repos. */
async function repoRig(): Promise<Rig> {
  let wsDir: (ws: string) => string = () => "";
  const r = await rig({
    workspaceServices: (ws) =>
      ws === "north"
        ? [
            { address: "notes/api", path: path.join(wsDir("north"), "notes") },
            { address: "shop", path: path.join(wsDir("north"), "shop") },
          ]
        : [],
  });
  wsDir = r.wsDir;
  for (const repo of ["notes", "shop"])
    fs.mkdirSync(path.join(r.wsDir("north"), repo), { recursive: true });
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

describe("gap 7: no folder given", () => {
  it("works in the project's first repo, linked to it, never the folder above the repos", async () => {
    const r = await repoRig();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(rec(r).cwd).toBe(path.join(r.wsDir("north"), "notes"));
    expect(rec(r).repo).toBe("notes");
  });

  it("the repo it is started for (--repo, Start agent here) is its folder", async () => {
    const r = await repoRig();
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--repo",
        "shop",
      ),
    ).toBe(0);
    expect([rec(r).cwd, rec(r).repo]).toEqual([
      path.join(r.wsDir("north"), "shop"),
      "shop",
    ]);
    const s = await startAgent(resolveAgentsDeps(r.deps), {
      workspace: "north",
      persona: "reviewer",
      repo: "notes",
    });
    expect(s.rec.cwd).toBe(path.join(r.wsDir("north"), "notes"));
  });

  it("a repo the project doesn't have is refused, and nothing starts", async () => {
    const r = await repoRig();
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--repo",
        "ghost",
      ),
    ).not.toBe(0);
    expect(readRecord(r.stateDir, "planner")).toBeNull();
  });

  it("--folder: a folder of the project's (a worktree, a subfolder) as given", async () => {
    const r = await repoRig();
    const sub = path.join(r.wsDir("north"), "shop", "src");
    fs.mkdirSync(sub, { recursive: true });
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--folder",
        sub,
      ),
    ).toBe(0);
    expect([rec(r).cwd, rec(r).repo]).toEqual([sub, "shop"]);
  });

  it("an agent the bug left in the folder above the repos moves to a repo at its next start; a chosen folder stays", async () => {
    const r = await repoRig();
    const top = r.wsDir("north");
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--folder",
        top,
      ),
    ).toBe(0);
    expect(await agents(r, "stop", "planner")).toBe(0);
    const d = resolveAgentsDeps(r.deps);
    const again = await startAgent(d, {
      workspace: "north",
      persona: "planner",
      id: "planner",
    });
    expect(again.rec.cwd).toBe(path.join(top, "notes"));
    expect(await agents(r, "stop", "planner")).toBe(0);
    expect(await agents(r, "folder", "planner", "--repo", "shop")).toBe(0);
    const kept = await startAgent(d, {
      workspace: "north",
      persona: "planner",
      id: "planner",
    });
    expect(kept.rec.cwd).toBe(path.join(top, "shop"));
  });

  it("a project with no repos keeps its own folder", async () => {
    const r = await repoRig();
    fs.mkdirSync(r.wsDir("south"), { recursive: true });
    const s = await startAgent(resolveAgentsDeps(r.deps), {
      workspace: "south",
      persona: "planner",
    });
    expect(s.rec.cwd).toBe(r.wsDir("south"));
  });
});

describe("gap 7: agents folder", () => {
  it("moves a stopped agent to another repo of its project; its next start is new, there", async () => {
    const r = await repoRig();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(await agents(r, "stop", "planner")).toBe(0);
    expect(await agents(r, "folder", "planner", "--repo", "shop")).toBe(0);
    expect([rec(r).cwd, rec(r).repo]).toEqual([
      path.join(r.wsDir("north"), "shop"),
      "shop",
    ]);
    expect(rec(r).resumeToken).toBeUndefined();
    expect(r.out.join("\n")).toMatch(/new conversation/);
  });

  it("refused while it runs (stop it first), and for a folder outside its project", async () => {
    const r = await repoRig();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    const before = rec(r).cwd;
    expect(await agents(r, "folder", "planner", "--repo", "shop")).not.toBe(0);
    expect(r.err.join("\n")).toMatch(/stop it first/);
    expect(await agents(r, "stop", "planner")).toBe(0);
    expect(
      await agents(r, "folder", "planner", "--folder", "/elsewhere/x"),
    ).not.toBe(0);
    expect(rec(r).cwd).toBe(before);
  });
});
