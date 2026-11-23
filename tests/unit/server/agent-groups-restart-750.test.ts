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
