/**
 * FB-6 (den#81): agents report through MCP. feedback_diagnostics returns
 * the sections a report can include (the server's exact text, as the form
 * shows them); feedback_report saves the agent's report as a draft. Only a
 * person sends one (from My reports): the draft route marks it the agent's,
 * and the send route refuses an agent (report-routes.test.ts). The API here
 * is a fake that checks each request as the real client does
 * (assertAllowedRequest).
 */
import { describe, expect, it } from "@jest/globals";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";
import { callTool, toolsFor } from "../../../src/ui/mcp/tools.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function fakeApi(): { api: DenApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:7000",
    async get(path, query = {}, method = "GET", body?: unknown) {
      assertAllowedRequest(method, path, query);
      if (path === "/api/workspaces")
        return { active: ["north"], focus: "north", workspaces: { north: {} } };
      calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
      if (path === "/api/report/diagnostics")
        return {
          ok: true,
          sections: { Den: "acme 9.9.9", Machine: "os: Linux" },
        };
      if (path === "/api/report/drafts")
        return {
          ok: true,
          draft: { id: "0123456789abcdef", savedAt: "2026-11-21T12:00:00Z" },
        };
      throw new Error(`not faked: ${method} ${path}`);
    },
    async stream() {
      throw new Error("no stream here");
    },
  };
  return { api, calls };
}

const cfg = (): ResolvedMcpConfig => ({
  actions: [],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
});

describe("FB-6: feedback_diagnostics and feedback_report", () => {
  it("both are registered, with no action to turn on", () => {
    const names = toolsFor(cfg()).map((t) => t.name);
    expect(names).toContain("feedback_diagnostics");
    expect(names).toContain("feedback_report");
  });

  it("feedback_diagnostics: the server's sections, exact text, by name", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "feedback_diagnostics",
      {},
      { api, cfg: cfg(), cli: "acme" },
    );
    expect(r.isError).toBe(false);
    expect(calls).toEqual([{ method: "GET", path: "/api/report/diagnostics" }]);
    const out = JSON.parse(r.text) as { sections: Record<string, string> };
    expect(out.sections).toEqual({ Den: "acme 9.9.9", Machine: "os: Linux" });
  });

  it("feedback_report: saved as a draft with the sections named, redacted; it says a person sends it", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "feedback_report",
      {
        kind: "bug",
        title: "Logs pane stops following",
        description: "It stops after a restart.",
        include: ["Den"],
      },
      { api, cfg: cfg(), cli: "acme" },
    );
    expect(r.isError).toBe(false);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/report/drafts",
        body: {
          kind: "bug",
          title: "Logs pane stops following",
          description: "It stops after a restart.",
          sections: { Den: true },
          redact: true,
        },
      },
    ]);
    expect(r.text).toMatch(/0123456789abcdef/);
    expect(r.text).toMatch(/draft/);
    expect(r.text).toMatch(/My reports/);
    // Never "sent" or "filed": a person does that.
    expect(r.text).not.toMatch(/\b(sent|filed)\b/i);
  });

  it("a project agent's scoped server may draft one too", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "feedback_report",
      { kind: "idea", title: "Group the logs by service" },
      {
        api,
        cfg: cfg(),
        cli: "acme",
        scope: { workspace: "north", actor: "agent:builder" },
      },
    );
    expect(r.isError).toBe(false);
    expect(calls.map((c) => c.path)).toEqual(["/api/report/drafts"]);
  });

  it.each([
    [{ kind: "rant", title: "x" }, /kind/],
    [{ kind: "bug", title: "  " }, /title/],
    [{ kind: "bug", title: "x".repeat(201) }, /200/],
  ])("refuses %j before any call", async (args, why) => {
    const { api, calls } = fakeApi();
    const r = await callTool("feedback_report", args, {
      api,
      cfg: cfg(),
      cli: "acme",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(why);
    expect(calls).toEqual([]);
  });

  it("an agent never reaches the send route", () => {
    expect(() => assertAllowedRequest("POST", "/api/report/send", {})).toThrow(
      /not exposed/,
    );
    expect(() =>
      assertAllowedRequest("POST", "/api/report/github-send", {}),
    ).toThrow(/not exposed/);
  });
});
