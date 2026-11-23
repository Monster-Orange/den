/**
 * Issue 110, Coach Apply (mock v3, in Hub, Den project): the bell's card.
 *   - Apply's held write carries a Coach block Den builds from the stored
 *     finding (kind, persona, the finding's numbers), never from a request;
 *   - the queue keeps a checked copy, and Needs you passes it on;
 *   - the bell draws one card: who asks, the finding it came from, Change,
 *     Why, whether it is reversible, then Allow and Deny.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  handleCoachApplyRoute,
  type CoachApplyDeps,
} from "../../../src/ui/server/coach-apply-routes.js";
import { coachAskOf } from "../../../src/ui/server/approvals.js";
import { heldWaiting } from "../../../src/ui/server/held-bell.js";
import type { CoachFinding } from "../../../src/shared/coach/findings.js";

const g = globalThis as unknown as { window?: unknown };
const had = g.window;
beforeAll(() => {
  g.window = {
    denShell: {
      t: (k: string, v?: Record<string, unknown>) =>
        `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`,
    },
  };
});
afterAll(() => {
  g.window = had;
});

const OPUS: CoachFinding = {
  id: "subagent_opus:builder",
  kind: "subagent_opus",
  agent: "builder",
  workspace: "shop",
  title: "t",
  evidence: { subagent_opus_pct: 87, subagent_calls: 140 },
  proposal: "p",
  window: {
    from: "2026-11-15T12:00:00.000Z",
    to: "2026-11-22T12:00:00.000Z",
    days: 7,
  },
  persona: "builder",
};

describe("Apply's held write carries the Coach block", () => {
  it("built from the stored finding and the setting's line", async () => {
    const asked: unknown[] = [];
    const d: CoachApplyDeps = {
      sendJson: () => undefined,
      notAPerson: () => false,
      readBody: () => Promise.resolve('{"id":"subagent_opus:builder"}'),
      audit: () => undefined,
      openFindings: () => [OPUS],
      linkOf: () => null,
      stateOf: () => "waiting",
      ask: (_req, _b, o) => {
        asked.push(o);
        return Promise.resolve({ status: 202, body: { ok: true, id: "a1" } });
      },
      link: () => undefined,
      lineOf: (kind) => (kind === "subagent_opus" ? 50 : undefined),
    };
    await handleCoachApplyRoute(
      { method: "POST" } as http.IncomingMessage,
      { setHeader: () => undefined } as unknown as http.ServerResponse,
      "/api/coach/apply",
      d,
    );
    expect(asked).toEqual([
      {
        coach: {
          finding: "subagent_opus:builder",
          kind: "subagent_opus",
          persona: "builder",
          vars: { agent: "builder", n: 87, calls: 140, line: 50 },
        },
      },
    ]);
  });

  it("the queue keeps only a checked copy", () => {
    expect(
      coachAskOf({
        finding: "subagent_opus:builder",
        kind: "subagent_opus",
        persona: "builder",
        vars: { agent: "builder", n: 87, bad: { x: 1 }, long: "y".repeat(500) },
      }),
    ).toEqual({
      finding: "subagent_opus:builder",
      kind: "subagent_opus",
      persona: "builder",
      vars: { agent: "builder", n: 87, long: "y".repeat(128) },
    });
    expect(coachAskOf({ kind: "Bad Kind", persona: "b", finding: "x" })).toBe(
      undefined,
    );
    expect(coachAskOf(null)).toBe(undefined);
  });

  it("Needs you passes it on", () => {
    const coach = coachAskOf({
      finding: "subagent_opus:builder",
      kind: "subagent_opus",
      persona: "builder",
      vars: { agent: "builder" },
    })!;
    const [w] = heldWaiting([
      {
        id: "a1",
        actor: "person:local",
        action: "persona_update",
        args: {},
        summary: "s",
        requestedAt: 1,
        expiresAt: 2,
        state: "pending",
        coach,
      },
    ]);
    expect(w.coach).toEqual(coach);
  });
});

describe("the bell's Coach card (mock v3)", () => {
  const w = {
    kind: "allow",
    id: "aaaaaaaaaaaaaaaa",
    action: "persona_update",
    what: "s",
    since: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    coach: {
      finding: "subagent_opus:builder",
      kind: "subagent_opus",
      persona: "<b>builder</b>",
      vars: { agent: "<b>builder</b>", n: 87, calls: 140, line: 50 },
    },
  };
  it("who asks, the finding, Change, Why, Reversible, then Allow and Deny", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const needs: string = bellPanel({ groups: [], waiting: [w], unread: 1 })
      .sections.needs;
    const order = [
      "[bell.coach.asks:",
      "[bell.coach.from:[co.f.subagent_opus.t:",
      "[bell.coach.change]",
      "[co.ap.change.subagent_opus:",
      "[bell.coach.why]",
      "[co.f.subagent_opus.why:",
      "[bell.coach.rev]",
      "[co.ap.rev.subagent_opus:",
      'data-bell="allow"',
      'data-bell="deny"',
    ].map((s) => needs.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(needs).toContain(
      'class="den-bell-row den-bell-allow den-bell-coach"',
    );
    expect(needs).not.toContain("<b>builder</b>");
  });
});
