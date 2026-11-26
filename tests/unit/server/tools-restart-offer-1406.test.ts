import { describe, expect, it } from "@jest/globals";
import type { RestartSelfCheck } from "../../../src/shared/agents/restart-self.js";
import {
  offerToolsRestarts,
  type ToolsRestartOfferDeps,
} from "../../../src/ui/server/tools-restart-offer.js";

type Asked = Parameters<ToolsRestartOfferDeps["request"]>[0];

const old = { from: "1.0.0", to: "1.1.0" };

function harness(
  over: Partial<ToolsRestartOfferDeps> & {
    stopped?: string[];
    pendingFor?: string[];
    failFor?: string[];
  } = {},
) {
  const asked: Asked[] = [];
  const d: ToolsRestartOfferDeps = {
    stale: async () => [
      {
        id: "ana",
        workspace: "north",
        stale: { adds: [], drops: [], den: old },
      },
      {
        id: "bo",
        workspace: "south",
        stale: { adds: [], drops: [], den: old },
      },
      { id: "cy", workspace: "north", stale: { adds: ["hub_x"], drops: [] } },
    ],
    pending: () =>
      (over.pendingFor ?? []).map((id) => ({
        action: "agent_restart_self",
        args: { agent: id },
      })),
    check: (a): RestartSelfCheck =>
      over.stopped?.includes(String(a.agent))
        ? { ok: false, error: `${String(a.agent)} is stopped` }
        : {
            ok: true,
            summary: `restart ${String(a.agent)} when idle`,
            params: { agent: String(a.agent), reason: String(a.reason) },
            details: ["Why: to run on the updated Den and its tools."],
            detailKeys: [],
            args: {
              agent: String(a.agent),
              project: String(a.project),
              reason: "update",
            },
          },
    request: (r) => {
      if (over.failFor?.includes(String(r.args.agent))) throw new Error("full");
      asked.push(r);
      return { id: `id-${String(r.args.agent)}` };
    },
    ...over,
  };
  return { d, asked };
}

describe("issue 1406, clause 4: after an update changes Den's tools, Den offers the restarts", () => {
  it("one ask per running agent on an older Den's tools, for the update, from Den", async () => {
    const { d, asked } = harness();
    expect(await offerToolsRestarts(d)).toEqual(["ana", "bo"]);
    expect(asked.map((a) => [a.action, a.args, a.params?.reason])).toEqual([
      [
        "agent_restart_self",
        { agent: "ana", project: "north", reason: "update" },
        "update",
      ],
      [
        "agent_restart_self",
        { agent: "bo", project: "south", reason: "update" },
        "update",
      ],
    ]);
    for (const a of asked) expect(a.actor).toMatch(/^den:/);
  });

  it("each from its own asker, so no per-asker limit drops one", async () => {
    const { d, asked } = harness();
    await offerToolsRestarts(d);
    expect(new Set(asked.map((a) => a.actor)).size).toBe(asked.length);
  });

  it("an agent whose only change is Hub's tools isn't offered here", async () => {
    const { d, asked } = harness();
    await offerToolsRestarts(d);
    expect(asked.map((a) => a.args.agent)).not.toContain("cy");
  });

  it("an agent with an ask already waiting gets no second one", async () => {
    const { d, asked } = harness({ pendingFor: ["ana"] });
    expect(await offerToolsRestarts(d)).toEqual(["bo"]);
    expect(asked.map((a) => a.args.agent)).toEqual(["bo"]);
  });

  it("one that can't be asked for (stopped, or the queue refuses) doesn't stop the rest", async () => {
    const a = harness({ stopped: ["ana"] });
    expect(await offerToolsRestarts(a.d)).toEqual(["bo"]);
    const b = harness({ failFor: ["ana"] });
    expect(await offerToolsRestarts(b.d)).toEqual(["bo"]);
  });

  it("nothing to offer when the agents can't be read", async () => {
    const { d, asked } = harness({
      stale: async () => {
        throw new Error("no host");
      },
    });
    expect(await offerToolsRestarts(d)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
