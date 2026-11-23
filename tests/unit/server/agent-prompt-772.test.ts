/**
 * Issue 772: one agent prompts another (agent_prompt, a held write) and
 * waits for it (agent_wait). The server side: AgentPrompts (agent-prompt.ts).
 *
 *   3. a Blocked target (needs you) → agent_blocked, nothing typed
 *   4. not Working or Blocked within 5 s of the prompt → agent_prompt_stalled,
 *      typed once, never again
 *   6. never itself; never back into an agent already waiting on it (a chain
 *      too)
 *   7. a prompted child that becomes Blocked or ends: its parent gets one note
 *   8. an agent outside the caller's project: refused
 */
import { describe, expect, it } from "@jest/globals";
import {
  AgentPrompts,
  type AgentPromptDeps,
  type PromptState,
} from "../../../src/ui/server/agent-prompt.js";

interface Rig {
  p: AgentPrompts;
  typed: [string, string][];
  notes: [string, string][];
  state: Map<string, PromptState | null>;
  clock: { t: number };
}

function rig(over: Partial<AgentPromptDeps> = {}): Rig {
  const typed: [string, string][] = [];
  const notes: [string, string][] = [];
  const state = new Map<string, PromptState | null>([
    ["a", "idle"],
    ["b", "idle"],
    ["c", "idle"],
  ]);
  const clock = { t: 1_000_000 };
  const records: Record<string, { id: string; workspace: string }> = {
    a: { id: "a", workspace: "north" },
    b: { id: "b", workspace: "north" },
    c: { id: "c", workspace: "north" },
    s: { id: "s", workspace: "south" },
  };
  const p = new AgentPrompts({
    record: (id) => records[id] ?? null,
    stateOf: (id) => (state.has(id) ? state.get(id)! : "idle"),
    type: async (id, text) => {
      typed.push([id, text]);
    },
    note: (to, text) => void notes.push([to.agent, text]),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    ...over,
  });
  return { p, typed, notes, state, clock };
}

const from = (agent: string) => ({ agent, project: "north" });

describe("772: the check before the person's Allow", () => {
  it("names the target, its project and the text for the Review", async () => {
    const r = rig();
    const c = await r.p.check({ agent: "b", text: "run the tests" }, from("a"));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.args).toEqual({
      agent: "b",
      project: "north",
      text: "run the tests",
      from: "a",
    });
    expect(c.detailKeys?.map((k) => k?.key)).toContain(
      "ap.det.agent_prompt.text",
    );
  });

  it("6: an agent can't prompt itself", async () => {
    const r = rig();
    const c = await r.p.check({ agent: "a", text: "hi" }, from("a"));
    expect(c).toMatchObject({ ok: false });
    expect(!c.ok && c.error).toMatch(/itself/);
  });

  it("8: an agent in another project is refused", async () => {
    const r = rig();
    const c = await r.p.check({ agent: "s", text: "hi" }, from("a"));
    expect(c).toMatchObject({ ok: false });
    expect(!c.ok && c.error).toMatch(/project north/);
  });

  it("an unknown agent, a blank text or control characters: refused", async () => {
    const r = rig();
    for (const a of [
      { agent: "zz", text: "hi" },
      { agent: "b", text: "  " },
      { agent: "b", text: "a\x1b[2Jb" },
    ])
      expect((await r.p.check(a, from("a"))).ok).toBe(false);
  });

  it("6: never back into an agent already waiting on the caller, directly or down a chain", async () => {
    const r = rig();
    // b waits on a: a can't prompt b.
    r.p.waiting("b", "a");
    expect((await r.p.check({ agent: "b", text: "x" }, from("a"))).ok).toBe(
      false,
    );
    // c waits on b, b waits on a: a can't prompt c either.
    r.p.waiting("c", "b");
    const c = await r.p.check({ agent: "c", text: "x" }, from("a"));
    expect(c.ok).toBe(false);
    expect(!c.ok && c.error).toMatch(/loop|waiting/);
    // A wait that stopped being asked about lapses.
    r.clock.t += 60_000;
    expect((await r.p.check({ agent: "b", text: "x" }, from("a"))).ok).toBe(
      true,
    );
  });
});

describe("772: running the prompt", () => {
  it("2: types the text into the target once, and says it's working", async () => {
    const r = rig({
      type: async (id, text) => {
        r.typed.push([id, text]);
        r.state.set(id, "working");
      },
    });
    const out = await r.p.run({
      agent: "b",
      project: "north",
      text: "go",
      from: "a",
    });
    expect(r.typed).toEqual([["b", "go"]]);
    expect(out).toMatchObject({ ok: true, agent: "b", state: "working" });
  });

  it("3: a Blocked target: agent_blocked and nothing typed", async () => {
    const r = rig();
    r.state.set("b", "needs");
    const out = await r.p.run({
      agent: "b",
      project: "north",
      text: "go",
      from: "a",
    });
    expect(out).toMatchObject({ ok: false, code: "agent_blocked" });
    expect(r.typed).toEqual([]);
    // The check says so before the Allow, too.
    expect((await r.p.check({ agent: "b", text: "go" }, from("a"))).ok).toBe(
      false,
    );
  });

  it("4: neither Working nor Blocked within 5 s: agent_prompt_stalled, typed once", async () => {
    const r = rig();
    const t0 = r.clock.t;
    const out = await r.p.run({
      agent: "b",
      project: "north",
      text: "go",
      from: "a",
    });
    expect(out).toMatchObject({ ok: false, code: "agent_prompt_stalled" });
    expect(r.typed).toEqual([["b", "go"]]);
    expect(r.clock.t - t0).toBeGreaterThanOrEqual(5000);
    expect(r.clock.t - t0).toBeLessThan(6000);
  });

  it("Blocked right after the prompt counts (it asks its person)", async () => {
    const r = rig({
      type: async (id) => {
        r.typed.push([id, ""]);
        r.state.set(id, "needs");
      },
    });
    const out = await r.p.run({
      agent: "b",
      project: "north",
      text: "go",
      from: "a",
    });
    expect(out).toMatchObject({ ok: true, state: "needs" });
  });

  it("not running: refused with the terminal's reason, nothing typed", async () => {
    const r = rig();
    r.state.set("b", null);
    const out = await r.p.run({
      agent: "b",
      project: "north",
      text: "go",
      from: "a",
    });
    expect(out).toMatchObject({ ok: false, code: "not_running" });
    expect(r.typed).toEqual([]);
  });
});

describe("772: the parent hears once when its child needs attention or ends", () => {
  async function prompted(r: Rig) {
    r.state.set("b", "working");
    await r.p.run({ agent: "b", project: "north", text: "go", from: "a" });
  }

  it("7: Blocked → one note to the parent", async () => {
    const r = rig();
    await prompted(r);
    r.p.tick();
    expect(r.notes).toEqual([]);
    r.state.set("b", "needs");
    r.p.tick();
    r.p.tick();
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0][0]).toBe("a");
    expect(r.notes[0][1]).toMatch(/b needs/);
  });

  it("7: ends (no longer running) → one note to the parent", async () => {
    const r = rig();
    await prompted(r);
    r.state.set("b", null);
    r.p.tick();
    r.p.tick();
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0][1]).toMatch(/b ended/);
  });

  it("a person's prompt (no parent agent) notes no one", async () => {
    const r = rig();
    r.state.set("b", "working");
    await r.p.run({ agent: "b", project: "north", text: "go" });
    r.state.set("b", "needs");
    r.p.tick();
    expect(r.notes).toEqual([]);
  });
});
