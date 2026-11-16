/**
 * Issue 277: a shared repo, such as one holding shared components, can be
 * in more than one project, and a repo that runs nothing (config, docs,
 * rulesets, shared CI) is one of the project's repos like any other.
 *
 * The project's repos come from the real listing (listWorkspaceServices)
 * and its folders from the real repoFolders, over invented
 * projects and repos in a temp folder. Agents start on a real host with a
 * scripted PTY (nothing runs).
 *
 * - One repo in projects north and south: an agent created in each, each
 *   in its own folder of that repo (a git worktree per project).
 * - Removing the repo from north leaves south, and south's agent, intact.
 * - A repo that runs nothing and a repo with services both work shared.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { readRecord } from "../../../src/shared/agents/records.js";
import {
  listWorkspaceServices,
  repoFolders,
} from "../../../src/shared/environment-manager/workspaces.js";
import type {
  ServiceCatalog,
  WorkspaceConfig,
} from "../../../src/shared/types/index.js";
import {
  checkAgentCreate,
  createAgent,
  resolveAgentsDeps,
  workspaceRepoFolders,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      ...args,
    ],
    { cwd, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

interface Shared {
  r: Rig;
  projects: Record<string, WorkspaceConfig>;
  repos: Record<string, string>;
}

/** Two projects, each holding the shared repos `kit` and `cfg`. */
async function sharedRig(): Promise<Shared> {
  const projects: Record<string, WorkspaceConfig> = {};
  const catalog: ServiceCatalog = {};
  let wsDir: (ws: string) => string = () => "";
  const r = await rig({
    workspaceServices: (ws) =>
      projects[ws]
        ? listWorkspaceServices(projects[ws], catalog, ws).map((s) => ({
            address: s.address,
            path: s.repoPath,
          }))
        : [],
    // As conversationFolders: the project's own folder and each by-path
    // repo's folder.
    workspaceFolders: (ws) => ({
      under: [wsDir(ws), ...repoFolders(projects[ws])],
    }),
  });
  wsDir = r.wsDir;
  const root = path.join(r.dir, "repos");
  const repos: Record<string, string> = {
    // Shared components: one service.
    kit: path.join(root, "kit"),
    // Config and shared CI: runs nothing.
    cfg: path.join(root, "cfg"),
  };
  fs.mkdirSync(repos.kit, { recursive: true });
  fs.writeFileSync(
    path.join(repos.kit, ".den.yml"),
    'name: kit\nservices:\n  kit:\n    commands:\n      local:\n        up: "true"\n',
  );
  fs.mkdirSync(repos.cfg, { recursive: true });
  fs.writeFileSync(
    path.join(repos.cfg, ".den.yml"),
    "name: cfg\nservices: {}\n",
  );
  for (const dir of Object.values(repos)) {
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
  }
  for (const name of Object.keys(repos)) catalog[name] = { gh: "" };
  for (const ws of ["north", "south"])
    projects[ws] = {
      services: Object.fromEntries(
        Object.entries(repos).map(([name, p]) => [
          name,
          { mode: "dev-managed" as const, path: p },
        ]),
      ),
    };
  return { r, projects, repos };
}

describe("a shared repo in two projects (issue 277)", () => {
  it("is one of each project's repos, whether it runs nothing or runs a service", async () => {
    const { r, repos } = await sharedRig();
    const d = resolveAgentsDeps(r.deps);
    for (const ws of ["north", "south"])
      expect(Object.fromEntries(workspaceRepoFolders(d, ws))).toEqual({
        kit: repos.kit,
        cfg: repos.cfg,
      });
  });

  it("an agent created in each project, each in its own worktree of the shared repo", async () => {
    const { r, repos } = await sharedRig();
    const d = resolveAgentsDeps(r.deps);
    const started: Record<string, { id: string; cwd?: string }> = {};
    for (const ws of ["north", "south"]) {
      // Each project's own worktree of the shared repo, in its folder.
      const wt = path.join(r.wsDir(ws), "cfg-work");
      git(repos.cfg, "worktree", "add", "-q", "-b", `work-${ws}`, wt);
      const c = checkAgentCreate(d, {
        project: ws,
        persona: "planner",
        name: `Lead ${ws}`,
        folder: wt,
      });
      expect(c.ok ? "" : c.error).toBe("");
      if (!c.ok) return;
      const out = await createAgent(d, c.args);
      expect(out).toMatchObject({ ok: true, project: ws, cwd: wt });
      started[ws] = out as { id: string; cwd?: string };
    }
    expect(started.north.id).not.toBe(started.south.id);
    expect(readRecord(r.stateDir, started.north.id)?.workspace).toBe("north");
    expect(readRecord(r.stateDir, started.south.id)?.workspace).toBe("south");
    expect(r.made).toHaveLength(2);
  });

  it("agent_create with repo: the shared repo, in either project, runs nothing or not", async () => {
    const { r, repos } = await sharedRig();
    const d = resolveAgentsDeps(r.deps);
    for (const ws of ["north", "south"])
      for (const repo of ["cfg", "kit"]) {
        const c = checkAgentCreate(d, {
          project: ws,
          persona: "reviewer",
          repo,
        });
        expect(c.ok ? c.summary : c.error).toBe(
          `start agent reviewer (reviewer) in ${ws} › ${repo}, mode ask`,
        );
        expect(c.ok && c.details.join("\n")).toContain(repos[repo]);
      }
  });

  it("removing it from one project leaves the other, and the other's agent, intact", async () => {
    const { r, projects, repos } = await sharedRig();
    const d = resolveAgentsDeps(r.deps);
    const south = checkAgentCreate(d, {
      project: "south",
      persona: "planner",
      repo: "cfg",
    });
    expect(south.ok).toBe(true);
    if (!south.ok) return;
    const out = (await createAgent(d, south.args)) as {
      ok: boolean;
      id: string;
    };
    expect(out).toMatchObject({ ok: true, cwd: repos.cfg, repo: "cfg" });
    const before = readRecord(r.stateDir, out.id);

    // As the project page's remove does: north's entry only.
    delete projects.north.services.cfg;

    const north = checkAgentCreate(d, {
      project: "north",
      persona: "planner",
      repo: "cfg",
    });
    expect(north.ok ? "" : north.error).toMatch(
      /project north has no repo "cfg"/,
    );
    expect([...workspaceRepoFolders(d, "south").keys()]).toEqual([
      "kit",
      "cfg",
    ]);
    expect(projects.south.services.cfg).toEqual({
      mode: "dev-managed",
      path: repos.cfg,
    });
    const after = readRecord(r.stateDir, out.id);
    expect(after).toMatchObject({
      workspace: "south",
      repo: "cfg",
      cwd: repos.cfg,
    });
    expect(after?.cwd).toBe(before?.cwd);
    // South can still add agents in it.
    expect(
      checkAgentCreate(d, { project: "south", persona: "planner", repo: "cfg" })
        .ok,
    ).toBe(true);
    expect(fs.existsSync(repos.cfg)).toBe(true);
  });
});
