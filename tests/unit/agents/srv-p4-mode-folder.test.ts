/**
 * SRV-P4 (0.4.48): two held writes for Den's agent, and a project's agent
 * in its own project.
 *
 * - project_mode: a project's mode (or none). The Allow shows the change
 *   and says running agents switch after their current turn, in the same
 *   conversation (Den's mode check, since 0.4.46).
 * - agent_folder: an agent's folder (a repo of its project, or a folder in
 *   it). A running agent is stopped, moved and started fresh there. An
 *   agent may move itself (the Allow says so); Den's own agent's folder is
 *   never moved.
 *
 * A real host on a temp socket, a scripted PTY (nothing runs). Invented
 * names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { readRecord } from "../../../src/shared/agents/records.js";
import {
  checkAgentFolder,
  checkProjectMode,
  resolveAgentsDeps,
  runAgentFolder,
  runProjectMode,
  startAgent,
  stopAgent,
} from "../../../src/ui/cli/agent-ops.js";
import {
  SERVER_AGENT_ID,
  SERVER_SCOPE,
} from "../../../src/shared/agents/server-agent.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";
import { UI_LANGUAGES } from "../../../src/ui/server/ui-language.js";
import { catalogSource } from "../server/helpers/en-catalog.js";

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
  // A stop waits for the scripted session to end, which ends on TERM, as
  // in gap 7's tests.
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
  for (const repo of ["notes", "shop"])
    fs.mkdirSync(path.join(r.wsDir("north"), repo), { recursive: true });
  return r;
}

describe("SRV-P4: project_mode", () => {
  it("every detail line has a message key the page translates (en, es, ja)", async () => {
    const r = await repoRig();
    r.wsPermission.north = "ask";
    const c = checkProjectMode(resolveAgentsDeps(r.deps), {
      project: "north",
      mode: null,
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.detailKeys).toHaveLength(c.details.length);
    const cats = UI_LANGUAGES.map((l) => catalogSource(l));
    for (const k of c.detailKeys!) {
      expect(k).not.toBeNull();
      for (const cat of cats) expect(cat).toContain(`"${k!.key}":`);
    }
    expect(c.detailKeys!.map((k) => k!.key)).toContain("ap.pm.switch");
  });

  it("shows the change and that running agents switch after their turn", async () => {
    const r = await repoRig();
    r.wsPermission.north = "auto";
    const c = checkProjectMode(resolveAgentsDeps(r.deps), {
      project: "north",
      mode: "edits",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.summary).toBe("set project north's mode: auto → edits");
    expect(c.params).toEqual({ project: "north", from: "auto", to: "edits" });
    expect(c.details.join("\n")).toMatch(
      /running agents switch after their current turn, in the same conversation/,
    );
    expect(c.details.join("\n")).not.toMatch(/until they start again/);
    expect(c.args).toEqual({ project: "north", mode: "edits" });
  });

  it("a loosening says so first, plainly, and is the person's Allow only; a tightening is not", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    r.wsPermission.north = "ask";
    const loose = checkProjectMode(d, { project: "north", mode: "auto" });
    expect(loose.ok).toBe(true);
    if (!loose.ok) return;
    expect(loose.summary).toBe(
      "This lets agents in north act without asking you. Set project north's mode: ask → auto",
    );
    expect(loose.details[0]).toBe(
      "This lets agents in north act without asking you.",
    );
    expect(loose.params.loosens).toBe("1");
    expect(loose.personOnly).toBe(true);
    r.wsPermission.north = "all";
    const tight = checkProjectMode(d, { project: "north", mode: "edits" });
    expect(tight.ok && tight.summary).toBe(
      "set project north's mode: all → edits",
    );
    expect(tight.ok && tight.personOnly).toBeFalsy();
    expect(tight.ok && tight.params.loosens).toBeUndefined();
  });

  it("clearing a project's mode loosens only when the install's is wider", async () => {
    const r = await repoRig();
    r.wsPermission.north = "ask";
    r.deps.installPermission = () => "all";
    const wider = checkProjectMode(resolveAgentsDeps(r.deps), {
      project: "north",
      mode: null,
    });
    expect(wider.ok && wider.personOnly).toBe(true);
    r.wsPermission.north = "auto";
    r.deps.installPermission = () => "edits";
    const narrower = checkProjectMode(resolveAgentsDeps(r.deps), {
      project: "north",
      mode: null,
    });
    expect(narrower.ok && narrower.personOnly).toBeFalsy();
  });

  it("none set, and clearing one, say so", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    const set = checkProjectMode(d, { project: "north", mode: "auto" });
    expect(set.ok && set.summary).toBe(
      "This lets agents in north act without asking you. Set project north's mode: none → auto",
    );
    r.wsPermission.north = "auto";
    // With no install mode either, agents follow their persona's, which
    // may be wider: a loosening.
    const clear = checkProjectMode(d, { project: "north", mode: null });
    expect(clear.ok && clear.summary).toBe(
      "This lets agents in north act without asking you. Set project north's mode: auto → none",
    );
    expect(clear.ok && clear.personOnly).toBe(true);
    expect(clear.ok && clear.args).toEqual({ project: "north", mode: null });
  });

  it("refuses a bad mode, no project, no change, and Den's own place", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    r.wsPermission.north = "edits";
    const err = (a: Record<string, unknown>) => {
      const c = checkProjectMode(d, a);
      return c.ok ? "" : c.error;
    };
    expect(err({ project: "north", mode: "root" })).toMatch(/mode/);
    expect(err({ project: "nowhere", mode: "ask" })).toMatch(
      /no project "nowhere"/,
    );
    expect(err({ project: "north", mode: "edits" })).toMatch(/already edits/);
    expect(err({ project: SERVER_SCOPE, mode: "ask" })).toMatch(
      /not a project/,
    );
  });

  it("a project's agent asks for its own project only", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    fs.mkdirSync(r.wsDir("south"), { recursive: true });
    const other = checkProjectMode(
      d,
      { project: "north", mode: "ask" },
      { agent: "lead", project: "south" },
    );
    expect(other.ok ? "" : other.error).toBe(
      "lead works in project south: it can set that project's mode only, not project north's",
    );
    expect(
      checkProjectMode(
        d,
        { project: "north", mode: "ask" },
        { agent: "lead", project: "north" },
      ).ok,
    ).toBe(true);
    expect(
      checkProjectMode(
        d,
        { project: "north", mode: "ask" },
        { agent: SERVER_AGENT_ID, project: SERVER_SCOPE },
      ).ok,
    ).toBe(true);
  });

  it("on Allow, saves it (or clears it)", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    expect(await runProjectMode(d, { project: "north", mode: "auto" })).toEqual(
      { ok: true, project: "north", mode: "auto" },
    );
    expect(r.wsPermission.north).toBe("auto");
    await runProjectMode(d, { project: "north", mode: null });
    expect(r.wsPermission.north).toBeUndefined();
  });
});

describe("SRV-P4: agent_folder", () => {
  async function started(r: Rig): Promise<string> {
    const d = resolveAgentsDeps(r.deps);
    const s = await startAgent(d, {
      workspace: "north",
      persona: "reviewer",
      repo: "notes",
    });
    return s.rec.id;
  }

  it("a stopped agent: says where it goes, and that its next start is a new conversation", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    const id = await started(r);
    await stopAgent(d, id, "north", { wait: true });
    const c = checkAgentFolder(d, { agent: id, repo: "shop" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.summary).toBe(`move agent ${id} to north › shop`);
    expect(c.params).toMatchObject({ agent: id, where: "north › shop" });
    const said = c.details.join("\n");
    expect(said).toContain(path.join(r.wsDir("north"), "notes"));
    expect(said).toContain(path.join(r.wsDir("north"), "shop"));
    expect(said).toMatch(/next start is a new conversation/);
    expect(c.args).toEqual({ agent: id, project: "north", repo: "shop" });
  });

  it("a running agent: the Allow says Den stops it and starts it fresh there; on Allow it does", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    const id = await started(r);
    const c = checkAgentFolder(d, { agent: id, repo: "shop" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.details.join("\n")).toMatch(
      /running: Den stops it, moves it, and starts it fresh there/i,
    );
    const out = await runAgentFolder(d, c.args);
    expect(out).toMatchObject({
      ok: true,
      id,
      cwd: path.join(r.wsDir("north"), "shop"),
      repo: "shop",
      restarted: true,
    });
    const rec = readRecord(r.stateDir, id);
    expect(rec?.cwd).toBe(path.join(r.wsDir("north"), "shop"));
    expect(rec?.stoppedAt).toBeUndefined();
    expect(r.made).toHaveLength(2);
  });

  it("a stopped agent stays stopped after the move", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    const id = await started(r);
    await stopAgent(d, id, "north", { wait: true });
    const out = await runAgentFolder(d, {
      agent: id,
      project: "north",
      folder: path.join(r.wsDir("north"), "shop"),
    });
    expect(out).toMatchObject({ ok: true, restarted: false });
    expect(readRecord(r.stateDir, id)?.stoppedAt).toBeTruthy();
    expect(r.made).toHaveLength(1);
  });

  it("an agent may move itself: the Allow warns it stops", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    const id = await started(r);
    const c = checkAgentFolder(
      d,
      { agent: id, repo: "shop" },
      { agent: id, project: "north" },
    );
    expect(c.ok).toBe(true);
    expect(c.ok && c.details.join("\n")).toMatch(
      /this is the agent that asked/i,
    );
  });

  it("refuses: Den's own agent, another project's agent, no such repo, a folder outside the project, the same folder", async () => {
    const r = await repoRig();
    const d = resolveAgentsDeps(r.deps);
    const id = await started(r);
    const err = (a: Record<string, unknown>, who = {}) => {
      const c = checkAgentFolder(d, a, who);
      return c.ok ? "" : c.error;
    };
    expect(err({ agent: SERVER_AGENT_ID, folder: "/tmp" })).toMatch(
      /Den's own agent/,
    );
    expect(
      err({ agent: id, repo: "shop" }, { agent: "lead", project: "south" }),
    ).toBe(
      `lead works in project south: it can move that project's agents only, not ${id} in project north`,
    );
    expect(err({ agent: id, repo: "nope" })).toMatch(/no repo "nope"/);
    expect(err({ agent: id, folder: "/" })).not.toBe("");
    expect(err({ agent: id, repo: "notes" })).toMatch(/already works in/);
    expect(err({ agent: id })).toMatch(/a repo of its project, or a folder/);
    expect(err({ agent: id, repo: "shop", folder: "x" })).toMatch(/not both/);
    expect(err({ agent: "ghost", repo: "shop" })).toMatch(/no agent "ghost"/);
  });
});
