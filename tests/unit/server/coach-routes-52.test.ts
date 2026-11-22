/**
 * Issue 52: the Coach's routes, for the platform agent's Coach tab.
 *
 *   GET  /api/coach      its settings and the last report (null: none yet)
 *   POST /api/coach/run  Run now: a person only, the Coach on, one at a time
 *
 * The request guard has already checked the sign-in, Origin and CSRF; these
 * add the person-only and the Coach-on checks, and audit each run.
 */
import { describe, expect, it } from "@jest/globals";
import { COACH_DEFAULTS } from "../../../src/shared/coach/settings.js";
import type { CoachReport } from "../../../src/shared/coach/breakdown.js";
import {
  COACH_ROUTES,
  handleCoachRoute,
  type CoachRouteDeps,
} from "../../../src/ui/server/coach-routes.js";

const REPORT = { version: 1, ranAt: "2026-11-22T12:00:00.000Z" } as CoachReport;

function harness(over: Partial<CoachRouteDeps> = {}) {
  const sent: { body: unknown; status: number }[] = [];
  const audit: unknown[] = [];
  let runs = 0;
  let saved: CoachReport | null = null;
  const deps: CoachRouteDeps = {
    sendJson: (_res, body, status = 200) => void sent.push({ body, status }),
    notAPerson: () => false,
    settings: () => ({ ...COACH_DEFAULTS, enabled: true }),
    latest: () => saved,
    run: async () => {
      runs++;
      saved = REPORT;
      return REPORT;
    },
    audit: (_req, e) => void audit.push(e),
    findings: (r) => ({
      open: (r?.findings ?? []).filter((f) => !dismissed.has(f.id)),
      dismissed: [...dismissed].map((id) => ({
        id,
        reason: "r",
        by: "person",
        at: "t",
      })),
    }),
    dismiss: (id, reason) => {
      if (!reason.trim())
        return { ok: false, code: "reason_required", error: "Say why." };
      dismissed.add(id);
      return { ok: true };
    },
    readBody: async () => body,
    ...over,
  };
  const dismissed = new Set<string>();
  let body = "{}";
  const call = (method: string, pathname: string, b?: unknown) => {
    body =
      b === undefined ? "{}" : typeof b === "string" ? b : JSON.stringify(b);
    return handleCoachRoute({ method } as never, {} as never, pathname, deps);
  };
  return { sent, audit, call, runs: () => runs };
}

