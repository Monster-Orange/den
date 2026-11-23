/**
 * Issue 620 over MCP: a session that isn't a Den agent (its Den MCP server
 * has no agent scope) asks with ask_human: a session ask, its choices
 * yes/no or a few named ones, and its own label. ask_answer reads the
 * answer to one of its own asks. An agent's ask_human is unchanged. The
 * answer route is never exposed to MCP.
 */
import { describe, expect, it } from "@jest/globals";
import {
  READ_TOOL_NAMES,
  callTool,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";

function fakeApi(answer: (path: string) => unknown = () => ({ ok: true })) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, _query, method, body) {
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

/** A session's MCP server: no agent scope. */
const session = (api: DenApi): ToolContext => ({
  api,
  cfg: {
    actions: [],
    runTestsEnvs: ["local"],
    logsRemote: false,
    approvals: true,
  },
  cli: "acme",
});

const ID = "sa_" + "0123456789abcdef01234567";

describe("issue 620: ask_human from a session that isn't an agent", () => {
  it("files a session ask (yes/no by default) with its label", async () => {
    const { api, calls } = fakeApi(() => ({ ok: true, id: ID }));
    const r = await callTool(
      "ask_human",
      { question: " Ship 0.4.87? ", session: "builder" },
      session(api),
    );
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/session-asks",
        method: "POST",
        body: { question: "Ship 0.4.87?", session: "builder" },
      },
    ]);
    expect(JSON.stringify(r.content)).toContain(ID);
    expect(JSON.stringify(r.content)).toContain("ask_answer");
  });

  it("passes named choices", async () => {
    const { api, calls } = fakeApi(() => ({ ok: true, id: ID }));
    await callTool(
      "ask_human",
      { question: "Which?", choices: ["north", "south"] },
      session(api),
    );
    expect(calls[0].body).toEqual({
      question: "Which?",
      choices: ["north", "south"],
    });
  });
});

describe("issue 620: ask_answer", () => {
  it("is a read tool", () => {
    expect(READ_TOOL_NAMES).toContain("ask_answer");
  });

  it("reads its own ask: answered, with the choice", async () => {
    const { api, calls } = fakeApi(() => ({
      ok: true,
      id: ID,
      state: "answered",
      answer: "yes",
    }));
    const r = await callTool("ask_answer", { id: ID }, session(api));
    expect(calls).toEqual([
      { path: `/api/session-asks/${ID}`, method: undefined, body: undefined },
    ]);
    expect(JSON.stringify(r.content)).toMatch(/answered.*yes/);
  });

  it("refuses an id that isn't one", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool("ask_answer", { id: "../x" }, session(api));
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("issue 620: what MCP may call", () => {
  it("filing and reading a session ask; never answering one", () => {
    expect(() =>
      assertAllowedRequest("POST", "/api/session-asks", {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("GET", `/api/session-asks/${ID}`, {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("POST", `/api/session-asks/${ID}/answer`, {}),
    ).toThrow();
  });
});
