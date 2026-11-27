/**
 * Issue 403: MCP report_screenshot(id), a read tool on Den's own MCP
 * server. It returns a filed report's kept, masked PNG (base64 and its
 * type) to the person who runs this install (the CLI) or this install's
 * own server agent (unscoped). A project agent's scoped server refuses it
 * before any call, naming who can; the web route refuses anyone else too
 * (report-shot-routes.test.ts). The API here is a fake that checks each
 * request as the real client does (assertAllowedRequest).
 */
import { describe, expect, it } from "@jest/globals";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";
import { callTool, toolsFor } from "../../../src/ui/mcp/tools.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

/** A real 1×1 PNG, and base64 that looks like a secret to a careless redactor. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function fakeApi(): { api: DenApi; paths: string[] } {
  const paths: string[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:7000",
    async get(path, query = {}, method = "GET") {
      assertAllowedRequest(method, path, query);
      if (path.startsWith("/api/report/")) paths.push(path);
      if (path === "/api/workspaces")
        return { active: ["north"], focus: "north", workspaces: { north: {} } };
      return {
        ok: true,
        id: "0123456789abcdef",
        repo: "acme-eng/engine",
        savedAt: "2026-11-17T12:00:00.000Z",
        mime: "image/png",
        base64: PNG,
      };
    },
    async stream() {
      throw new Error("no stream here");
    },
  };
  return { api, paths };
}

const cfg = (): ResolvedMcpConfig => ({
  actions: [],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
});

describe("issue 403: report_screenshot", () => {
  it("is registered for every unscoped server (the person's CLI, the server agent)", () => {
    expect(toolsFor(cfg()).map((t) => t.name)).toContain("report_screenshot");
  });

  it("unscoped: the kept PNG, base64 with its type, unchanged by redaction", async () => {
    const { api, paths } = fakeApi();
    const r = await callTool(
      "report_screenshot",
      { id: "0123456789abcdef" },
      { api, cfg: cfg(), cli: "acme" },
    );
    expect(r.isError).toBe(false);
    expect(paths).toEqual(["/api/report/shots/0123456789abcdef"]);
    const out = JSON.parse(r.text) as Record<string, unknown>;
    expect(out).toMatchObject({ id: "0123456789abcdef", mime: "image/png" });
    expect(out.base64).toBe(PNG);
  });

  it("a project agent's scoped server: refused before any call, naming who can", async () => {
    const { api, paths } = fakeApi();
    const r = await callTool(
      "report_screenshot",
      { id: "0123456789abcdef" },
      {
        api,
        cfg: cfg(),
        cli: "acme",
        scope: { workspace: "north", actor: "agent:builder" },
      },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/person who runs this install/);
    expect(r.text).toMatch(/this install's own agent/);
    expect(paths).toEqual([]);
  });

  it("an id that isn't a report's: refused", async () => {
    const { api, paths } = fakeApi();
    const r = await callTool(
      "report_screenshot",
      { id: "../../etc" },
      { api, cfg: cfg(), cli: "acme" },
    );
    expect(r.isError).toBe(true);
    expect(paths).toEqual([]);
  });
});
