import { describe, expect, it } from "@jest/globals";
import type { RestartSelfCheck } from "../../../src/shared/agents/restart-self.js";
import type { Notification } from "../../../src/shared/notifications.js";
import {
  matchFreeTextRestarts,
  type FreeTextRestartDeps,
} from "../../../src/ui/server/free-text-restarts.js";

type Asked = Parameters<FreeTextRestartDeps["request"]>[0];

const q = (id: string, agent: string, text: string, over = {}): Notification =>
  ({
    id,
    kind: "waiting",
    subject: `agent:${agent}`,
    scope: "workspace/north",
    text: `${agent} asked: ${text}`,
    msg: { key: "bell.m.asked", vars: { name: agent, text } },
    at: "2026-11-25T10:00:00.000Z",
    read: false,
    ...over,
  }) as unknown as Notification;

function harness(
  rows: Notification[],
  pendingFor: string[] = [],
  askedFor: string[] = [],
) {
  const asked: Asked[] = [];
  const d: FreeTextRestartDeps = {
    rows: () => rows,
    pending: () =>
      pendingFor.map((id) => ({
        action: "agent_restart_self",
        args: { agent: id },
      })),
    askedBefore: (actor) =>
      askedFor.some((id) => actor === `den:free-text:north/${id}`),
    check: (a): RestartSelfCheck =>
      a.agent === "stopped-one"
        ? { ok: false, error: "stopped" }
        : {
            ok: true,
            summary: `restart ${String(a.agent)} when idle`,
            params: { agent: String(a.agent), reason: String(a.reason) },
            details: [],
            detailKeys: [],
            args: {
              agent: String(a.agent),
              project: "north",
              reason: "tools",
            },
          },
    request: (r) => {
      asked.push(r);
      return { id: `ap-${String(r.args.agent)}` };
    },
  };
  return { d, asked };
}

describe("issue 1406, clause 3: free-text restart asks already waiting join the card", () => {
  it("a question that says restart and tools becomes a structured ask, from Den, with the agent's words", async () => {
    const { d, asked } = harness([
      q("n1", "ana", "Please restart me so I get the new Hub tools."),
      q("n2", "bo", "Could you Restart this session? The tool list changed."),
    ]);
    expect(await matchFreeTextRestarts(d)).toEqual(["ana", "bo"]);
    expect(
      asked.map((a) => [a.actor, a.action, a.args.agent, a.args.reason]),
    ).toEqual([
      ["den:free-text:north/ana", "agent_restart_self", "ana", "tools"],
      ["den:free-text:north/bo", "agent_restart_self", "bo", "tools"],
    ]);
    for (const a of asked) expect(a).not.toHaveProperty("agent");
    expect(asked[0]!.note).toBe(
      "From ana's question: Please restart me so I get the new Hub tools.",
    );
  });

  it("the question itself stays, as it was", async () => {
    const rows = [
      q("n1", "ana", "restart me for the new tools, and is 2 right?"),
    ];
    const before = JSON.stringify(rows);
    const { d } = harness(rows);
    await matchFreeTextRestarts(d);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("Japanese words for restart and tools match too", async () => {
    const { d } = harness([
      q("n1", "cy", "新しいツールを使うために再起動してください"),
    ]);
    expect(await matchFreeTextRestarts(d)).toEqual(["cy"]);
  });

  it("restart alone, or tools alone, is left as the question it is", async () => {
    const { d, asked } = harness([
      q("n1", "ana", "Should I restart the dev server?"),
      q("n2", "bo", "Which tools should I use for this?"),
    ]);
    expect(await matchFreeTextRestarts(d)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("only open questions: not settled, read, a permission prompt, or another kind", async () => {
    const { d } = harness([
      q("n1", "ana", "restart me for the new tools", {
        settled: { reason: "x", by: "y", at: "z" },
      }),
      q("n2", "bo", "restart me for the new tools", { read: true }),
      q("n3", "cy", "restart me for the new tools", {
        msg: { key: "bell.m.permission", vars: {} },
      }),
      q("n4", "di", "restart me for the new tools", { kind: "finished" }),
      q("n5", "ed", "restart me for the new tools", { subject: "record:x" }),
    ]);
    expect(await matchFreeTextRestarts(d)).toEqual([]);
  });

  it("no second ask: one waiting, or one Den made from its question before (a denial stays denied)", async () => {
    const a = harness(
      [q("n1", "ana", "restart me for the new tools")],
      ["ana"],
    );
    expect(await matchFreeTextRestarts(a.d)).toEqual([]);
    const b = harness(
      [q("n1", "ana", "restart me for the new tools")],
      [],
      ["ana"],
    );
    expect(await matchFreeTextRestarts(b.d)).toEqual([]);
    expect([...a.asked, ...b.asked]).toEqual([]);
  });

  it("one the check or the queue refuses is skipped, and the rest go on", async () => {
    const a = harness([
      q("n1", "stopped-one", "restart me for the new tools"),
      q("n2", "bo", "restart me for the new tools"),
    ]);
    expect(await matchFreeTextRestarts(a.d)).toEqual(["bo"]);
    const h = harness([
      q("n1", "ana", "restart me for the new tools"),
      q("n2", "bo", "restart me for the new tools"),
    ]);
    const request = h.d.request;
    h.d.request = (r) => {
      if (r.args.agent === "ana") throw new Error("full");
      return request(r);
    };
    expect(await matchFreeTextRestarts(h.d)).toEqual(["bo"]);
  });
});
