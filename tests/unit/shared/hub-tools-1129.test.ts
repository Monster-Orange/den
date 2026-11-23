/**
 * Issue 1129: Hub's new tools restart agents through the one restart
 * queue (a batch at a time, a gap between), compared by the tools' content
 * (names, parameters, required), never by whether Hub answered. An agent
 * launched while Hub didn't answer has none of Hub's tools: it restarts,
 * through the queue, once Hub is back. Fakes for Hub, the agents, time and
 * load; invented names.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HubToolsWatch } from "../../../src/shared/hub-tools.js";
import { RestartQueue } from "../../../src/shared/agents/restart-queue.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1129-hub-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;

const tool = (name: string, props: string[]) => ({
  name,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])),
    required: props.slice(0, 1),
  },
});
const OLD = [tool("hub_search", ["q"]), tool("hub_get", ["id"])];
const NEW = [...OLD, tool("hub_put", ["path"])];

function world(batch = 4) {
  let list: unknown[] | "down" = OLD;
  let t = Date.parse("2026-11-22T10:00:00Z");
  const agents: { id: string; conv: string; launchedAt: string }[] = [];
  const restarted: string[] = [];
  const sleeps: Array<() => void> = [];
  const queue = new RestartQueue({
    config: () => ({ batch, gapMs: 30_000, loadCeiling: 0 }),
    load: () => 0,
    now: () => 0,
    sleep: () => new Promise<void>((go) => sleeps.push(go)),
  });
  const launch = (id: string) => {
    t += 1000;
    const a = agents.find((x) => x.id === id);
    if (a) a.launchedAt = new Date(t).toISOString();
    else
      agents.push({
        id,
        conv: `c-${id}`,
        launchedAt: new Date(t).toISOString(),
      });
  };
  const w = new HubToolsWatch({
    fetchTools: async () => {
      if (list === "down") throw new Error("Hub didn't answer");
      return list;
    },
    agents: () => agents.map((a) => ({ ...a })),
    state: async () => "idle",
    type: async () => true,
    reloadsInPlace: () => false,
    restart: (id) =>
      queue.add({
        id,
        why: "hub-tools",
        run: async () => {
          restarted.push(id);
          launch(id); // its new launch reads Hub's list
        },
      }),
    file: path.join(dir, `state-${++n}.json`),
  });
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return {
    w,
    launch,
    restarted,
    sleeps,
    flush,
    hub: (l: unknown[] | "down") => (list = l),
    /** Hub's list read again, then one pass. */
    beat: async () => {
      await w.check();
      await w.pump();
      await flush();
    },
  };
}

describe("issue 1129: Hub's tools restart agents through the queue", () => {
  it("60 agents need Hub's new tools: no more than the batch size restart per gap", async () => {
    const x = world(4);
    for (let i = 1; i <= 60; i++) x.launch(`a${i}`);
    await x.beat();
    expect(x.restarted).toEqual([]);
    x.hub(NEW);
    await x.beat();
    expect(x.restarted).toHaveLength(4);
    x.sleeps.shift()!();
    await x.flush();
    expect(x.restarted).toHaveLength(8);
  });

  it("Hub goes away and comes back with the same list: nobody restarts", async () => {
    const x = world(100);
    for (const id of ["a1", "a2", "a3"]) x.launch(id);
    await x.beat();
    x.hub("down");
    await x.beat();
    await x.beat();
    x.hub(OLD);
    await x.beat();
    await x.beat();
    expect(x.restarted).toEqual([]);
  });

  it("Hub comes back with one added tool: only the agents whose list lacks it restart", async () => {
    const x = world(100);
    for (const id of ["a1", "a2"]) x.launch(id);
    await x.beat();
    x.hub(NEW);
    x.launch("a3"); // started after the change: it has hub_put
    await x.beat();
    await x.w.settled();
    expect(x.restarted.sort()).toEqual(["a1", "a2"]);
    await x.beat();
    expect(x.restarted.sort()).toEqual(["a1", "a2"]);
  });

  it("an agent launched while Hub was down restarts once Hub is back, through the queue; one launched before doesn't", async () => {
    const x = world(1);
    x.launch("before");
    await x.beat();
    x.hub("down");
    await x.beat();
    x.launch("during"); // resumed while Hub didn't answer: no Hub tools
    await x.beat();
    expect(x.restarted).toEqual([]);
    x.hub(OLD);
    await x.beat();
    expect(x.restarted).toEqual(["during"]);
    await x.w.settled();
    await x.beat();
    expect(x.restarted).toEqual(["during"]);
  });

  it("Den started while Hub was down: its agents restart once Hub answers", async () => {
    const x = world(100);
    x.hub("down");
    x.launch("a1");
    await x.beat();
    x.hub(OLD);
    await x.beat();
    expect(x.restarted).toEqual(["a1"]);
  });
});
