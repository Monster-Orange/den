/**
 * Issue 1223: after Den updates, agents still on older tools are one bell
 * row, "N agents are on older tools", with one Restart N agents for the
 * person. It sends them through the restart queue (issue 1129: a batch at
 * a time, under the load ceiling), shows how far it got, and keeps an
 * agent that failed listed with its reason while the others finish.
 */
import { describe, expect, it } from "@jest/globals";
import { RestartQueue } from "../../../src/shared/agents/restart-queue.js";
import { ToolsRestarts } from "../../../src/shared/agents/tools-restarts.js";

const three = [
  { id: "ana", workspace: "north" },
  { id: "bo", workspace: "north" },
  { id: "cy", workspace: "south" },
];
const flush = () => new Promise<void>((r) => setImmediate(r));

/** A queue whose gap ends only when the test says. */
function gatedQueue(batch: number) {
  let open: (() => void) | null = null;
  const q = new RestartQueue({
    config: () => ({ batch, gapMs: 30_000, loadCeiling: 0 }),
    load: () => 0,
    sleep: () => new Promise<void>((r) => (open = r)),
  });
  return { q, gap: () => open?.() };
}

describe("issue 1223: one bell row for the agents on older tools", () => {
  it("three stale sessions: one row naming 3, with Restart 3", () => {
    const t = new ToolsRestarts({
      queue: { add: async () => undefined },
      restart: async () => undefined,
    });
    expect(t.row([])).toBeNull();
    expect(t.row(three)).toEqual({
      kind: "tools_old",
      id: "tools-old",
      n: 3,
      agents: [
        { agent: "ana", workspace: "north" },
        { agent: "bo", workspace: "north" },
        { agent: "cy", workspace: "south" },
      ],
    });
  });

  it("Restart sends all three through the queue, never more at once than its batch", async () => {
    const { q, gap } = gatedQueue(2);
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const t = new ToolsRestarts({
      queue: q,
      restart: (a) =>
        new Promise<void>((r) => {
          started.push(a.id);
          finish.set(a.id, r);
        }),
    });
    expect(t.start(three).map((a) => a.id)).toEqual(["ana", "bo", "cy"]);
    await flush();
    // The first batch only: two, then the gap.
    expect(started).toEqual(["ana", "bo"]);
    expect(t.row(three)?.restarting).toEqual({ done: 0, total: 3 });
    finish.get("ana")!();
    await flush();
    expect(t.row(three)?.restarting).toEqual({ done: 1, total: 3 });
    gap();
    await flush();
    expect(started).toEqual(["ana", "bo", "cy"]);
    finish.get("bo")!();
    finish.get("cy")!();
    await flush();
    // All back: the row clears, even before the stale list is asked again.
    expect(t.row(three)).toBeNull();
  });

  it("one that fails stays listed with its reason; the others finish", async () => {
    const t = new ToolsRestarts({
      queue: { add: (j) => j.run() },
      restart: async (a) => {
        if (a.id === "bo") throw new Error("bo exited at once");
      },
    });
    t.start(three);
    await flush();
    expect(t.row(three)).toEqual({
      kind: "tools_old",
      id: "tools-old",
      n: 1,
      agents: [
        { agent: "bo", workspace: "north", reason: "bo exited at once" },
      ],
    });
    // A new Restart tries it again.
    t.start([three[1]!]);
    await flush();
    expect(t.row([three[1]!])?.agents[0]?.reason).toBe("bo exited at once");
  });

  it("an agent already in a running batch isn't queued twice", async () => {
    const adds: string[] = [];
    const t = new ToolsRestarts({
      queue: {
        add: (j) => {
          adds.push(j.id);
          return new Promise(() => undefined);
        },
      },
      restart: async () => undefined,
    });
    t.start(three);
    expect(t.start(three)).toEqual([]);
    expect(adds).toEqual(["ana", "bo", "cy"]);
  });
});
