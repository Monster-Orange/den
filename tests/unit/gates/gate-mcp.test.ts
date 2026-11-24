/**
 * Issue 144 GATE-SLOT: the MCP tools. An agent reads the queue, holds a
 * slot across commands, sees who holds the machine and until when, and
 * gives back only its own. It can never end someone else's.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ACTION_TOOL_NAMES,
  READ_TOOL_NAMES,
  callTool,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { GATE_DEFAULTS } from "../../../src/shared/gates/rules.js";

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
} as unknown as DenApi;

function ctx(dir?: string, actor = "agent:coder"): ToolContext {
  const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "den-gatemcp-"));
  if (!dir) tmps.push(d);
  return {
    api,
    cfg: {
      actions: [],
      runTestsEnvs: ["local"],
      logsRemote: false,
      approvals: true,
    } as unknown as ToolContext["cfg"],
    cli: "acme",
    scope: { workspace: "north", actor },
    gates: new GateStore({
      platform: "linux",
      dir: d,
      alive: () => true,
    }),
  };
}

const json = (r: { text: string }) =>
  JSON.parse(r.text) as Record<string, unknown>;

describe("gate slots over MCP", () => {
  it("are always there; none ends another's slot", () => {
    expect(READ_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "gate_slot_status",
        "gate_slot_request",
        "gate_slot_release",
      ]),
    );
    expect(
      [...READ_TOOL_NAMES, ...ACTION_TOOL_NAMES].filter((n) =>
        /gate.*end/.test(n),
      ),
    ).toEqual([]);
  });

  it("two agents ask for browser at once: the second waits, sees the first's expected end; neither is stopped", async () => {
    const first = ctx(undefined, "agent:one");
    const second = ctx(first.gates!.dir, "agent:two");
    const a = json(
      await callTool(
        "gate_slot_request",
        { kind: "browser", label: "e2e", estimate_minutes: 6 },
        first,
      ),
    );
    const b = json(
      await callTool(
        "gate_slot_request",
        { kind: "browser", label: "e2e", estimate_minutes: 4 },
        second,
      ),
    );
    expect(a).toMatchObject({
      kind: "browser",
      who: "agent:one · north",
      granted: true,
    });
    expect(b).toMatchObject({ who: "agent:two · north", granted: false });
    expect(b.expectedStart).toBe(a.expectedEnd);
    expect(b.heldBy).toEqual([
      expect.objectContaining({
        id: a.id,
        who: "agent:one · north",
        kind: "browser",
        expectedEnd: a.expectedEnd,
      }),
    ]);
    // Asking again only waits: the first keeps its slot.
    expect(
      json(await callTool("gate_slot_request", { id: b.id }, second)),
    ).toMatchObject({ granted: false });
    expect(first.gates!.get(String(a.id))?.grantedAt).toBeDefined();
    // The first gives it back; the second has it.
    expect(
      json(await callTool("gate_slot_release", { id: a.id }, first)),
    ).toEqual({ released: true });
    expect(
      json(await callTool("gate_slot_request", { id: b.id }, second)),
    ).toMatchObject({ granted: true });
  });

  it("status shows every holder and waiter with the machine's settings", async () => {
    const c = ctx();
    const other = c.gates!.ask({
      kind: "browser",
      who: "a person",
      label: "suite",
      pid: 7,
      estimateMin: 6,
    });
    const mine = json(await callTool("gate_slot_request", { kind: "cpu" }, c));
    const status = json(await callTool("gate_slot_status", {}, c));
    expect((status.slots as { id: string }[]).map((s) => s.id)).toEqual([
      other.id,
      mine.id,
    ]);
    expect(status.settings).toEqual({
      cpuSlots: 2,
      cpuSlotsBesideBrowser: 2,
      cpuSlotsBesideReleaseBrowser: 0,
      // Issue 1009: cores × 4 / 3 on the machine the test runs on.
      cpuHoldLoad: GATE_DEFAULTS.cpuHoldLoad,
      loadHoldPerCore: 3,
      // Issue 1132: cores × 1.5 on the machine the test runs on.
      maxStartLoad: GATE_DEFAULTS.maxStartLoad,
      maxStartWaitMinutes: 10,
      reapGraceSeconds: 10,
      memoryFreeMinPercent: 10,
      memoryReadingKeepSeconds: 30,
      swapHoldGb: 8,
      vmMemoryShare: 1,
      localBrowserSlots: 1,
      overrunMarginMinutes: 15,
      overrunBellMultiple: 2,
      priorityMax: 1,
      priorityPassLimitMinutes: 0,
      priorityAgents: true,
      priorityRunners: true,
      claimMinutes: 3,
      mcpRenewMinutes: 5,
      mcpLapseMinutes: 15,
      mcpGraceMinutes: 15,
      browserRequiresContainer: false,
      browserBoxDefault: "any",
      browserHostOnly: "",
      remoteRenewSeconds: 30,
      waiterReturnMinutes: 10,
      remoteLapseSeconds: 120,
      remoteMaxSlots: 4,
      remoteMaxAsks: 4,
      boxCheckTimeoutSeconds: 8,
      boxRecheckSeconds: 30,
    });
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

describe("issue 1023: gate_slot_release and a gate run's own entry", () => {
  /** An entry as `gate run` from an agent's shell makes it. */
  const cliEntry = (c: ToolContext, actor?: string) =>
    c.gates!.ask({
      kind: "browser",
      who: `Den · north · ${actor ?? "a person"}`,
      label: "e2e",
      pid: 7,
      estimateMin: 6,
      agent: !!actor,
      project: "north",
      ...(actor ? { actor } : {}),
    });

  it("the same agent frees the entry its own gate run made", async () => {
    const c = ctx(undefined, "agent:coder");
    const e = cliEntry(c, "agent:coder");
    const r = await callTool("gate_slot_release", { id: e.id }, c);
    expect(r.isError).toBeFalsy();
    expect(json(r)).toEqual({ released: true });
    expect(c.gates!.list()).toEqual([]);
    expect(c.gates!.events().map((x) => x.event)).toEqual([
      "asked",
      "granted",
      "released",
    ]);
  });

  it("another agent, or a person's entry, is refused and stays", async () => {
    const c = ctx(undefined, "agent:other");
    const theirs = cliEntry(c, "agent:coder");
    const persons = cliEntry(c);
    for (const id of [theirs.id, persons.id]) {
      const r = await callTool("gate_slot_release", { id }, c);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("that slot isn't yours");
    }
    expect(c.gates!.list().map((x) => x.id)).toEqual([theirs.id, persons.id]);
  });

  it("a CI runner's entry with the same name is never the agent's", async () => {
    const c = ctx(undefined, "agent:coder");
    const e = c.gates!.askRemote({
      kind: "cpu",
      who: "runner",
      label: "ci",
      estimateMin: 5,
      runner: "agent:coder",
      tokenId: "t1",
    });
    const r = await callTool("gate_slot_release", { id: e.id }, c);
    expect(r.isError).toBe(true);
    expect(c.gates!.list().map((x) => x.id)).toEqual([e.id]);
  });
});

describe("issue 1048: an agent's cpu slot over MCP", () => {
  it("says how many workers its run may use, and why it waits on the load", async () => {
    let load5 = 0;
    const dir = ctx().gates!.dir;
    const as = (actor: string) => ({
      ...ctx(dir, actor),
      gates: new GateStore({
        platform: "linux",
        dir,
        alive: () => true,
        load: () => load5,
        cores: () => 18,
      }),
    });
    const ask = { kind: "cpu", label: "unit", estimate_minutes: 5 };
    const a = json(await callTool("gate_slot_request", ask, as("agent:one")));
    expect(a.granted).toBeTruthy();
    expect(a.workers).toBe(9);
    load5 = 60;
    const b = json(await callTool("gate_slot_request", ask, as("agent:two")));
    expect(b.granted).toBeFalsy();
    expect(b.workers).toBeUndefined();
    expect(b.loadHold).toEqual({
      why: "cores",
      load: 60,
      limit: 54,
      perCore: 3,
      cores: 18,
    });
    load5 = 40;
    const c = json(
      await callTool("gate_slot_request", { id: b.id }, as("agent:two")),
    );
    expect(c.granted).toBeTruthy();
    expect(c.loadHold).toBeUndefined();
  });
});
