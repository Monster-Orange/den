/**
 * Issue 81, FB-6: agents report through MCP. feedback_diagnostics reads
 * the diagnostics the Report dialog would include, always redacted (a
 * server that doesn't say it redacted them is refused). feedback_report
 * saves the agent's report as a draft that names the agent; it stays a
 * draft until a person sends it from My reports: nothing reaches GitHub
 * from an agent. Both are always registered read tools, like ask_human:
 * neither changes anything but what is offered to the person. The API
 * is a fake that records what was asked.
 */
import { describe, expect, it } from "@jest/globals";
import {
  READ_TOOL_NAMES,
  callTool,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";

function fakeApi(answer: (path: string) => unknown = () => ({ ok: true })) {
  const calls: {
    path: string;
    query?: unknown;
    method?: string;
    body?: unknown;
  }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, query, method, body) {
      if (path === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      calls.push({ path, query, method, body });
      const a = answer(path);
      if (a instanceof Error) throw a;
      return a;
    },
    async stream() {
      throw new Error("no streams here");
    },
  };
  return { api, calls };
}

const ctx = (api: DenApi): ToolContext => ({
  api,
  cfg: {
    actions: [],
    runTestsEnvs: ["local"],
    logsRemote: false,
    approvals: true,
  },
  cli: "acme",
  scope: { workspace: "north", actor: "agent:planner" },
});

describe("FB-6: feedback_diagnostics and feedback_report", () => {
  it("are read tools, always there", () => {
    expect(READ_TOOL_NAMES).toContain("feedback_diagnostics");
    expect(READ_TOOL_NAMES).toContain("feedback_report");
  });

  it("their routes are open to agents; sending a report never is", () => {
    expect(() =>
      assertAllowedRequest("GET", "/api/report/diagnostics", {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("POST", "/api/report/drafts", {}),
    ).not.toThrow();
    for (const [m, p] of [
      ["POST", "/api/report/send"],
      ["POST", "/api/report/github-send"],
      ["GET", "/api/report/mine"],
      ["GET", "/api/report/drafts"],
    ] as const)
      expect(() => assertAllowedRequest(m, p, {})).toThrow(/not exposed/);
  });

  it("feedback_diagnostics asks for the redacted sections and gives them back", async () => {
    const { api, calls } = fakeApi(() => ({
      ok: true,
      redacted: true,
      sections: { Den: "acme 9.9.9 at <host-1>", Machine: "os: Linux" },
    }));
    const r = await callTool("feedback_diagnostics", {}, ctx(api));
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/report/diagnostics",
        query: { redact: "1" },
        method: undefined,
        body: undefined,
      },
    ]);
    expect(r.text).toContain("<host-1>");
    expect(r.text).toContain("Machine");
  });

  it("feedback_diagnostics refuses a server that doesn't say it redacted them", async () => {
    const { api } = fakeApi(() => ({
      ok: true,
      sections: { Den: "acme 9.9.9 at north.example.com" },
    }));
    const r = await callTool("feedback_diagnostics", {}, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("north.example.com");
    expect(r.text).toMatch(/restart/i);
  });

  it("feedback_report saves a draft as the agent, for the person to send", async () => {
    const { api, calls } = fakeApi(() => ({
      ok: true,
      draft: { id: "0123456789abcdef", savedAt: "2026-11-18T10:00:00Z" },
    }));
    const r = await callTool(
      "feedback_report",
      {
        kind: "bug",
        title: "  The north pane drops  ",
        description: "It drops after a minute.",
      },
      ctx(api),
    );
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/report/drafts",
        query: {},
        method: "POST",
        body: {
          kind: "bug",
          title: "The north pane drops",
          description: "It drops after a minute.",
          sections: { Den: true, Machine: true },
          redact: true,
          asAgent: true,
        },
      },
    ]);
    // Never sent: the person sends it, from My reports.
    expect(r.text).toMatch(/draft/i);
    expect(r.text).toMatch(/My reports/);
    expect(r.text).toContain("0123456789abcdef");
  });

  it("feedback_report: a title is needed, at most 200 characters; the kind is bug, idea or question", async () => {
    const { api, calls } = fakeApi();
    for (const a of [
      { kind: "bug", title: "  " },
      { kind: "bug", title: "x".repeat(201) },
      { kind: "rant", title: "Fine" },
    ]) {
      const r = await callTool("feedback_report", a, ctx(api));
      expect(r.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});
