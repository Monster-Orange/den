/**
 * Issue 52, the Coach tab's data (mock v2, "Coach tab: what your agents
 * used this week", in Hub): each agent's conversations in the window for
 * the row detail, newest first; how far a run has got, for the Running
 * state; and the last failed run, for the Failed state, with the report
 * before it still shown.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  conversationsFile,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";
import {
  coachBreakdown,
  type CoachReport,
} from "../../../src/shared/coach/breakdown.js";
import { COACH_DEFAULTS } from "../../../src/shared/coach/settings.js";
import {
  handleCoachRoute,
  type CoachRouteDeps,
} from "../../../src/ui/server/coach-routes.js";
import type { UsageSource } from "../../../src/shared/usage/sources.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const state = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-coach-tab-"));
  tmp.push(d);
  return d;
};
const rec = (id: string): AgentRecord =>
  ({
    id,
    workspace: "shop",
    persona: "builder",
    runtime: "den-claude",
    session: { host: "local", id: `s-${id}` },
    sessionName: `shop-${id}`,
    startedAt: iso(NOW - 30 * DAY),
  }) as AgentRecord;
const noSource = (): UsageSource | undefined => undefined;

describe("the row detail: each agent's conversations in the window", () => {
  it("newest first, with when, why and whether backfilled; no ids, none from before the window", async () => {
    const st = state();
    fs.mkdirSync(path.dirname(conversationsFile(st, "a")), { recursive: true });
    fs.writeFileSync(
      conversationsFile(st, "a"),
      JSON.stringify([
        {
          id: "c0",
          from: iso(NOW - 25 * DAY),
          to: iso(NOW - 20 * DAY),
          why: "start",
        },
        {
          id: "c1",
          from: iso(NOW - 20 * DAY),
          to: iso(NOW - 3 * DAY),
          why: "fresh",
          backfilled: true,
        },
        { id: "c2", from: iso(NOW - 3 * DAY), why: "rotation" },
      ]),
    );
    const r = await coachBreakdown([rec("a")], {
      stateDir: st,
      now: NOW,
      days: 7,
      source: noSource,
    });
    expect(r.agents[0].conversations.list).toEqual([
      { from: iso(NOW - 3 * DAY), why: "rotation" },
      {
        from: iso(NOW - 20 * DAY),
        to: iso(NOW - 3 * DAY),
        why: "fresh",
        backfilled: true,
      },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/"c[012]"/);
  });

  it("keeps at most 50", async () => {
    const st = state();
    fs.mkdirSync(path.dirname(conversationsFile(st, "a")), { recursive: true });
    const list = Array.from({ length: 60 }, (_, i) => ({
      id: `c${i}`,
      from: iso(NOW - DAY + i * 1000),
      ...(i < 59 ? { to: iso(NOW - DAY + (i + 1) * 1000) } : {}),
      why: "fresh",
    }));
    fs.writeFileSync(conversationsFile(st, "a"), JSON.stringify(list));
    const r = await coachBreakdown([rec("a")], {
      stateDir: st,
      now: NOW,
      days: 7,
      source: noSource,
    });
    expect(r.agents[0].conversations.list).toHaveLength(50);
    expect(r.agents[0].conversations.inWindow).toBe(60);
  });
});

describe("progress: how many agents a run has read", () => {
  it("is told 0 of n first, then after each agent", async () => {
    const seen: [number, number][] = [];
    await coachBreakdown([rec("a"), rec("b"), rec("c")], {
      stateDir: state(),
      now: NOW,
      days: 7,
      source: noSource,
      progress: (done, total) => void seen.push([done, total]),
    });
    expect(seen).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

describe("GET /api/coach: the Running and Failed states", () => {
  const REPORT = {
    version: 1,
    ranAt: "2026-11-22T12:00:00.000Z",
  } as CoachReport;
  function harness(run: CoachRouteDeps["run"]) {
    const sent: { body: Record<string, unknown>; status: number }[] = [];
    const deps: CoachRouteDeps = {
      sendJson: (_res, body, status = 200) =>
        void sent.push({ body: body as Record<string, unknown>, status }),
      notAPerson: () => false,
      settings: () => ({ ...COACH_DEFAULTS, enabled: true }),
      latest: () => REPORT,
      run,
      audit: () => {},
      findings: () => ({ open: [], dismissed: [] }),
      dismiss: () => ({ ok: true }),
      readBody: async () => "{}",
      now: () => Date.parse("2026-11-22T13:00:00.000Z"),
    };
    const call = (method: string, p: string) =>
      handleCoachRoute({ method } as never, {} as never, p, deps);
    return { sent, call };
  }

  it("while a run goes, GET says how far it has got", async () => {
    let finish!: () => void;
    const h = harness(
      (progress) =>
        new Promise<CoachReport>((ok) => {
          progress?.(4, 6);
          finish = () => ok(REPORT);
        }),
    );
    const running = h.call("POST", "/api/coach/run");
    await h.call("GET", "/api/coach");
    expect(h.sent.at(-1)!.body).toMatchObject({
      running: true,
      progress: { done: 4, total: 6 },
    });
    finish();
    await running;
    await h.call("GET", "/api/coach");
    expect(h.sent.at(-1)!.body).toMatchObject({
      running: false,
      progress: null,
    });
  });

  it("a failed run is kept, with the report before it, until a run succeeds", async () => {
    let fail = true;
    const h = harness(async () => {
      if (fail) throw new Error("file locked");
      return REPORT;
    });
    await h.call("POST", "/api/coach/run");
    await h.call("GET", "/api/coach");
    expect(h.sent.at(-1)!.body).toMatchObject({
      report: REPORT,
      failed: { at: "2026-11-22T13:00:00.000Z", error: "file locked" },
    });
    fail = false;
    await h.call("POST", "/api/coach/run");
    await h.call("GET", "/api/coach");
    expect(h.sent.at(-1)!.body).toMatchObject({ failed: null });
  });
});
