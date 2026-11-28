/**
 * Issue 329: a read-only `doctor` MCP tool for the server agent. It runs
 * `<cli> doctor --json` (never --probe, which starts sessions) and returns
 * every check, the passing ones too, through the redactor every tool's
 * answer goes through. Only the person's CLI and this install's own server
 * agent (unscoped) may run it; a project agent's scoped server refuses it
 * before anything runs. The run is a fake here: no doctor runs.
 */
import { describe, expect, it } from "@jest/globals";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import { callTool, toolsFor } from "../../../src/ui/mcp/tools.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

const api = {
  baseUrl: "http://localhost:7000",
  async get(p: string) {
    if (p === "/api/workspaces")
      return { active: ["north"], focus: "north", workspaces: { north: {} } };
    throw new Error(`no API call expected: ${p}`);
  },
  async stream() {
    throw new Error("no stream here");
  },
} as unknown as DenApi;

const cfg = (): ResolvedMcpConfig => ({
  actions: [],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
});

const REPORT = {
  ok: false,
  checks: [
    { id: "node", status: "ok", detail: "node 24.13.0" },
    {
      id: "hub",
      status: "warn",
      detail: "Hub token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected",
    },
    { id: "edge", status: "fail", detail: "the edge is down" },
  ],
};

function runner(out: string, code = 1) {
  const runs: string[][] = [];
  return {
    runs,
    doctor: async (args: string[]) => {
      runs.push(args);
      return { code, out };
    },
  };
}

describe("issue 329: doctor", () => {
  it("is registered for every unscoped server, with no action to turn on", () => {
    expect(toolsFor(cfg()).map((t) => t.name)).toContain("doctor");
  });

  it("runs doctor --json and returns every check, passing ones too, redacted", async () => {
    const r0 = runner(`some banner\n${JSON.stringify(REPORT)}`);
    const r = await callTool(
      "doctor",
      {},
      { api, cfg: cfg(), cli: "acme", doctor: r0.doctor },
    );
    // A failing check is doctor's answer, not the tool's error.
    expect(r.isError).toBe(false);
    expect(r0.runs).toEqual([["doctor", "--json"]]);
    const out = JSON.parse(r.text) as {
      ok: boolean;
      checks: { id: string; status: string; detail: string }[];
      counts: Record<string, number>;
    };
    expect(out.checks.map((c) => `${c.status} ${c.id}`)).toEqual([
      "ok node",
      "warn hub",
      "fail edge",
    ]);
    expect(out.counts).toEqual({ ok: 1, warn: 1, fail: 1 });
    expect(out.ok).toBe(false);
    expect(r.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("a doctor that printed no report: an error naming the exit and its last output", async () => {
    const r0 = runner("Error: cannot find den.yml", 2);
    const r = await callTool(
      "doctor",
      {},
      { api, cfg: cfg(), cli: "acme", doctor: r0.doctor },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/exit 2/);
    expect(r.text).toMatch(/cannot find den\.yml/);
  });

  it("a project agent's scoped server: refused before anything runs, naming who can", async () => {
    const r0 = runner(JSON.stringify(REPORT));
    const r = await callTool(
      "doctor",
      {},
      {
        api,
        cfg: cfg(),
        cli: "acme",
        scope: { workspace: "north", actor: "agent:builder" },
        doctor: r0.doctor,
      },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/server agent/);
    expect(r0.runs).toEqual([]);
  });
});
