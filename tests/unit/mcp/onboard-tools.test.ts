/**
 * ON-3's MCP read tools: onboard_status, repos_detect and manifest_draft.
 * Each is a read (always registered, never gated by mcp.actions) and a thin
 * call to its /api/onboard/* route; the API client reaches those routes by
 * GET only. A scoped (workspace) server can't scan folders, and drafts only
 * inside its workspace's repos, as manifest_validate does. The API is a fake
 * that records what was asked of it.
 */
import { describe, expect, it } from "@jest/globals";
import {
  READ_TOOL_NAMES,
  callTool,
  toolsFor,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import {
  DenHttpError,
  assertAllowedRequest,
  type DenApi,
  type Query,
} from "../../../src/ui/mcp/api.js";
import { Refusal } from "../../../src/ui/mcp/guards.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

interface Call {
  path: string;
  query?: Query;
  method?: string;
  body?: unknown;
}

function fakeApi(
  answer: (path: string, query?: Query) => unknown = () => ({}),
) {
  const calls: Call[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, query, method, body) {
      calls.push({ path, query, method, body });
      if (path === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      if (path === "/api/services")
        return [
          {
            repo: "north",
            service: "north",
            repoPath: "/home/p/code/north",
            commands: ["up"],
          },
        ];
      return answer(path, query);
    },
    async stream() {
      throw new Error("no streams here");
    },
  };
  return { api, calls };
}

const cfg = (
  actions: ResolvedMcpConfig["actions"] = [],
): ResolvedMcpConfig => ({
  actions,
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
});

const ctx = (api: DenApi, scoped = false): ToolContext => ({
  api,
  cfg: cfg(),
  cli: "acme",
  ...(scoped ? { scope: { workspace: "north", actor: "agent:planner" } } : {}),
});

const ONBOARD = ["onboard_status", "repos_detect", "manifest_draft"];

describe("registration", () => {
  it("all three are read tools, registered with no mcp.actions", () => {
    for (const n of ONBOARD) expect(READ_TOOL_NAMES).toContain(n);
    const tools = toolsFor(cfg([]));
    for (const n of ONBOARD)
      expect(tools.find((t) => t.name === n)?.action).toBe(false);
  });

  it("the API client reaches their routes by GET only", () => {
    for (const p of [
      "/api/onboard/status",
      "/api/onboard/repos",
      "/api/onboard/manifest",
    ]) {
      expect(() => assertAllowedRequest("GET", p, {})).not.toThrow();
      expect(() => assertAllowedRequest("POST", p, {})).toThrow(Refusal);
    }
  });
});

describe("onboard_status", () => {
  it("reads /api/onboard/status and returns it", async () => {
    const { api, calls } = fakeApi((p) =>
      p === "/api/onboard/status"
        ? { ok: false, checks: [], next: { id: "repos", step: "Add a repo." } }
        : {},
    );
    const r = await callTool("onboard_status", {}, ctx(api));
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ next: { id: "repos" } });
    expect(calls.map((c) => c.path)).toEqual(["/api/onboard/status"]);
  });

  it("its text goes through the secret redactor", async () => {
    const { api } = fakeApi(() => ({
      detail: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    }));
    const r = await callTool("onboard_status", {}, ctx(api));
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/token/);
    expect(r.text).not.toMatch(/ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  });
});

describe("repos_detect", () => {
  it("passes the path (and max) to /api/onboard/repos", async () => {
    const { api, calls } = fakeApi(() => ({ ok: true, repos: [] }));
    const r = await callTool(
      "repos_detect",
      { path: "/home/p/code", max: 10 },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls).toEqual([
      {
        path: "/api/onboard/repos",
        query: { path: "/home/p/code", max: "10" },
        method: undefined,
        body: undefined,
      },
    ]);
  });

  it("needs a path: refused before the API is asked", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool("repos_detect", {}, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Refused: .*path/);
    expect(calls).toEqual([]);
  });

  it("the server's refusal (outside home) reads as a refusal", async () => {
    const { api } = fakeApi(() => {
      throw new DenHttpError(
        "GET",
        "/api/onboard/repos",
        400,
        "/tmp is outside your home folder (/home/p); Den only reads folders inside it",
      );
    });
    const r = await callTool("repos_detect", { path: "/tmp" }, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "Refused: repos_detect: /tmp is outside your home folder (/home/p); Den only reads folders inside it",
    );
  });

  it("a workspace-scoped server can't scan folders: refused, reported, nothing scanned", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "repos_detect",
      { path: "/home/p/code" },
      ctx(api, true),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/scoped to workspace "north"/);
    expect(calls.map((c) => c.path)).not.toContain("/api/onboard/repos");
    // The attempt lands in the activity trail.
    expect(
      calls.some((c) => c.path === "/api/activity" && c.method === "POST"),
    ).toBe(true);
  });
});

describe("manifest_draft", () => {
  it("passes the repo path and the options to /api/onboard/manifest", async () => {
    const { api, calls } = fakeApi(() => ({
      ok: true,
      dryRun: true,
      draft: "version: 1\n",
    }));
    const r = await callTool(
      "manifest_draft",
      { path: "/home/p/code/acme", run: "npm run dev" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ dryRun: true });
    expect(calls[0]).toMatchObject({
      path: "/api/onboard/manifest",
      query: { path: "/home/p/code/acme", run: "npm run dev" },
    });
  });

  it("a question from the server (several ways to start) is an answer, not an error", async () => {
    const { api } = fakeApi(() => ({
      ok: false,
      dryRun: true,
      ask: "This repo can start in 2 ways. Which one do you use to run it locally?",
      choices: ["npm run dev", "docker compose -f compose.yaml up -d"],
    }));
    const r = await callTool(
      "manifest_draft",
      { path: "/home/p/code/notes" },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).choices).toHaveLength(2);
  });

  it("scoped: only a path inside the workspace's repos", async () => {
    const outside = fakeApi();
    const r = await callTool(
      "manifest_draft",
      { path: "/home/p/code/acme" },
      ctx(outside.api, true),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not inside a repo of workspace "north"/);
    expect(outside.calls.map((c) => c.path)).not.toContain(
      "/api/onboard/manifest",
    );

    const inside = fakeApi(() => ({ ok: true }));
    const r2 = await callTool(
      "manifest_draft",
      { path: "/home/p/code/north" },
      ctx(inside.api, true),
    );
    expect(r2.isError).toBe(false);
  });
});
