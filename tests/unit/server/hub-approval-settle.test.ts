/**
 * P0-D2: what Den does with an owner's approval. It reads the agent's
 * project, clears the questions that name the approval, writes an audit
 * line per question cleared, and tells each other agent whose question
 * named it, with a Den item (never acked to Hub), once per approval.
 * Fakes only; invented names.
 */
import { describe, expect, it } from "@jest/globals";
import {
  LOCAL_PREFIX,
  type Delivery,
} from "../../../src/shared/hub/hub-delivery";
import { settleApproval } from "../../../src/ui/server/hub-approval";

const KEY = "https://hub.example.test/a/doc";
const dv: Delivery = {
  id: "d9",
  kind: "approve",
  version: 2,
  agent: "ag-1",
  project: "web",
  thread: { kind: "decision", id: "th9", url: KEY, artifact: "Pricing page" },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body: "",
  createdAt: "2026-01-02T03:00:00Z",
};

function rig(cleared: string[]) {
  const calls: { agent: string; ws: string; keys: string[] }[] = [];
  const taken: Delivery[] = [];
  const logs: string[] = [];
  const deps = {
    approvedAbout: (agent: string, ws: string, keys: string[]) => {
      calls.push({ agent, ws, keys });
      return cleared.map((x) => ({ agent: x, key: KEY }));
    },
    log: (l: string) => logs.push(l),
    workspaceOf: (a: string) => (a === "ag-1" ? "north" : null),
    owner: () => ({ ownerId: "u_me", company: "Acme" }),
    takeLocal: async (d: Delivery) => {
      taken.push(d);
      return true;
    },
  };
  return { calls, taken, deps, logs };
}

describe("P0-D2: settleApproval", () => {
  it("clears in the agent's own Den project, with the approval's keys", async () => {
    const r = rig(["ag-1"]);
    await settleApproval(dv, r.deps);
    expect(r.calls).toEqual([
      { agent: "ag-1", ws: "north", keys: expect.arrayContaining([KEY]) },
    ]);
    expect(r.taken).toEqual([]);
  });

  it("tells each other agent with a Den item of its own", async () => {
    const r = rig(["ag-2", "ag-3"]);
    await settleApproval(dv, r.deps);
    expect(r.taken.map((d) => [d.agent, d.id])).toEqual([
      ["ag-2", `${LOCAL_PREFIX}approval:d9:ag-2`],
      ["ag-3", `${LOCAL_PREFIX}approval:d9:ag-3`],
    ]);
    expect(r.taken[0].text).toContain("Pat Example");
  });

  it("writes an audit line per question cleared: the agent, the delivery and the key, never the text", async () => {
    const r = rig(["ag-1", "ag-2"]);
    await settleApproval(dv, r.deps);
    expect(r.logs).toEqual([
      `hub approval: cleared ag-1's question (delivery d9, kind approve, names ${KEY})`,
      `hub approval: cleared ag-2's question (delivery d9, kind approve, names ${KEY}); told it`,
    ]);
  });

  it("an agent Den has no record of: nothing is cleared", async () => {
    const r = rig(["ag-2"]);
    await settleApproval({ ...dv, agent: "gone" }, r.deps);
    expect(r.calls).toEqual([]);
    expect(r.taken).toEqual([]);
  });
});
