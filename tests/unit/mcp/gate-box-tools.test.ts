/**
 * Issue 625 follow-up: gate_box_set and gate_box_remove are held writes.
 * Each only asks (POST /api/approvals) and waits for the person; it never
 * reaches the boxes route itself. A bad box is refused before anything is
 * asked, in checkBox's words. The API is a fake that records what was asked.
 */
import { describe, expect, it } from "@jest/globals";
import {
  callTool,
  toolsFor,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import { DenHttpError, type DenApi } from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

const ID = "AbCdEfGhIjKlMnOp";

function fakeApi() {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(path, _q, method, body) {
      calls.push({ path, method, body });
      if (path === "/api/approvals" && method === "POST")
        return { id: ID, state: "pending" };
      if (path === `/api/approvals/${ID}`) return { id: ID, state: "pending" };
      throw new DenHttpError("GET", path, 404, "not found");
    },
    async stream() {
      throw new Error("no streams here");
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
const ctx = (api: DenApi): ToolContext => ({
  api,
  cfg: cfg(),
  cli: "acme",
  approvalWait: { intervalMs: 1, waitMs: 5, sleep: async () => undefined },
});

describe("gate_box_set and gate_box_remove", () => {
  it("are held writes, registered with no mcp.actions", () => {
    const tools = toolsFor(cfg());
    for (const n of ["gate_box_set", "gate_box_remove"])
      expect(tools.find((t) => t.name === n)?.action).toBe(true);
  });

  it("gate_box_set asks with the box (slots is browser_slots) and nothing else", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "gate_box_set",
      {
        name: "box1",
        ssh: "runner@box1.example",
        ssh_port: 2222,
        slots: 2,
        time_scale: 1.5,
        note: "idle box for browser runs",
      },
      ctx(api),
    );
    expect(r.isError).toBe(false);
    expect(calls[0]).toEqual({
      path: "/api/approvals",
      method: "POST",
      body: {
        action: "gate_box_set",
        args: {
          box: {
            name: "box1",
            ssh: "runner@box1.example",
            ssh_port: 2222,
            browser_slots: 2,
            time_scale: 1.5,
          },
        },
        note: "idle box for browser runs",
      },
    });
    expect(calls.some((c) => c.path.startsWith("/api/gate-slots"))).toBe(false);
  });

  it("a bad box is refused before anything is asked, in checkBox's words", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool(
      "gate_box_set",
      { name: "box2", playwright: "http://box2.example" },
      ctx(api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/playwright is a ws:\/\/ or wss:\/\/ address/);
    expect(calls.some((c) => c.path === "/api/approvals")).toBe(false);
  });

  it("gate_box_remove asks with the name", async () => {
    const { api, calls } = fakeApi();
    const r = await callTool("gate_box_remove", { name: "box1" }, ctx(api));
    expect(r.isError).toBe(false);
    expect(calls[0]?.body).toEqual({
      action: "gate_box_remove",
      args: { name: "box1" },
    });
  });

  it("issue 1017: gate_box_set asks with playwright_endpoints, and refuses a bad one before asking", async () => {
    const eps = {
      "1.61": "ws://box1.example:3931",
      "1.63": "ws://box1.example:3932",
    };
    const { api, calls } = fakeApi();
    const ok = await callTool(
      "gate_box_set",
      { name: "box1", ssh: "runner@box1.example", playwright_endpoints: eps },
      ctx(api),
    );
    expect(ok.isError).toBe(false);
    expect((calls[0]?.body as { args: { box: unknown } }).args.box).toEqual({
      name: "box1",
      ssh: "runner@box1.example",
      browser_slots: 1,
      playwright_endpoints: eps,
    });
    const bad = fakeApi();
    const r = await callTool(
      "gate_box_set",
      { name: "box1", playwright_endpoints: { "1.61": "http://box1:1" } },
      ctx(bad.api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(
      /playwright_endpoints 1\.61 is a ws:\/\/ or wss:\/\/ address/,
    );
    expect(bad.calls.some((c) => c.path === "/api/approvals")).toBe(false);
  });
});
