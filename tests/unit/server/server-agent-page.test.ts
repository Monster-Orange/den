/**
 * The server agent's page (public/server-agent-page.js, ON-6): what it
 * shows for each status /api/server-agent gives. Pure: HTML from JSON,
 * with the strings' keys (no shell here, so t() gives the key).
 *
 *   - a fresh Den with a runtime: it starts by itself, and says it only
 *     reads until the person allows a write;
 *   - no runtime: how to install one, and the manual path, never a start;
 *   - running: its terminal, and Open in Agents;
 *   - set up, not running: a Start button, never a start by itself.
 */
import { describe, expect, it } from "@jest/globals";
import {
  modelOptionsHtml,
  runtimeOptionsHtml,
  serverAgentView,
} from "../../../src/ui/server/public/server-agent-page.js";

const base = {
  name: "Acme agent",
  id: "server",
  scope: "den-server",
  persona: "server",
  fresh: true,
  runtime: { id: "den-claude", label: "Claude Code" },
  runtimes: [
    {
      id: "den-claude",
      label: "Claude Code",
      available: true,
      denTools: true,
      usable: true,
    },
    {
      id: "den-codex",
      label: "Codex CLI",
      available: true,
      denTools: false,
      usable: false,
    },
  ],
  state: "none",
  manual: ["cd ~/acme", "./bin/acme repo add <path>", "./bin/acme up"],
};

describe("the server agent's page", () => {
  it("a fresh Den with a runtime: it starts by itself and only reads until allowed", () => {
    const v = serverAgentView(base);
    expect(v.autoStart).toBe(true);
    expect(v.terminal).toBeNull();
    expect(v.sub).toBe("sa.sub.fresh");
    expect(v.body).toContain('data-note="reads-only"');
    expect(v.body).not.toContain('data-note="manual"');
  });

  it("no runtime: how to install one and the manual path; it never starts", () => {
    const v = serverAgentView({
      ...base,
      runtime: null,
      runtimes: [
        {
          id: "den-claude",
          label: "Claude Code",
          available: false,
          denTools: true,
          usable: false,
          install: "npm i -g @anthropic-ai/claude-code",
        },
      ],
    });
    expect(v.autoStart).toBe(false);
    expect(v.body).toContain('data-note="no-runtime"');
    expect(v.body).toContain("<code>npm i -g @anthropic-ai/claude-code</code>");
    const steps = [...v.body.matchAll(/<li><code>([^<]*)<\/code><\/li>/g)].map(
      (m) => m[1],
    );
    expect(steps).toEqual([
      "cd ~/acme",
      "./bin/acme repo add &lt;path&gt;",
      "./bin/acme up",
    ]);
  });

  it("only a runtime without Den's tools (no Claude): the manual path, never a terminal", () => {
    const v = serverAgentView({
      ...base,
      runtime: null,
      runtimes: [
        {
          id: "codex",
          label: "Codex",
          available: true,
          denTools: false,
          usable: false,
        },
        {
          id: "den-claude",
          label: "Claude Code",
          available: false,
          denTools: true,
          usable: false,
          install: "npm i -g @anthropic-ai/claude-code",
        },
      ],
    });
    expect([v.autoStart, v.terminal]).toEqual([false, null]);
    expect(v.body).toContain('data-note="no-runtime"');
    expect(v.body).toContain('data-note="manual"');
    expect(v.body).toContain(
      '<li data-runtime="codex"><b>Codex</b> · sa.noTools</li>',
    );
    expect(v.body).toContain("<code>npm i -g @anthropic-ai/claude-code</code>");
    expect(runtimeOptionsHtml({ ...base, runtime: null, runtimes: [] })).toBe(
      "",
    );
  });

  it("running on Claude on a fresh Den: a line says a login prompt is expected", () => {
    const fresh = serverAgentView({
      ...base,
      state: "running",
      sessionId: "s-1",
    });
    expect(fresh.body).toContain('data-note="login"');
    expect(fresh.terminal).toBe("s-1");
    const setUp = serverAgentView({
      ...base,
      fresh: false,
      state: "running",
      sessionId: "s-1",
    });
    expect(setUp.body).not.toContain('data-note="login"');
    const other = serverAgentView({
      ...base,
      runtime: { id: "other", label: "Other" },
      state: "running",
      sessionId: "s-1",
    });
    expect(other.body).not.toContain('data-note="login"');
  });

  it("running on Claude on a fresh Den: the line follows the runtime it runs on, not the picker's", () => {
    // Running on Claude, while the picker's runtime reads none (not found
    // again on this read) or another one: the lines still show.
    for (const runtime of [null, { id: "other", label: "Other" }]) {
      const v = serverAgentView({
        ...base,
        runtime,
        runningRuntime: "den-claude",
        state: "running",
        sessionId: "s-1",
      });
      expect(v.body).toContain('data-note="login"');
      expect(v.terminal).toBe("s-1");
    }
    // Running on another runtime, whatever the picker says: no Claude lines.
    const other = serverAgentView({
      ...base,
      runningRuntime: "other",
      state: "running",
      sessionId: "s-1",
    });
    expect(other.body).not.toContain('data-note="login"');
    expect(other.body).not.toContain('data-note="trust"');
  });

  it("running on Claude on a fresh Den: a line above the terminal says to trust its folder", () => {
    const v = serverAgentView({
      ...base,
      runningRuntime: "den-claude",
      state: "running",
      sessionId: "s-1",
    });
    expect(v.body).toContain(
      '<p class="note sa-trust" data-note="trust">sa.trust</p>',
    );
    const setUp = serverAgentView({
      ...base,
      fresh: false,
      runningRuntime: "den-claude",
      state: "running",
      sessionId: "s-1",
    });
    expect(setUp.body).not.toContain('data-note="trust"');
  });

  it("the model picker offers the runtime's own models, the chosen one selected", () => {
    const html = modelOptionsHtml({
      ...base,
      model: "sonnet",
      models: [
        { id: "opus", label: "Opus" },
        { id: "sonnet", label: "Sonnet" },
      ],
    });
    expect(html).toBe(
      '<option value="opus">Opus</option><option value="sonnet" selected>Sonnet</option>',
    );
    expect(modelOptionsHtml({ ...base, models: [] })).toBe("");
  });

  it("running: its terminal, never a second start", () => {
    const v = serverAgentView({ ...base, state: "running", sessionId: "s-1" });
    expect([v.autoStart, v.terminal]).toEqual([false, "s-1"]);
  });

  it("set up and not running: a Start button, never a start by itself", () => {
    const v = serverAgentView({ ...base, fresh: false, state: "stopped" });
    expect(v.autoStart).toBe(false);
    expect(v.sub).toBe("sa.sub");
    expect(v.body).toContain('data-act="start"');
  });

  it("the runtime picker offers only runtimes that can run it, the chosen one selected", () => {
    const html = runtimeOptionsHtml(base);
    expect(html).toBe(
      '<option value="den-claude" selected>Claude Code</option>',
    );
    expect(runtimeOptionsHtml({ ...base, runtimes: [] })).toBe("");
  });
});
