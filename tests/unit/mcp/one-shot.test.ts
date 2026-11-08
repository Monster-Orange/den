/**
 * `<cli> mcp --call <tool> '<json>'` and `<cli> mcp --list`: one tool call
 * through the same tool layer (callTool, mcp.actions, every guard) as the
 * stdio server, against a fake web API.
 */
import { describe, expect, it } from "@jest/globals";
import {
  parseOneShot,
  runOneShot,
  type OneShotOptions,
} from "../../../src/ui/mcp/server.js";
import {
  APPROVAL_TOOL_NAMES,
  READ_TOOL_NAMES,
} from "../../../src/ui/mcp/tools.js";
import type { DenApi, Query } from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

function fakeApi(): { api: DenApi; calls: { path: string; query?: Query }[] } {
  const calls: { path: string; query?: Query }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:7777",
    async get(path, query) {
      calls.push({ path, query });
      if (path === "/api/health")
        return [{ repo: "shop", service: "api", ok: true }];
      return {};
    },
    async stream(path, query) {
      calls.push({ path, query });
      return { events: [], lines: [], ended: "done", exitCode: 0 };
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
});

function harness(c: ResolvedMcpConfig = cfg()) {
  const { api, calls } = fakeApi();
  const out: string[] = [];
  const err: string[] = [];
  const opts: OneShotOptions = {
    cfg: c,
    cli: "acme",
    api,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  };
  return { opts, calls, out, err };
}

describe("parseOneShot", () => {
  it("is null for the stdio server", () => {
    expect(parseOneShot([])).toBeNull();
    expect(parseOneShot(["--port", "7001"])).toBeNull();
  });

  it("reads --list", () => {
    expect(parseOneShot(["--list"])).toEqual({ kind: "list" });
  });

  it("reads --call <tool> with and without JSON args, around --port", () => {
    expect(parseOneShot(["--call", "status"])).toEqual({
      kind: "call",
      tool: "status",
      args: {},
    });
    expect(
      parseOneShot(["--port", "7001", "--call", "logs_tail", '{"lines":5}']),
    ).toEqual({ kind: "call", tool: "logs_tail", args: { lines: 5 } });
  });

  it("rejects a missing tool name, bad JSON and non-object args", () => {
    expect(() => parseOneShot(["--call"])).toThrow(/--call needs a tool name/);
    expect(() => parseOneShot(["--call", "status", "{nope"])).toThrow(
      /not JSON/,
    );
    expect(() => parseOneShot(["--call", "status", "[1]"])).toThrow(
      /JSON object/,
    );
  });
});

describe("runOneShot", () => {
  it("--list prints the registered tool names, actions only when enabled", async () => {
    const h = harness(cfg(["service_up"]));
    expect(await runOneShot({ kind: "list" }, h.opts)).toBe(0);
    expect(h.out.join("")).toBe(
      [...READ_TOOL_NAMES, ...APPROVAL_TOOL_NAMES, "service_up"].join("\n") +
        "\n",
    );
    expect(h.calls).toEqual([]);
  });

  it("--call prints a read tool's text and exits 0", async () => {
    const h = harness();
    const code = await runOneShot(
      { kind: "call", tool: "status", args: {} },
      h.opts,
    );
    expect(code).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({
      env: "local",
      services: [{ repo: "shop", service: "api", ok: true, state: "up" }],
    });
    expect(h.calls.map((c) => c.path)).toEqual(["/api/health"]);
  });

  it("--call on an action the org has not enabled is an error, exit 1", async () => {
    const h = harness();
    const code = await runOneShot(
      { kind: "call", tool: "service_down", args: { service: "shop/api" } },
      h.opts,
    );
    expect(code).toBe(1);
    expect(h.out.join("")).toMatch(/Unknown or disabled tool "service_down"/);
    expect(h.calls).toEqual([]);
  });

  it("--call goes through the guards: a production test run is refused", async () => {
    const h = harness(cfg(["run_tests"]));
    const code = await runOneShot(
      {
        kind: "call",
        tool: "run_tests",
        args: { pillar: "smoke", env: "production" },
      },
      h.opts,
    );
    expect(code).toBe(1);
    expect(h.out.join("")).toMatch(/^Refused: .*production/);
    // Only the refusal report; nothing reached an action route.
    expect(h.calls.map((c) => c.path)).toEqual(["/api/activity"]);
  });

  it("--call validates arguments against the tool's schema, strictly (exit 2, nothing called)", async () => {
    const h = harness(cfg(["run_tests"]));
    const typo = await runOneShot(
      { kind: "call", tool: "status", args: { wrkspace: "x" } },
      h.opts,
    );
    expect(typo).toBe(2);
    expect(h.err.join("")).toMatch(/--call status: invalid arguments/);
    expect(h.err.join("")).toMatch(/wrkspace/);
    expect(h.err.join("")).toMatch(/takes: /);
    const badEnum = await runOneShot(
      { kind: "call", tool: "run_tests", args: { pillar: "nope" } },
      h.opts,
    );
    expect(badEnum).toBe(2);
    expect(h.err.join("")).toMatch(/pillar: /);
    expect(h.out).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});
