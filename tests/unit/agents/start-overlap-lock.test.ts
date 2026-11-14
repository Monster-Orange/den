/**
 * Review M1 (0.4.46): two starts of one agent at once (two Start fresh
 * clicks, or one beside a relaunch) never both run. One starts it; the
 * other, waiting its turn, finds it running and is refused. The running
 * agent keeps its Den token.
 *
 * A real host on a temp socket, a scripted PTY. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  actorTokenOf,
  lookupActorToken,
} from "../../../src/shared/actor-token.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  resolveAgentsDeps,
  startAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, settle } from "./helpers/rig.js";

afterEach(cleanupRigs);

describe("two starts of one agent at once", () => {
  it("one runs, the other is refused as running; the live agent's token still works", async () => {
    const r = await rig();
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    expect(await cmdAgents(["stop", "planner"], r.deps)).toBe(0);
    r.made[0].exit(143);
    await settle();
    const d = resolveAgentsDeps(r.deps);
    const one = { workspace: "north", persona: "planner", id: "planner" };
    const out = await Promise.allSettled([
      startAgent(d, one),
      startAgent(d, one),
    ]);
    const ok = out.filter((o) => o.status === "fulfilled");
    const no = out.filter(
      (o): o is PromiseRejectedResult => o.status === "rejected",
    );
    expect([ok.length, no.length]).toEqual([1, 1]);
    expect(String(no[0].reason?.message)).toMatch(/running/);
    // Two sessions in all: the first (exited) and the one that runs.
    expect(r.made).toHaveLength(2);
    const token = actorTokenOf(r.made[1].opts.env);
    expect(token).toBeTruthy();
    expect(lookupActorToken(r.stateDir, token!)).toBeTruthy();
  });
});
