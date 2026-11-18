/**
 * #390: after Den updates itself, each agent whose tools started on the old
 * Den (its session launched before the new engine was installed) is
 * restarted at its next idle, on the same conversation: once, a busy one
 * after its turn, none with server_agent.refresh_agents off. The bell says
 * which were refreshed. Every dependency is faked: no agent, no session.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readUpdateState,
  updateStateFile,
} from "../../../src/ui/server/den-update.js";
import {
  refreshAfterUpdate,
  UpdateRefresh,
  type RefreshAgent,
} from "../../../src/ui/server/update-refresh.js";

const INSTALLED = Date.parse("2026-11-17T19:34:30.000Z");
const UPDATE = { to: "0.4.65", at: "2026-11-17T19:34:40.000Z" };
const OLD: RefreshAgent = {
  id: "planner",
  workspace: "north",
  launchedAt: "2026-11-16T17:40:00.000Z",
};
const NEW: RefreshAgent = {
  id: "fresh",
  workspace: "north",
  launchedAt: "2026-11-17T19:35:00.000Z",
};
const SERVER: RefreshAgent = {
  id: "server",
  workspace: "den-server",
  launchedAt: "2026-11-16T17:40:00.000Z",
};

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-390-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function rig(o: {
  on?: boolean;
  agents?: RefreshAgent[];
  states?: Record<string, "missing" | "stopped" | "busy" | "idle">;
}) {
  const states = { ...(o.states ?? {}) };
  const restarted: string[] = [];
  const bells: { ids: string[]; version: string }[] = [];
  const make = () =>
    new UpdateRefresh({
      on: () => o.on ?? true,
      agents: () => o.agents ?? [OLD, NEW, SERVER],
      installedAt: () => INSTALLED,
      state: async (a) => states[a.id] ?? "idle",
      restart: async (a) => {
        restarted.push(a.id);
        return true;
      },
      bell: (r, version) => bells.push({ ids: r.map((a) => a.id), version }),
      file: path.join(tmp, "refresh.json"),
      log: () => {},
    });
  return { make, states, restarted, bells };
}

describe("#390: Den restarts agents whose tools predate its update", () => {
  it("an idle agent with old tools is restarted once; one started after the install is not", async () => {
    const r = rig({});
    const u = r.make();
    expect(u.begin(UPDATE).map((a) => a.id)).toEqual(["planner", "server"]);
    expect(await u.pump()).toBe(true);
    expect(r.restarted).toEqual(["planner", "server"]);
    // Again, and from a new Den process (the marker file): never twice.
    expect(await u.pump()).toBe(true);
    const again = r.make();
    expect(again.begin(UPDATE)).toEqual([]);
    await again.pump();
    expect(r.restarted).toEqual(["planner", "server"]);
    // The bell, once, names them.
    expect(r.bells).toEqual([
      { ids: ["planner", "server"], version: "0.4.65" },
    ]);
  });

  it("a busy agent waits for idle; a stopped one is left alone", async () => {
    const r = rig({ states: { planner: "busy", server: "stopped" } });
    const u = r.make();
    u.begin(UPDATE);
    expect(await u.pump()).toBe(false);
    expect(r.restarted).toEqual([]);
    expect(await u.pump()).toBe(false);
    r.states.planner = "idle";
    expect(await u.pump()).toBe(true);
    expect(r.restarted).toEqual(["planner"]);
    expect(r.bells).toEqual([{ ids: ["planner"], version: "0.4.65" }]);
  });

  it("with server_agent.refresh_agents off, nothing is restarted and the bell is quiet", async () => {
    const r = rig({ on: false });
    const u = r.make();
    expect(u.begin(UPDATE)).toEqual([]);
    expect(await u.pump()).toBe(true);
    expect(r.restarted).toEqual([]);
    expect(r.bells).toEqual([]);
  });

  it("a later update refreshes again (once per update)", async () => {
    const r = rig({ agents: [OLD] });
    const u = r.make();
    u.begin(UPDATE);
    await u.pump();
    const next = r.make();
    next.begin({ to: "0.4.66", at: "2026-11-18T10:00:00.000Z" });
    await next.pump();
    expect(r.restarted).toEqual(["planner", "planner"]);
  });
});

describe("#390: from the recorded update (server-agent/update/state.json)", () => {
  function record(state: string, to = "0.4.65") {
    const f = updateStateFile(tmp);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(
      f,
      JSON.stringify({ state, from: "0.4.64", to, at: UPDATE.at }) + "\n",
    );
  }
  const run = (
    r: ReturnType<typeof rig>,
    o: { version?: string; onSleep?: () => void; waitMs?: number } = {},
  ) => {
    let t = 0;
    return refreshAfterUpdate({
      version: o.version ?? "0.4.65",
      readState: () => readUpdateState(tmp),
      waitMs: o.waitMs ?? 60_000,
      refresh: r.make(),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        o.onSleep?.();
      },
    });
  };

  it("a good update to this version: the idle agent on old tools is restarted once", async () => {
    record("good");
    const r = rig({ agents: [OLD, NEW] });
    expect((await run(r)).map((a) => a.id)).toEqual(["planner"]);
    expect(r.restarted).toEqual(["planner"]);
    // Den starts again on the same version: nobody twice.
    expect(await run(r)).toEqual([]);
    expect(r.restarted).toEqual(["planner"]);
  });

  it("while the update is watched, it waits for the verdict; a busy agent waits for idle", async () => {
    record("watching");
    const r = rig({ agents: [OLD], states: { planner: "busy" } });
    let sleeps = 0;
    await run(r, {
      onSleep: () => {
        sleeps++;
        if (sleeps === 2) record("good");
        if (sleeps === 5) r.states.planner = "idle";
        if (sleeps > 50) throw new Error("never idle");
      },
    });
    expect(r.restarted).toEqual(["planner"]);
    expect(sleeps).toBe(5);
  });

  it("rolled back, another version's record, or no verdict in time: no agent is restarted", async () => {
    const r = rig({ agents: [OLD] });
    record("rolled_back");
    expect(await run(r)).toEqual([]);
    record("good", "0.4.66");
    expect(await run(r)).toEqual([]);
    record("watching");
    expect(await run(r, { waitMs: 10_000 })).toEqual([]);
    expect(r.restarted).toEqual([]);
  });

  it("with the setting off, a good update restarts none", async () => {
    record("good");
    const r = rig({ on: false, agents: [OLD] });
    expect(await run(r)).toEqual([]);
    expect(r.restarted).toEqual([]);
  });
});
