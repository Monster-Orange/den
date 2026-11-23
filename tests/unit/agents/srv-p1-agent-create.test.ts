/**
 * SRV-P1 (0.4.48, den#135): the server agent adds an agent to a project
 * (agent_create, a held write). The check says exactly what the Allow
 * starts: the persona, the project, the repo or folder, the runtime and
 * the mode. The mode is the project's or stricter, never wider: with no
 * mode set for the project, only ask. On Allow it starts as `agents
 * start` does (gap 7's folder) and answers with the agent's id.
 *
 * A real host on a temp socket, a scripted PTY (nothing runs). Invented
 * names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { readRecord } from "../../../src/shared/agents/records.js";
import {
  checkAgentCreate,
  createAgent,
  importSandboxOff,
  resolveAgentsDeps,
  runAgentImport,
} from "../../../src/ui/cli/agent-ops.js";
import { SERVER_SCOPE } from "../../../src/shared/agents/server-agent.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

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
  return r;
}

describe("SRV-P1: agent_create's check", () => {
  it("says what the Allow starts: persona, name, project › repo, runtime and mode", async () => {
    const r = await repoRig();
    r.wsPermission.north = "edits";
    const c = checkAgentCreate(resolveAgentsDeps(r.deps), {
      project: "north",
      persona: "reviewer",
      name: "Ana",
      repo: "shop",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.summary).toBe(
      "start agent Ana (reviewer) in north › shop, mode edits",
    );
    expect(c.args).toMatchObject({
      project: "north",
      persona: "reviewer",
      name: "Ana",
      repo: "shop",
    });
    expect(c.details.join("\n")).toMatch(
      new RegExp(path.join(r.wsDir("north"), "shop").replace(/\//g, "\\/")),
    );
  });

  it("no repo or folder: the project's first repo, as agents start", async () => {
    const r = await repoRig();
    const c = checkAgentCreate(resolveAgentsDeps(r.deps), {
      project: "north",
      persona: "planner",
    });
    expect(c.ok && c.summary).toBe(
      "start agent planner (planner) in north › notes, mode ask",
    );
  });

  it("the mode is the project's or stricter; wider is refused, and with none set only ask", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    r.wsPermission.north = "edits";
    expect(
      checkAgentCreate(d, { project: "north", persona: "planner", mode: "ask" })
        .ok,
    ).toBe(true);
    const wide = checkAgentCreate(d, {
      project: "north",
      persona: "planner",
      mode: "all",
    });
    expect(wide.ok ? "" : wide.error).toMatch(
      /mode all is wider than project north's \(edits\)/,
    );
    delete r.wsPermission.north;
    const none = checkAgentCreate(d, {
      project: "north",
      persona: "planner",
      mode: "edits",
    });
    expect(none.ok ? "" : none.error).toMatch(
      /wider than project north's \(ask\)/,
    );
  });

  it("refuses what doesn't exist: the project, the persona, the repo, a folder outside it, a bad mode", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    const why = (a: Record<string, unknown>) => {
      const c = checkAgentCreate(d, {
        project: "north",
        persona: "planner",
        ...a,
      });
      return c.ok ? "" : c.error;
    };
    expect(why({ project: "nowhere" })).toMatch(/no project "nowhere"/);
    expect(why({ persona: "ghost" })).toMatch(/no persona "ghost"/);
    expect(why({ repo: "ghost" })).toMatch(/no repo "ghost"/);
    expect(why({ folder: path.dirname(r.wsDir("north")) })).toMatch(
      /not inside project north|outside/,
    );
    expect(why({ mode: "yolo" })).toMatch(/mode/);
    expect(
      why({ repo: "shop", folder: path.join(r.wsDir("north"), "shop") }),
    ).toMatch(/repo or folder, not both/);
  });
});

describe("SRV-P1: who may ask, for which project", () => {
  it("a project's agent asks in its own project; another project is refused in plain words; the server agent and a person ask anywhere", async () => {
    const r = await repoRig();
    fs.mkdirSync(r.wsDir("south"), { recursive: true });
    const d = resolveAgentsDeps(r.deps);
    const ask = (project: string, who: { agent?: string; project?: string }) =>
      checkAgentCreate(d, { project, persona: "planner" }, who);
    expect(ask("north", { agent: "lead", project: "north" }).ok).toBe(true);
    const other = ask("north", { agent: "lead", project: "south" });
    expect(other.ok ? "" : other.error).toBe(
      "lead works in project south: it can add agents there only, not to project north",
    );
    expect(ask("north", { agent: "server", project: SERVER_SCOPE }).ok).toBe(
      true,
    );
    expect(ask("north", {}).ok).toBe(true);
  });
});

describe("SRV-P1: on Allow", () => {
  it("starts it as agents start does, and answers with its id, project, repo and folder", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    const c = checkAgentCreate(d, {
      project: "north",
      persona: "reviewer",
      name: "Ana",
      repo: "shop",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const out = await createAgent(d, c.args);
    expect(out).toMatchObject({
      ok: true,
      project: "north",
      repo: "shop",
      cwd: path.join(r.wsDir("north"), "shop"),
    });
    const id = (out as { id: string }).id;
    expect(readRecord(r.stateDir, id)?.displayName).toBe("Ana");
    expect(r.made).toHaveLength(1);
  });
});

describe("issue 1328: an agent's sandbox setting follows its lifecycle", () => {
  it("agent_create needs the person when the id it would get has its sandbox off", async () => {
    const r = await repoRig();
    r.config.agents = { ...r.config.agents, planner: { sandbox: false } };
    const c = checkAgentCreate(resolveAgentsDeps(r.deps), {
      project: "north",
      persona: "planner",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBe(true);
    expect(c.args.sandboxOff).toBe(true);
    expect(c.details).toContain(
      "planner starts outside the sandbox: agents.planner.sandbox is off in config/local/user.yml.",
    );
  });

  it("so does a name whose id has it off, and agents.sandbox off for the machine", async () => {
    const r = await repoRig();
    r.config.agents = { ...r.config.agents, ana: { sandbox: false } };
    const named = checkAgentCreate(resolveAgentsDeps(r.deps), {
      project: "north",
      persona: "reviewer",
      name: "Ana",
    });
    expect(named.ok && named.personOnly).toBe(true);
    const r2 = await repoRig();
    r2.config.sandbox = false;
    const all = checkAgentCreate(resolveAgentsDeps(r2.deps), {
      project: "north",
      persona: "planner",
    });
    expect(all.ok && all.personOnly).toBe(true);
    expect(all.ok && all.details).toContain(
      "Agents here start outside the sandbox (agents.sandbox: off), and so would this one.",
    );
  });

  it("with the sandbox on, or required, it follows the policy as before", async () => {
    const r = await repoRig();
    const c = checkAgentCreate(resolveAgentsDeps(r.deps), {
      project: "north",
      persona: "planner",
    });
    expect(c.ok && c.personOnly).toBeFalsy();
    expect(c.ok && c.args.sandboxOff).toBeUndefined();
    r.config.agents = { ...r.config.agents, planner: { sandbox: false } };
    r.config.sandboxRequired = true;
    const req = checkAgentCreate(resolveAgentsDeps(r.deps), {
      project: "north",
      persona: "planner",
    });
    expect(req.ok && req.personOnly).toBeFalsy();
  });

  it("on Allow, a create whose sandbox went off after the ask is refused", async () => {
    const r = await repoRig();
    const c = checkAgentCreate(resolveAgentsDeps(r.deps), {
      project: "north",
      persona: "planner",
    });
    if (!c.ok) throw new Error(c.error);
    r.config.agents = { ...r.config.agents, planner: { sandbox: false } };
    expect(await createAgent(resolveAgentsDeps(r.deps), { ...c.args })).toEqual(
      {
        ok: false,
        error: expect.stringMatching(/outside the sandbox.*ask again/),
      },
    );
  });

  it("agent_import: the id it would get, the same way; and on Allow", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    expect(importSandboxOff(d, "planner")).toBeNull();
    r.config.agents = { ...r.config.agents, planner: { sandbox: false } };
    expect(importSandboxOff(d, "planner")).toEqual([
      "planner starts outside the sandbox: agents.planner.sandbox is off in config/local/user.yml.",
      { key: "ap.det.agent.sandboxOff", vars: { id: "planner" } },
    ]);
    expect(
      await runAgentImport(d, {
        project: "north",
        session: "abc-123",
        persona: "planner",
      }),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/outside the sandbox.*ask again/),
    });
  });
});