describe("the Coach's routes", () => {
  it("are the two paths, and nothing else is handled", async () => {
    expect(COACH_ROUTES).toEqual([
      "/api/coach",
      "/api/coach/run",
      "/api/coach/dismiss",
    ]);
    const h = harness();
    expect(await h.call("GET", "/api/coaches")).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it("GET gives the settings and the last report (none yet: null)", async () => {
    const h = harness();
    expect(await h.call("GET", "/api/coach")).toBe(true);
    expect(h.sent[0]).toEqual({
      status: 200,
      body: {
        ok: true,
        settings: { ...COACH_DEFAULTS, enabled: true },
        report: null,
        running: false,
        progress: null,
        failed: null,
        findings: [],
        dismissed: [],
      },
    });
  });

  it("Run now runs, saves, audits as the person's, and returns the report", async () => {
    const h = harness();
    await h.call("POST", "/api/coach/run");
    expect(h.runs()).toBe(1);
    expect(h.sent[0]).toEqual({
      status: 200,
      body: { ok: true, report: REPORT },
    });
    expect(h.audit).toEqual([
      { verb: "coach-run", detail: "Coach run (read-only)" },
    ]);
    await h.call("GET", "/api/coach");
    expect((h.sent[1].body as { report: unknown }).report).toEqual(REPORT);
  });

  it("Run now from an agent (or the fixture person) is refused and audited", async () => {
    const h = harness({ notAPerson: () => true });
    await h.call("POST", "/api/coach/run");
    expect(h.runs()).toBe(0);
    expect(h.sent[0].status).toBe(403);
    expect(h.sent[0].body).toMatchObject({ ok: false, code: "person_only" });
    expect(h.audit).toEqual([
      {
        verb: "coach-run",
        detail: "Coach run refused",
        outcome: "refused",
        reason: "person_only",
      },
    ]);
  });

  it("Run now while the Coach is off is refused, saying how to turn it on", async () => {
    const h = harness({ settings: () => ({ ...COACH_DEFAULTS }) });
    await h.call("POST", "/api/coach/run");
    expect(h.runs()).toBe(0);
    expect(h.sent[0].status).toBe(409);
    expect(h.sent[0].body).toMatchObject({ ok: false, code: "coach_off" });
    expect((h.sent[0].body as { error: string }).error).toMatch(
      /agents\.coach\.enabled/,
    );
  });

  it("a second Run now while one runs is refused; the first finishes", async () => {
    let release: () => void = () => {};
    const h = harness({
      run: () =>
        new Promise<CoachReport>((r) => {
          release = () => r(REPORT);
        }),
    });
    const first = h.call("POST", "/api/coach/run");
    await Promise.resolve();
    await h.call("POST", "/api/coach/run");
    expect(h.sent[0]).toMatchObject({
      status: 409,
      body: { code: "already_running" },
    });
    await h.call("GET", "/api/coach");
    expect((h.sent[1].body as { running: boolean }).running).toBe(true);
    release();
    await first;
    expect(h.sent[2]).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("a run that fails says so, and the next can start", async () => {
    let fail = true;
    const h = harness({
      run: async () => {
        if (fail) throw new Error("disk gone");
        return REPORT;
      },
    });
    await h.call("POST", "/api/coach/run");
    expect(h.sent[0]).toMatchObject({
      status: 500,
      body: { ok: false, code: "run_failed" },
    });
    fail = false;
    await h.call("POST", "/api/coach/run");
    expect(h.sent[1]).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("GET lists the open findings and the dismissed ones", async () => {
    const f = { id: "polling:builder", kind: "polling", agent: "builder" };
    const h = harness({
      latest: () => ({ ...REPORT, findings: [f] }) as unknown as CoachReport,
    });
    await h.call("POST", "/api/coach/dismiss", {
      id: "polling:builder",
      reason: "by design",
    });
    await h.call("GET", "/api/coach");
    expect(h.sent[1].body).toMatchObject({
      findings: [],
      dismissed: [{ id: "polling:builder" }],
    });
  });

  it("Dismiss records the person's reason and audits it", async () => {
    const h = harness();
    await h.call("POST", "/api/coach/dismiss", {
      id: "polling:builder",
      reason: "It waits on CI.",
    });
    expect(h.sent[0]).toEqual({ status: 200, body: { ok: true } });
    expect(h.audit).toEqual([
      {
        verb: "coach-dismiss",
        detail: "Coach finding polling:builder dismissed: It waits on CI.",
      },
    ]);
  });

  it("Dismiss with no reason, a bad body or from an agent is refused", async () => {
    const h = harness();
    await h.call("POST", "/api/coach/dismiss", {
      id: "polling:builder",
      reason: " ",
    });
    await h.call("POST", "/api/coach/dismiss", "not json");
    await h.call("POST", "/api/coach/dismiss", { id: 5, reason: "x" });
    expect(h.sent.map((s) => s.status)).toEqual([400, 400, 400]);
    expect(h.sent[0].body).toMatchObject({ code: "reason_required" });
    const a = harness({ notAPerson: () => true });
    await a.call("POST", "/api/coach/dismiss", {
      id: "polling:builder",
      reason: "x",
    });
    expect(a.sent[0]).toMatchObject({
      status: 403,
      body: { code: "person_only" },
    });
    expect(a.audit).toEqual([
      {
        verb: "coach-dismiss",
        detail: "Coach dismiss refused",
        outcome: "refused",
        reason: "person_only",
      },
    ]);
  });

  it("the wrong method is a 405 naming the right one", async () => {
    const h = harness();
    await h.call("POST", "/api/coach");
    await h.call("GET", "/api/coach/run");
    await h.call("GET", "/api/coach/dismiss");
    expect(h.sent.map((s) => s.status)).toEqual([405, 405, 405]);
  });
});
