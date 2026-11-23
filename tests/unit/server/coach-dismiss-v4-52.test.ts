/**
 * Issue 52, mock v4 (approved): Dismiss asks for no reason, and a dismissed
 * finding can be taken back (Undo, or Undo in the dismissed list). Both are
 * a person's, audited; a dismissed finding stays dismissed in later runs.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  dismissFinding,
  openFindings,
  readDismissals,
  undismissFinding,
  type CoachFinding,
} from "../../../src/shared/coach/findings.js";
import { COACH_DEFAULTS } from "../../../src/shared/coach/settings.js";
import {
  COACH_ROUTES,
  handleCoachRoute,
  type CoachRouteDeps,
} from "../../../src/ui/server/coach-routes.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const state = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-coach-v4-"));
  tmp.push(d);
  return d;
};
const F = { id: "polling:builder" } as CoachFinding;

describe("findings.ts: Dismiss with no reason, and Undo", () => {
  it("Dismiss needs no reason; one given is still kept", () => {
    const st = state();
    expect(dismissFinding(st, "polling:builder", "", "person", "t1")).toEqual({
      ok: true,
    });
    expect(readDismissals(st)).toEqual([
      { id: "polling:builder", reason: "", by: "person", at: "t1" },
    ]);
    dismissFinding(st, "denials:tester", " by design ", "person", "t2");
    expect(readDismissals(st)[1].reason).toBe("by design");
  });

  it("Undo takes a dismissal back: the finding is open again on later runs", () => {
    const st = state();
    dismissFinding(st, "polling:builder", "", "person");
    expect(openFindings(st, [F])).toEqual([]);
    expect(undismissFinding(st, "polling:builder")).toEqual({ ok: true });
    expect(readDismissals(st)).toEqual([]);
    expect(openFindings(st, [F])).toEqual([F]);
  });

  it("Undo of one that isn't dismissed, or a bad id, says so", () => {
    const st = state();
    expect(undismissFinding(st, "polling:builder")).toMatchObject({
      ok: false,
      code: "not_dismissed",
    });
    expect(undismissFinding(st, "../x")).toMatchObject({
      ok: false,
      code: "bad_id",
    });
  });
});

describe("the routes: Dismiss with no reason, and POST /api/coach/undismiss", () => {
  function harness(st: string, notAPerson = false) {
    const sent: { body: Record<string, unknown>; status: number }[] = [];
    const audit: unknown[] = [];
    let body = "{}";
    const deps: CoachRouteDeps = {
      sendJson: (_r, b, status = 200) =>
        void sent.push({ body: b as Record<string, unknown>, status }),
      notAPerson: () => notAPerson,
      settings: () => ({ ...COACH_DEFAULTS, enabled: true }),
      latest: () => null,
      run: async () => {
        throw new Error("unused");
      },
      audit: (_q, e) => void audit.push(e),
      findings: () => ({ open: [], dismissed: readDismissals(st) }),
      dismiss: (id, reason) => dismissFinding(st, id, reason, "person"),
      undismiss: (id) => undismissFinding(st, id),
      readBody: async () => body,
    };
    const call = (m: string, p: string, b?: unknown) => {
      body = b === undefined ? "{}" : JSON.stringify(b);
      return handleCoachRoute({ method: m } as never, {} as never, p, deps);
    };
    return { sent, audit, call };
  }

  it("lists the new route", () => {
    expect(COACH_ROUTES).toContain("/api/coach/undismiss");
  });

  it("Dismiss with just the id works, and is audited", async () => {
    const st = state();
    const h = harness(st);
    await h.call("POST", "/api/coach/dismiss", { id: "polling:builder" });
    expect(h.sent[0]).toMatchObject({ status: 200, body: { ok: true } });
    expect(readDismissals(st).map((d) => d.id)).toEqual(["polling:builder"]);
    expect(h.audit).toEqual([
      {
        verb: "coach-dismiss",
        detail: "Coach finding polling:builder dismissed",
      },
    ]);
  });

  it("Undo takes it back, audited; a second Undo is a 404", async () => {
    const st = state();
    const h = harness(st);
    await h.call("POST", "/api/coach/dismiss", { id: "polling:builder" });
    await h.call("POST", "/api/coach/undismiss", { id: "polling:builder" });
    expect(h.sent[1]).toMatchObject({ status: 200, body: { ok: true } });
    expect(readDismissals(st)).toEqual([]);
    expect(h.audit[1]).toEqual({
      verb: "coach-undismiss",
      detail: "Coach finding polling:builder dismissal taken back",
    });
    await h.call("POST", "/api/coach/undismiss", { id: "polling:builder" });
    expect(h.sent[2]).toMatchObject({
      status: 404,
      body: { code: "not_dismissed" },
    });
  });

  it("Undo is a person's: an agent is refused and audited; a bad body is a 400; GET is a 405", async () => {
    const st = state();
    dismissFinding(st, "polling:builder", "", "person");
    const a = harness(st, true);
    await a.call("POST", "/api/coach/undismiss", { id: "polling:builder" });
    expect(a.sent[0]).toMatchObject({
      status: 403,
      body: { code: "person_only" },
    });
    expect(a.audit).toEqual([
      {
        verb: "coach-undismiss",
        detail: "Coach undismiss refused",
        outcome: "refused",
        reason: "person_only",
      },
    ]);
    expect(readDismissals(st)).toHaveLength(1);
    const h = harness(st);
    await h.call("POST", "/api/coach/undismiss", { id: 5 });
    expect(h.sent[0]).toMatchObject({
      status: 400,
      body: { code: "bad_body" },
    });
    await h.call("GET", "/api/coach/undismiss");
    expect(h.sent[1].status).toBe(405);
  });
});
