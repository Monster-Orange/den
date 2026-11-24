/**
 * Issue 1406, clause 3: an agent's ask to be restarted is a structured
 * held write, agent_restart_self, not a free-text question, so the bell
 * can group several into one card.
 *
 * - An agent asks for itself only; a person (or Den itself) names the agent.
 * - The Review says it restarts at the agent's next idle moment, on the
 *   same conversation, never cutting a turn, and why (new tools, an update).
 * - A stopped or unknown agent is refused before anything waits.
 * - On Allow it asks for the restart after the agent's turn (not waited for).
 * - It is routine: the approval policy decides, never personOnly.
 *
 * Injected records; invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  AGENT_RESTART_SELF_ACTION,
  checkAgentRestartSelf,
  runAgentRestartSelf,
  type RestartSelfDeps,
} from "../../../src/shared/agents/restart-self.js";
import {
  HELD_WRITE_RISK,
  isCriticalWrite,
} from "../../../src/shared/approval-policy.js";

interface Rec {
  id: string;
  workspace: string;
  displayName?: string;
  stoppedAt?: string;
}

function fake(
  recs: Rec[] = [
    { id: "ana", workspace: "north", displayName: "Ana" },
    { id: "bo", workspace: "south" },
  ],
) {
  const restarted: [string, string][] = [];
  const d: RestartSelfDeps = {
    record: (id) => {
      const r = recs.find((x) => x.id === id);
      if (!r) throw new Error(`no agent ${id}`);
      return r;
    },
    restart: (id, project) => {
      restarted.push([id, project]);
      return Promise.resolve();
    },
  };
  return { d, restarted };
}

describe("agent_restart_self (issue 1406)", () => {
  it("is named agent_restart_self", () => {
    expect(AGENT_RESTART_SELF_ACTION).toBe("agent_restart_self");
  });

  it("an agent asks for itself: the Review says when and why", () => {
    const { d } = fake();
    const c = checkAgentRestartSelf(
      d,
      { reason: "tools" },
      { agent: "ana", project: "north" },
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBeUndefined();
    expect(c.summary).toBe("restart Ana when idle");
    expect(c.params).toEqual({ agent: "Ana", reason: "tools" });
    expect(c.args).toEqual({ agent: "ana", project: "north", reason: "tools" });
    expect(c.details.join("\n")).toMatch(/next idle moment/);
    expect(c.details.join("\n")).toMatch(/same conversation/);
    expect(c.details.join("\n")).toMatch(/new tools/);
    expect(c.detailKeys).toHaveLength(c.details.length);
  });

  it("an agent can't ask to restart another agent", () => {
    const { d } = fake();
    const c = checkAgentRestartSelf(
      d,
      { agent: "bo", reason: "tools" },
      { agent: "ana", project: "north" },
    );
    expect(c).toEqual({
      ok: false,
      error: expect.stringMatching(/only for itself/),
    });
  });

  it("a person or Den names the agent", () => {
    const { d } = fake();
    const c = checkAgentRestartSelf(d, { agent: "bo", reason: "update" }, {});
    expect(c.ok && c.args).toEqual({
      agent: "bo",
      project: "south",
      reason: "update",
    });
    expect(c.ok && c.details.join("\n")).toMatch(/update/);
    expect(checkAgentRestartSelf(d, { reason: "tools" }, {})).toEqual({
      ok: false,
      error: expect.stringMatching(/agent is required/),
    });
  });

  it("refuses an unknown or stopped agent, and a bad reason", () => {
    const { d } = fake([
      { id: "ana", workspace: "north", stoppedAt: "2026-11-23T00:00:00Z" },
    ]);
    expect(checkAgentRestartSelf(d, { agent: "zed" }, {}).ok).toBe(false);
    expect(checkAgentRestartSelf(d, { agent: "ana" }, {})).toEqual({
      ok: false,
      error: expect.stringMatching(/isn't running/),
    });
    const live = fake().d;
    expect(
      checkAgentRestartSelf(live, { reason: "because" }, { agent: "ana" }),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/reason is "tools", "update" or "other"/),
    });
  });

  it('an "other" reason carries its one-line note, plain', () => {
    const { d } = fake();
    const c = checkAgentRestartSelf(
      d,
      { reason: "other", why: "pick up\nnew\u001b[31m settings" },
      { agent: "ana" },
    );
    expect(c.ok && c.args.why).toBe("pick up new settings");
    expect(
      checkAgentRestartSelf(d, { reason: "other" }, { agent: "ana" }),
    ).toEqual({ ok: false, error: expect.stringMatching(/why is required/) });
  });

  it("on Allow it restarts after the turn, in the agent's project", async () => {
    const { d, restarted } = fake();
    const r = await runAgentRestartSelf(d, {
      agent: "ana",
      project: "north",
      reason: "tools",
    });
    expect(r).toEqual({ ok: true, agent: "ana", project: "north" });
    expect(restarted).toEqual([["ana", "north"]]);
  });

  it("is routine: the approval policy decides", () => {
    expect(HELD_WRITE_RISK.agent_restart_self?.risk).toBe("routine");
    expect(HELD_WRITE_RISK.agent_restart_self?.kind).toBe("ask");
    expect(isCriticalWrite("agent_restart_self", false)).toBe(false);
  });
});
