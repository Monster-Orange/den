/**
 * Issue 750 step 3: a running agent whose Hub tools failed to load (issue
 * 749's mcpFailed, the one source) has Restart on its row, not only on its
 * pane bar. The row's callout draws it (rowHtml, which By project and By
 * group both use); one already restarting, or stopped, has none.
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  toolsRestartButton,
  toolsRestartHtml,
  toolsStale,
} from "../../../src/ui/server/public/agent-groups.js";

const t = (k: string, v: Record<string, unknown> = {}) =>
  `${k}${Object.keys(v).length ? `(${Object.values(v).join(",")})` : ""}`;

const failed = {
  kind: "agent",
  agent: "planner-1",
  state: "running",
  mcpFailed: [{ server: "hub", error: "connect ECONNREFUSED" }],
};

describe("issue 750 step 3: Restart on the row of an agent that can't reach Hub", () => {
  it("a running agent whose Hub tools failed: Restart, named for it", () => {
    const html = toolsRestartHtml(failed, t);
    expect(html).toContain('data-act="tools-restart"');
    expect(html).toContain('aria-label="ag.mcp.restartName(planner-1)"');
    expect(html).toContain(">ag.mcp.restart<");
    expect(html).toContain('class="den-btn sm"');
  });

  it("one whose tools are reloading already has no Restart", () => {
    expect(toolsRestartHtml({ ...failed, toolsRestarting: true }, t)).toBe("");
  });

  it("a stopped agent, a shell, or one with no failed server: none", () => {
    expect(toolsRestartHtml({ ...failed, state: "stopped" }, t)).toBe("");
    expect(toolsRestartHtml({ ...failed, kind: "session" }, t)).toBe("");
    expect(toolsRestartHtml({ ...failed, mcpFailed: [] }, t)).toBe("");
    expect(toolsRestartHtml({ ...failed, mcpFailed: undefined }, t)).toBe("");
  });

  it("a name with markup is escaped", () => {
    expect(toolsRestartHtml({ ...failed, agent: 'x"><b>' }, t)).not.toContain(
      '"><b>',
    );
  });

  it("the row's Restart is the pane bar's own button (one markup)", () => {
    expect(toolsRestartHtml(failed, t)).toBe(toolsRestartButton(failed, t));
  });
});

describe("issues 750 and 1223: one helper for the row's Restart and the tag", () => {
  const running = { kind: "agent", agent: "coder-2", state: "running" };
  const stale = {
    adds: { ...running, mcpStale: { adds: ["hub"] } },
    drops: { ...running, mcpStale: { drops: ["hub"] } },
    den: { ...running, mcpStale: { den: { from: "0.4.86", to: "0.4.87" } } },
  };

  it("issue 1223: tools out of date (Hub added or dropped, an older Den's) get the same Restart", () => {
    for (const [why, r] of Object.entries(stale)) {
      expect(toolsStale(r)).toBe(why);
      expect(toolsRestartHtml(r, t)).toBe(toolsRestartButton(r, t));
    }
  });

  it("a failed load wins over stale tools, and a restart under way wins over both", () => {
    expect(toolsStale({ ...stale.den, mcpFailed: failed.mcpFailed })).toBe(
      "failed",
    );
    expect(
      toolsStale({
        ...stale.den,
        mcpFailed: failed.mcpFailed,
        toolsRestarting: true,
      }),
    ).toBe("restarting");
  });

  it("a stopped agent never gets Restart, whatever its tools", () => {
    for (const r of [...Object.values(stale), failed]) {
      const stopped = { ...r, state: "stopped" };
      expect(toolsStale(stopped)).toBeNull();
      expect(toolsRestartHtml(stopped, t)).toBe("");
    }
    expect(toolsRestartHtml({ ...stale.den, state: "stopping" }, t)).toBe(
      toolsRestartButton(stale.den, t),
    );
  });

  it("an agent whose tools are current: no tag reason, no Restart", () => {
    expect(toolsStale(running)).toBeNull();
    expect(
      toolsStale({ ...running, mcpStale: { adds: [], drops: [] } }),
    ).toBeNull();
    expect(toolsRestartHtml(running, t)).toBe("");
  });
});
