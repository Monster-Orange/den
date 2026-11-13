/**
 * NT-1 (2) ask_human, and NT notifications_list: an agent asks its person
 * a question (POST /api/agents/self/attention, why "asked"; which agent
 * comes from its own token), and reads the bell. Both are always
 * registered read tools: neither changes anything but the agent's own
 * waiting mark. The API is a fake that records what was asked.
 */
import { describe, expect, it } from "@jest/globals";
import {
  READ_TOOL_NAMES,
  callTool,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import {
  DenHttpError,
  assertAllowedRequest,
  type DenApi,
} from "../../../src/ui/mcp/api.js";

function fakeApi(answer: (path: string) => unknown = () => ({ ok: true })) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, _query, method, body) {
      // A scoped server checks its project is there first.
      if (path === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      calls.push({ path, method, body });
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

describe("ask_human", () => {
  it("is a read tool, always there", () => {
    expect(READ_TOOL_NAMES).toContain("ask_human");
    expect(READ_TOOL_NAMES).toContain("notifications_list");
  });

  it("posts the question as the agent's own waiting mark", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "ask_human",
      { question: "  Ship the north fix today?  " },
      ctx(api),
    );
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/agents/self/attention",
        method: "POST",
        body: {
          event: "waiting",
          why: "asked",
          text: "Ship the north fix today?",
        },
      },
    ]);
    expect(r.text).toMatch(/asked/i);
  });

  it("refuses an empty question, and one over 300 characters", async () => {
    const { api, calls } = fakeApi();
    expect(
      (await callTool("ask_human", { question: " " }, ctx(api))).isError,
    ).toBe(true);
    expect(
      (await callTool("ask_human", { question: "x".repeat(301) }, ctx(api)))
        .isError,
    ).toBe(true);
    expect(calls).toEqual([]);
  });

  it("says plainly when the server holds back (too many questions)", async () => {
    const { api } = fakeApi(
      () =>
        new DenHttpError(
          "POST",
          "/api/agents/self/attention",
          429,
          "You asked 30 questions in the last hour.",
        ),
    );
    const r = await callTool("ask_human", { question: "Again?" }, ctx(api));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("30 questions");
  });

  it("notifications_list reads the bell", async () => {
    const { api, calls } = fakeApi(() => ({
      ok: true,
      unread: 1,
      waiting: [],
      groups: [],
      mutes: [],
    }));
    const r = await callTool("notifications_list", {}, ctx(api));
    expect(r.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ path: "/api/notifications" });
    expect(calls[0].method ?? "GET").toBe("GET");
    expect(r.text).toContain('"unread": 1');
  });

  it("the client lets these two routes through, and only these methods", () => {
    expect(() =>
      assertAllowedRequest("POST", "/api/agents/self/attention", {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("GET", "/api/notifications", {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("POST", "/api/notifications/read", {}),
    ).toThrow();
    expect(() =>
      assertAllowedRequest("POST", "/api/notifications", {}),
    ).toThrow();
  });
});
