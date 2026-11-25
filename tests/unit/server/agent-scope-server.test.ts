/**
 * An agent token's project scope, held by the web server as the MCP
 * server holds it (scope-rule.ts): a route naming a project outside the
 * scope, in its path or its query, is refused. Writes on every install;
 * reads on a strict install only (a personal install is one person's
 * machine). The server agent's reserved scope reaches every project; a
 * grant widens an agent's. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import type { InstallMode } from "../../../src/shared/den-config.js";
import {
  agentRefusal,
  requestWorkspaces,
  viewAgent,
  type AgentPrincipal,
} from "../../../src/ui/server/request-guard.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";

const agent = (workspace = "north", grants: string[] = []): AgentPrincipal => ({
  kind: "agent",
  actor: "agent:a1",
  workspace,
  grants,
  session: { name: "acme-den:north:a1" },
});
const strict = (): InstallMode => "strict";
const personal = (): InstallMode => "personal";

/** agentRefusal as the guard calls it, the class from the table. */
function why(
  p: AgentPrincipal,
  method: string,
  url: string,
  mode: () => InstallMode,
): string | null {
  const u = new URL(url, "http://x");
  const cls = routeClass(method, u.pathname) ?? "readonly";
  return agentRefusal(p, method, u.pathname, cls, u.searchParams, mode);
}

const READS = [
  "/api/workspaces/south/agents",
  "/api/workspaces/south/agents/b1/details",
  "/api/workspaces/south/agents/b1/tools",
  "/api/workspaces/south/agents/b1/helpers",
  "/api/workspaces/south/agents/b1/helpers/h1",
  "/api/workspaces/south/agents/b1/paths",
  "/api/workspaces/south/mcp-servers",
  "/api/workspaces/south/event-feeds",
  "/api/workspaces/south/agent-modes",
  "/api/sessions?ws=south",
  "/api/sessions?workspace=south",
  "/api/services?workspace=south",
];

/** Another project's agents: person-only already, on every install. */
const PATH_WRITES = [
  "/api/workspaces/south/agents/b1/move",
  "/api/workspaces/south/agents/b1/folder",
  "/api/workspaces/south/agents/b1/link",
  "/api/workspaces/south/agents/b1/handoff",
  "/api/workspaces/south/agents/b1/compacting-clear",
];

/** Writes that name the project in the query: the scope holds them. */
const WRITES: [string, string][] = [
  ["POST", "/api/workspace/sync?workspace=south"],
  ["GET", "/api/workspace/sync?workspace=south"],
  ["GET", "/api/run?ws=south"],
  ["GET", "/api/service/logs?workspace=south"],
];

describe("strict install: reads outside the scope are refused", () => {
  it.each(READS)("GET %s from project north: refused", (url) => {
    expect(why(agent(), "GET", url, strict)).toMatch(
      /can reach project north only, not "south"/,
    );
  });

  it.each(READS)("GET %s within the scope: not refused for scope", (url) => {
    const own = url.replace(/south/g, "north");
    expect(why(agent(), "GET", own, strict) ?? "").not.toMatch(/can reach/);
  });

  it("an unknown project gets the same refusal as another one", () => {
    const a = why(agent(), "GET", "/api/workspaces/south/agents", strict);
    const b = why(agent(), "GET", "/api/workspaces/nosuch/agents", strict);
    expect(b).toBe(a!.replace("south", "nosuch"));
  });

  it("an encoded name is read decoded", () => {
    expect(
      why(agent(), "GET", "/api/workspaces/so%75th/agents", strict),
    ).toMatch(/not "south"/);
  });

  it("a granted project is reached; the server agent reaches all", () => {
    expect(why(agent("north", ["south"]), "GET", READS[1]!, strict)).toBeNull();
    expect(why(agent("den-server"), "GET", READS[1]!, strict)).toBeNull();
    expect(
      why(
        agent("den-server"),
        "POST",
        "/api/workspace/sync?workspace=south",
        strict,
      ),
    ).toBeNull();
  });

  it("an agent's read-only view is held to the same scope", () => {
    const v = viewAgent({ agent: "agent:a1", workspace: "north" });
    expect(why(v, "GET", READS[1]!, strict)).toMatch(/not "south"/);
  });

  it("literal routes under /api/workspaces/ name no project", () => {
    expect(requestWorkspaces("/api/workspaces/services")).toEqual([]);
    expect(requestWorkspaces("/api/workspaces/settings")).toEqual([]);
    expect(requestWorkspaces("/api/workspaces/south/agents/b1/move")).toEqual([
      "south",
    ]);
  });
});

describe("personal install: reads stay open, writes are scoped", () => {
  it.each(READS)("GET %s from project north: not refused", (url) => {
    expect(why(agent(), "GET", url, personal)).toBeNull();
  });

  it.each(WRITES)("%s %s from project north: refused", (m, url) => {
    expect(why(agent(), m, url, personal)).toMatch(
      /can reach project north only, not "south"/,
    );
  });

  it.each(WRITES)("%s %s within the scope: not refused for scope", (m, url) => {
    const own = url.replace(/south/g, "north");
    expect(why(agent(), m, own, personal) ?? "").not.toMatch(/can reach/);
  });

  it.each(PATH_WRITES)("POST %s: refused (a person's)", (url) => {
    expect(why(agent(), "POST", url, personal)).toBeTruthy();
  });

  it("the mode is read only when a read names another project", () => {
    let reads = 0;
    const counted = (): InstallMode => (reads++, "personal");
    why(agent(), "GET", "/api/workspaces/north/agents", counted);
    why(agent(), "POST", "/api/workspace/sync?workspace=south", counted);
    expect(reads).toBe(0);
    why(agent(), "GET", READS[0]!, counted);
    expect(reads).toBe(1);
  });
});

describe("strict install: writes are scoped too", () => {
  it.each(WRITES)("%s %s from project north: refused", (m, url) => {
    expect(why(agent(), m, url, strict)).toMatch(/not "south"/);
  });
});
