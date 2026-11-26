import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
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

function harness(rows: Notification[], pendingFor: string[] = []) {
  const asked: Asked[] = [];
  const settled: { id: string; by: string; key: string }[] = [];
  const d: FreeTextRestartDeps = {
    rows: () => rows,
    pending: () =>
      pendingFor.map((id) => ({
        action: "agent_restart_self",
        args: { agent: id },
      })),
    check: (a, who): RestartSelfCheck => ({
      ok: true,
      summary: `restart ${String(who?.agent)} when idle`,
      params: { agent: String(who?.agent), reason: String(a.reason) },
      details: [],
      detailKeys: [],
      args: { agent: String(who?.agent), project: "north", reason: "tools" },
    }),
    request: (r) => {
      asked.push(r);
      return { id: `ap-${String(r.agent)}` };
    },
    settle: (id, s, say) => {
      settled.push({ id, by: s.by, key: String(say.msg.key) });
    },
  };
  return { d, asked, settled };
}

describe("issue 1406, clause 3: free-text restart asks already waiting join the card", () => {
  it("a question that says restart and tools becomes the agent's own structured ask", async () => {
    const { d, asked, settled } = harness([
      q("n1", "ana", "Please restart me so I get the new Hub tools."),
      q("n2", "bo", "Could you Restart this session? The tool list changed."),
    ]);
    expect(await matchFreeTextRestarts(d)).toEqual(["ana", "bo"]);
    expect(
      asked.map((a) => [a.actor, a.agent, a.action, a.args.reason]),
    ).toEqual([
      ["agent:ana", "ana", "agent_restart_self", "tools"],
      ["agent:bo", "bo", "agent_restart_self", "tools"],
    ]);
    expect(settled).toEqual([
      { id: "n1", by: "den", key: "bell.m.rsMatched" },
      { id: "n2", by: "den", key: "bell.m.rsMatched" },
    ]);
  });

  it("Japanese words for restart and tools match too", async () => {
    const { d } = harness([
      q("n1", "cy", "新しいツールを使うために再起動してください"),
    ]);
    expect(await matchFreeTextRestarts(d)).toEqual(["cy"]);
  });

  it("restart alone, or tools alone, is left as the question it is", async () => {
    const { d, asked, settled } = harness([
      q("n1", "ana", "Should I restart the dev server?"),
      q("n2", "bo", "Which tools should I use for this?"),
    ]);
    expect(await matchFreeTextRestarts(d)).toEqual([]);
    expect(asked).toEqual([]);
    expect(settled).toEqual([]);
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

  it("an agent with a structured ask waiting keeps its question; no second ask", async () => {
    const { d, asked, settled } = harness(
      [q("n1", "ana", "restart me for the new tools")],
      ["ana"],
    );
    expect(await matchFreeTextRestarts(d)).toEqual([]);
    expect(asked).toEqual([]);
    expect(settled).toEqual([]);
  });

  it("one the check or the queue refuses keeps its question, and the rest go on", async () => {
    const { d, asked, settled } = harness([
      q("n1", "ana", "restart me for the new tools"),
      q("n2", "bo", "restart me for the new tools"),
    ]);
    const check = d.check;
    d.check = (a, who) =>
      who?.agent === "ana" ? { ok: false, error: "stopped" } : check(a, who);
    expect(await matchFreeTextRestarts(d)).toEqual(["bo"]);
    expect(settled.map((s) => s.id)).toEqual(["n2"]);
    const h = harness([
      q("n1", "ana", "restart me for the new tools"),
      q("n2", "bo", "restart me for the new tools"),
    ]);
    const request = h.d.request;
    h.d.request = (r) => {
      if (r.agent === "ana") throw new Error("full");
      return request(r);
    };
    expect(await matchFreeTextRestarts(h.d)).toEqual(["bo"]);
    expect(h.settled.map((s) => s.id)).toEqual(["n2"]);
    expect(asked.length + h.asked.length).toBe(2);
  });

  it("its bell line is in en, es and ja", () => {
    const root = path.join(__dirname, "../../../src/ui/server/public");
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"])
      expect([
        f,
        fs
          .readFileSync(path.join(root, f), "utf-8")
          .includes('"bell.m.rsMatched"'),
      ]).toEqual([f, true]);
  });
});
