/**
 * Issue 796: the parts of an agent's read-only view outside the server's
 * routes: the Setting (on by default, its minutes, written as Settings
 * and `config` write it, person-only), who a view is in the audit (the
 * agent, never the person), first run (a view never ends it), and the
 * MCP tool (its route, and what it says when views are off).
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { readWebAuthConfig } from "../../../src/shared/web/web-session.js";
import {
  patchCliRows,
  PERSON_ONLY_SETTINGS,
} from "../../../src/shared/settings-cli-rows.js";
import {
  agentPrincipalOf,
  auditActorOf,
  notAPersonOf,
  principalOf,
  setPrincipal,
} from "../../../src/ui/server/request-guard.js";
import { personVia } from "../../../src/ui/server/first-run.js";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";
import { DenHttpError } from "../../../src/ui/mcp/api.js";
import { callTool, toolsFor } from "../../../src/ui/mcp/tools.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

describe("clause 4: the Setting", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-av-cfg-"));
    fs.mkdirSync(path.join(tmp, "config", "local"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const user = (yml: string) =>
    fs.writeFileSync(path.join(tmp, "config", "local", "user.yml"), yml);

  it("is on by default, for 10 minutes", () => {
    expect(readWebAuthConfig(tmp)).toMatchObject({
      agentView: true,
      agentViewMinutes: 10,
    });
  });

  it("user.yml turns it off and sets its minutes", () => {
    user("web:\n  agent_view: false\n  agent_view_minutes: 3\n");
    expect(readWebAuthConfig(tmp)).toMatchObject({
      agentView: false,
      agentViewMinutes: 3,
    });
  });

  it("refuses a value that isn't one", () => {
    user("web:\n  agent_view: maybe\n");
    expect(() => readWebAuthConfig(tmp)).toThrow(/web.agent_view/);
    user("web:\n  agent_view_minutes: 600\n");
    expect(() => readWebAuthConfig(tmp)).toThrow(/1 to 60/);
  });

  it("Settings writes web.agent_view and its minutes; a person's only", () => {
    const u: Record<string, unknown> = { web: { approve_attempts: 3 } };
    expect(
      patchCliRows(u, { web_agent_view: { on: false, minutes: 5 } }),
    ).toEqual({ ok: true });
    expect(u.web).toEqual({
      approve_attempts: 3,
      agent_view: false,
      agent_view_minutes: 5,
    });
    expect(patchCliRows(u, { web_agent_view: { on: null } })).toEqual({
      ok: true,
    });
    expect(u.web).toEqual({ approve_attempts: 3, agent_view_minutes: 5 });
    expect(patchCliRows(u, { web_agent_view: { minutes: 0 } }).ok).toBe(false);
    expect(patchCliRows(u, { web_agent_view: { on: "yes" } }).ok).toBe(false);
    expect(PERSON_ONLY_SETTINGS).toContain("web_agent_view");
  });
});

describe("clause 3: a view is the agent, never the person", () => {
  const req = () => ({ headers: {} }) as unknown as http.IncomingMessage;

  it("principalOf and auditActorOf name the agent; person-only checks refuse it", () => {
    const r = req();
    setPrincipal(r, {
      kind: "person-browser",
      session: "k1",
      view: { agent: "agent:builder", workspace: "north" },
    });
    expect(principalOf(r)).toBe("agent:builder");
    expect(auditActorOf(r)).toMatchObject({
      kind: "agent",
      agent: "agent:builder",
      workspace: "north",
    });
    expect(notAPersonOf(r)).toBe(true);
    // Every handler that refuses an agent's token, or scopes it to its
    // project, does the same for its view: one check, in one place.
    expect(agentPrincipalOf(r)).toMatchObject({
      kind: "agent",
      actor: "agent:builder",
      workspace: "north",
      grants: [],
    });
    expect(auditActorOf(r)).toMatchObject({ client: "page view (read-only)" });
  });

  it("first run: a view is never a person's sign-in", () => {
    expect(personVia("agent-view")).toBe(false);
    expect(personVia("link")).toBe(true);
  });
});

describe("clause 1: the MCP tool page_view", () => {
  const cfg = (): ResolvedMcpConfig => ({
    actions: [],
    runTestsEnvs: ["local"],
    logsRemote: false,
    approvals: true,
  });
  function fakeApi(answer: () => unknown): { api: DenApi; calls: string[] } {
    const calls: string[] = [];
    const api: DenApi = {
      baseUrl: "http://localhost:7000",
      async get(p, query = {}, method = "GET", body) {
        assertAllowedRequest(method, p, query);
        calls.push(`${method} ${p} ${JSON.stringify(body ?? null)}`);
        return answer();
      },
      async stream() {
        throw new Error("no stream here");
      },
    };
    return { api, calls };
  }

  it("is a tool every agent has", () => {
    expect(toolsFor(cfg()).map((t) => t.name)).toContain("page_view");
  });

  it("asks the server for a link to the page, and hands it back", async () => {
    const { api, calls } = fakeApi(() => ({
      ok: true,
      url: "http://localhost:7000/auth?agent_view=x&next=%2Fsettings",
      minutes: 10,
    }));
    const r = await callTool(
      "page_view",
      { next: "/settings" },
      { api, cfg: cfg(), cli: "acme" },
    );
    expect(r.isError).toBe(false);
    expect(calls).toEqual(['POST /api/agents/self/view {"next":"/settings"}']);
    expect(JSON.parse(r.text)).toMatchObject({ ok: true, minutes: 10 });
  });

  it("views off: says so plainly", async () => {
    const { api } = fakeApi(() => {
      throw new DenHttpError(
        "POST",
        "/api/agents/self/view",
        403,
        "Agents' read-only page views are off on this install (Settings › Access).",
      );
    });
    const r = await callTool("page_view", {}, { api, cfg: cfg(), cli: "acme" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/page_view: .*off on this install/);
  });

  it("a page off this Den is refused before any call", async () => {
    const { api, calls } = fakeApi(() => ({}));
    const r = await callTool(
      "page_view",
      { next: "//elsewhere.example/" },
      { api, cfg: cfg(), cli: "acme" },
    );
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
