/**
 * Issue 1328: agent_sandbox_set, a held write that turns one agent's
 * sandbox off or on, so the person never edits user.yml by hand.
 *
 * - Off widens what the agent may do: only the person's own Allow runs it
 *   (personOnly). The Review names the agent, the change and the reason,
 *   and says plainly when the agent asks for itself.
 * - On narrows: no Allow needed (the policy's default runs it at once).
 * - On Allow it writes only agents.<id>.sandbox in user.yml, keeping
 *   comments and every other key, notes when and why, and restarts a
 *   running agent after its turn on the same conversation.
 * - agents doctor lists every agent whose sandbox is off, when and why.
 *
 * Temp install root, injected records; invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkAgentSandboxSet,
  readSandboxNotes,
  runAgentSandboxSet,
  writeSandboxNote,
  type SandboxSetDeps,
} from "../../../src/shared/agents/sandbox-set.js";
import {
  isCriticalWrite,
  policyFor,
} from "../../../src/shared/approval-policy.js";
import {
  sandboxLines,
  type SandboxReport,
} from "../../../src/ui/cli/agents-command.js";

let tmp = "";
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1328-")));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Rec {
  id: string;
  workspace: string;
  displayName?: string;
  stoppedAt?: string;
}

function fake(
  over: Partial<SandboxSetDeps> = {},
  recs: Rec[] = [{ id: "ana", workspace: "north", displayName: "Ana" }],
  agents: SandboxSetDeps["agentsConfig"] = () => ({}),
) {
  const wrote: [string, boolean][] = [];
  const notes: [string, unknown][] = [];
  const restarted: string[] = [];
  const d: SandboxSetDeps = {
    record: (id, project) => {
      const r = recs.find(
        (x) => x.id === id && (!project || x.workspace === project),
      );
      if (!r) throw new Error(`no agent ${id}`);
      return r;
    },
    agentsConfig: agents,
    write: (id, on) => void wrote.push([id, on]),
    note: (id, n) => void notes.push([id, n]),
    restart: async (id) => void restarted.push(id),
    now: () => "2026-11-23T22:00:00.000Z",
    ...over,
  };
  return { d, wrote, notes, restarted };
}

describe("agent_sandbox_set: the check (issue 1328)", () => {
  it("off is the person's own Allow, and the Review names the agent, the change and the reason", () => {
    const { d } = fake();
    const c = checkAgentSandboxSet(
      d,
      { agent: "ana", on: false, reason: "it needs Docker" },
      { agent: "lead", project: "north" },
    );
    if (!c.ok) throw new Error(c.error);
    expect(c.personOnly).toBe(true);
    expect(c.params).toMatchObject({ agent: "Ana", loosens: "1" });
    const text = c.details.join("\n");
    expect(text).toContain("takes Ana out of the sandbox");
    expect(text).toContain("Agent: Ana (ana), project north");
    expect(text).toContain("Why: it needs Docker");
    expect(text).toContain("agents.ana.sandbox: off");
    expect(text).toContain(
      "restarts it after its turn, on the same conversation",
    );
    expect(text).not.toContain("asking for this itself");
    expect(c.detailKeys).toHaveLength(c.details.length);
    expect(c.args).toEqual({
      agent: "ana",
      project: "north",
      on: false,
      reason: "it needs Docker",
    });
  });

  it("the reason keeps no control or format characters (terminal escapes, bidi controls)", () => {
    const { d } = fake();
    const c = checkAgentSandboxSet(d, {
      agent: "ana",
      on: false,
      reason: "it needs\u001b[2K Docker\u202e\u0000",
    });
    if (!c.ok) throw new Error(c.error);
    expect(c.args.reason).toBe("it needs Docker");
    expect(c.details).toContain("Why: it needs Docker");
    const only = checkAgentSandboxSet(d, {
      agent: "ana",
      on: false,
      reason: "\u001b\u202e",
    });
    expect(only).toMatchObject({ ok: false, error: /reason is required/ });
  });

  it("an agent asking for itself: the Review says so plainly, first", () => {
    const { d } = fake();
    const c = checkAgentSandboxSet(
      d,
      { agent: "ana", on: false, reason: "Docker" },
      { agent: "ana", project: "north" },
    );
    if (!c.ok) throw new Error(c.error);
    expect(c.details[0]).toBe(
      "Ana is asking for this itself: it wants its own sandbox off.",
    );
    expect(c.params.self).toBe("1");
  });

  it("on narrows: not the person's own, and no reason needed", () => {
    const { d } = fake({}, undefined, () => ({
      agents: { ana: { sandbox: false } },
    }));
    const c = checkAgentSandboxSet(d, { agent: "ana", on: true }, {});
    if (!c.ok) throw new Error(c.error);
    expect(c.personOnly).toBeUndefined();
    expect(c.params.loosens).toBeUndefined();
    expect(c.details.join("\n")).toContain("puts Ana back in the sandbox");
  });

  it("refuses: no reason for off, a long or bad one, on not a boolean, already so, required, another project's agent", () => {
    const { d } = fake();
    const err = (raw: Record<string, unknown>, who = {}) => {
      const c = checkAgentSandboxSet(d, raw, who);
      return c.ok ? null : c.error;
    };
    expect(err({ agent: "ana", on: false })).toMatch(/reason is required/);
    expect(err({ agent: "ana", on: false, reason: "x".repeat(301) })).toMatch(
      /300 characters/,
    );
    expect(err({ agent: "ana", on: "off", reason: "x" })).toMatch(
      /on must be true or false/,
    );
    expect(err({ on: false, reason: "x" })).toMatch(/agent is required/);
    expect(err({ agent: "ghost", on: false, reason: "x" })).toMatch(
      /no agent ghost/,
    );
    expect(err({ agent: "ana", on: true })).toMatch(/already in the sandbox/);
    expect(
      err(
        { agent: "ana", on: false, reason: "x" },
        { agent: "bo", project: "south" },
      ),
    ).toMatch(/project south.*not ana in project north/);
    const req = fake({}, undefined, () => ({ sandboxRequired: true }));
    const r = checkAgentSandboxSet(
      req.d,
      { agent: "ana", on: false, reason: "x" },
      {},
    );
    expect(r.ok ? null : r.error).toMatch(/required/);
  });

  it("a stopped agent: its next start has the change", () => {
    const { d } = fake({}, [
      { id: "ana", workspace: "north", stoppedAt: "2026-11-23T20:00:00Z" },
    ]);
    const c = checkAgentSandboxSet(
      d,
      { agent: "ana", on: false, reason: "Docker" },
      {},
    );
    if (!c.ok) throw new Error(c.error);
    expect(c.details.join("\n")).toContain("its next start has the change");
  });
});

describe("agent_sandbox_set: on Allow (issue 1328)", () => {
  it("writes the one key, notes when and why and who asked, and restarts a running agent", async () => {
    const f = fake();
    const r = await runAgentSandboxSet(
      f.d,
      { agent: "ana", project: "north", on: false, reason: "Docker" },
      { agent: "ana" },
    );
    expect(r).toEqual({
      ok: true,
      agent: "ana",
      project: "north",
      sandbox: "off",
      restarts: true,
    });
    expect(f.wrote).toEqual([["ana", false]]);
    expect(f.notes).toEqual([
      ["ana", { at: "2026-11-23T22:00:00.000Z", why: "Docker", by: "ana" }],
    ]);
    expect(f.restarted).toEqual(["ana"]);
  });

  it("back on clears the note; a stopped agent is not restarted", async () => {
    const f = fake(
      {},
      [{ id: "ana", workspace: "north", stoppedAt: "2026-11-23T20:00:00Z" }],
      () => ({ agents: { ana: { sandbox: false } } }),
    );
    const r = await runAgentSandboxSet(f.d, { agent: "ana", on: true });
    expect(r).toMatchObject({ ok: true, sandbox: "on", restarts: false });
    expect(f.notes).toEqual([["ana", null]]);
    expect(f.restarted).toEqual([]);
  });

  it("a check that fails now writes nothing", async () => {
    const f = fake();
    const r = await runAgentSandboxSet(f.d, { agent: "ana", on: true });
    expect(r.ok).toBe(false);
    expect(f.wrote).toEqual([]);
  });
});

describe("approval policy (issue 1328)", () => {
  it("widens: off always the person's Allow; on follows the policy, which runs it at once by default", () => {
    expect(isCriticalWrite("agent_sandbox_set", true)).toBe(true);
    expect(policyFor("agent_sandbox_set", { widens: true }).kind).toBe("ask");
    expect(isCriticalWrite("agent_sandbox_set", false)).toBe(false);
    expect(policyFor("agent_sandbox_set", { widens: false }).kind).not.toBe(
      "ask",
    );
  });

  it("a new agent that would start outside the sandbox is the person's; otherwise create and import keep their policy", () => {
    for (const a of ["agent_create", "agent_import"]) {
      expect(isCriticalWrite(a, true)).toBe(true);
      expect(isCriticalWrite(a, false)).toBe(false);
    }
    expect(policyFor("agent_create", { widens: false }).kind).toBe("notify");
    expect(policyFor("agent_import", { widens: false }).kind).toBe("ask");
  });
});

describe("the notes, and agents doctor's list (issue 1328)", () => {
  it("a note is kept, read back and cleared; a bad file reads as none", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "state-"));
    expect(readSandboxNotes(dir)).toEqual({});
    writeSandboxNote(dir, "ana", {
      at: "2026-11-23T22:00:00.000Z",
      why: "Docker",
      by: "ana",
    });
    expect(readSandboxNotes(dir)).toEqual({
      ana: { at: "2026-11-23T22:00:00.000Z", why: "Docker", by: "ana" },
    });
    writeSandboxNote(dir, "ana", null);
    expect(readSandboxNotes(dir)).toEqual({});
    fs.writeFileSync(path.join(dir, "sandbox-off.json"), "nope");
    expect(readSandboxNotes(dir)).toEqual({});
  });

  it("prints no control or format characters from the notes file", () => {
    const text = sandboxLines({
      here: { applied: true, tool: "sandbox-exec" },
      outside: [],
      fromBefore: 0,
      turnedOff: [
        {
          id: "ana",
          at: "2026-11-23T22:00:00.000Z",
          why: "Dock\u001b[2Ker\u202e",
          by: "a\u0007na",
        },
      ],
    }).join("\n");
    expect(text).toContain("asked by ana: Docker");
    for (const l of text.split("\n")) expect(l).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("lists every agent whose sandbox is off, with when and why, or that it was set by hand", () => {
    const r: SandboxReport = {
      here: { applied: true, tool: "sandbox-exec" },
      outside: [],
      fromBefore: 0,
      turnedOff: [
        {
          id: "ana",
          at: "2026-11-23T22:00:00.000Z",
          why: "Docker",
          by: "ana",
        },
        { id: "bo" },
      ],
    };
    const text = sandboxLines(r).join("\n");
    expect(text).toContain(
      `  ℹ ana: sandbox off since ${new Date("2026-11-23T22:00:00.000Z").toLocaleString()}, asked by ana: Docker`,
    );
    expect(text).toContain(
      "  ℹ bo: sandbox off (set in config/local/user.yml, no reason noted)",
    );
  });
});
