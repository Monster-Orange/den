/**
 * 0.4.49 GATE-SLOT (den#144): the MCP tools. An agent reads the queue,
 * holds a slot across commands, and gives back only its own.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  READ_TOOL_NAMES,
  callTool,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import { GateStore } from "../../../src/shared/gates/store.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const api: DenApi = {
  baseUrl: "http://localhost:47003",
  async get(p) {
    if (p === "/api/workspaces")
      return { active: ["north"], workspaces: { north: {} } };
    throw new Error(`no API call expected: ${p}`);
  },
  async stream() {
    throw new Error("no streams here");
  },
};

function ctx(): ToolContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gatemcp-"));
  tmps.push(dir);
  return {
    api,
    cfg: {
      actions: [],
      runTestsEnvs: ["local"],
      logsRemote: false,
      approvals: true,
    },
    cli: "acme",
    scope: { workspace: "north", actor: "agent:coder" },
    gates: new GateStore({ dir, alive: () => true }),
  };
}

const json = (r: { text: string }) =>
  JSON.parse(r.text) as Record<string, unknown>;

describe("gate slots over MCP", () => {
  it("are always there", () => {
    expect(READ_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "gate_slot_status",
        "gate_slot_request",
        "gate_slot_release",
      ]),
    );
  });

  it("an agent asks, waits on its id, and gives it back", async () => {
    const c = ctx();
    const other = c.gates!.ask({
      kind: "browser",
      who: "a person",
      label: "suite",
      pid: 7,
      estimateMin: 6,
    });
    const mine = json(
      await callTool(
        "gate_slot_request",
        { kind: "browser", label: "e2e", estimate_minutes: 4 },
        c,
      ),
    );
    expect(mine).toMatchObject({
      kind: "browser",
      who: "agent:coder · north",
      granted: false,
    });
    expect(typeof mine.expectedStart).toBe("string");
    const status = json(await callTool("gate_slot_status", {}, c));
    expect((status.slots as { id: string }[]).map((s) => s.id)).toEqual([
      other.id,
      mine.id,
    ]);
    c.gates!.release(other.id);
    expect(
      json(await callTool("gate_slot_request", { id: mine.id }, c)),
    ).toMatchObject({ granted: true });
    expect(
      json(await callTool("gate_slot_release", { id: mine.id }, c)),
    ).toEqual({ released: true });
    expect(c.gates!.list()).toEqual([]);
  });

  it("an agent can't wait on or give back a slot that isn't its own", async () => {
    const c = ctx();
    const other = c.gates!.ask({
      kind: "cpu",
      who: "a person",
      label: "unit",
      pid: 7,
      estimateMin: 6,
    });
    const r = await callTool("gate_slot_release", { id: other.id }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("that slot isn't yours");
    expect(
      (await callTool("gate_slot_request", { id: other.id }, c)).isError,
    ).toBe(true);
    expect(c.gates!.list().map((e) => e.id)).toEqual([other.id]);
  });
});
