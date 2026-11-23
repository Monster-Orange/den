/**
 * Issue 110, Coach Apply slice 2: POST /api/coach/apply { id }.
 *   - a person's only: an agent's token, a claimed agent or the fixture
 *     person is refused, and the refusal is audited;
 *   - the held write comes from the stored finding's proposal, never from
 *     the request: a body's action or args are refused;
 *   - it asks through the held-write path (askHeld) and keeps the link;
 *     nothing changes until a person allows it;
 *   - a finding whose Apply is waiting can't be applied again;
 *   - a finding with no proposal, or none of that id, is refused.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  COACH_APPLY_ROUTES,
  handleCoachApplyRoute,
  type CoachApplyDeps,
} from "../../../src/ui/server/coach-apply-routes.js";
import type { CoachFinding } from "../../../src/shared/coach/findings.js";

const W = {
  from: "2026-11-15T12:00:00.000Z",
  to: "2026-11-22T12:00:00.000Z",
  days: 7,
};
const OPUS: CoachFinding = {
  id: "subagent_opus:builder",
  kind: "subagent_opus",
  agent: "builder",
  workspace: "shop",
  title: "builder (shop) ran 87% of its subagent calls on Opus.",
  evidence: { subagent_opus_pct: 87, subagent_calls: 140 },
  proposal: "Set its persona's subagent_model to Sonnet.",
  window: W,
  persona: "builder",
  apply: {
    action: "persona_update",
    args: { id: "builder", project: "shop", subagentModel: "sonnet" },
    change: "Set builder's subagent model to Sonnet.",
    reversible: "Set it back in builder's persona.",
  },
};
const POLL: CoachFinding = {
  ...OPUS,
  id: "polling:builder",
  kind: "polling",
  apply: undefined,
};

function harness(over: Partial<CoachApplyDeps> = {}) {
  const sent: { status: number; body: Record<string, unknown> }[] = [];
  const audits: { verb: string; detail: string; outcome?: string }[] = [];
  const asked: { action: string; args: unknown; note?: unknown }[] = [];
  const links: Record<string, { approval: string; at: string }> = {};
  const states: Record<string, string> = {};
  let body = "{}";
  const d: CoachApplyDeps = {
    sendJson: (_res, b, status = 200) =>
      void sent.push({ status, body: b as Record<string, unknown> }),
    notAPerson: () => false,
    readBody: () => Promise.resolve(body),
    audit: (_req, e) => void audits.push(e),
    openFindings: () => [OPUS, POLL],
    linkOf: (id) => links[id] ?? null,
    stateOf: (approval) => (states[approval] ?? "failed") as never,
    ask: (_req, b) => {
      asked.push(b as never);
      const id = `a${asked.length}`;
      states[id] = "waiting";
      return Promise.resolve({ status: 202, body: { ok: true, id } });
    },
    link: (id, approval, at) => void (links[id] = { approval, at }),
    now: () => Date.parse("2026-11-22T18:00:00.000Z"),
    ...over,
  };
  const call = async (method: string, b: unknown) => {
    body = JSON.stringify(b);
    const req = { method } as http.IncomingMessage;
    const res = {
      setHeader: () => undefined,
    } as unknown as http.ServerResponse;
    const handled = await handleCoachApplyRoute(
      req,
      res,
      "/api/coach/apply",
      d,
    );
    return { handled, last: sent.at(-1)! };
  };
  return { call, sent, audits, asked, links, states, d };
}

describe("POST /api/coach/apply", () => {
  it("is the only route it adds", () => {
    expect(COACH_APPLY_ROUTES).toEqual(["/api/coach/apply"]);
  });

  it("asks for the stored proposal as a held write, keeps the link, and is audited", async () => {
    const h = harness();
    const { last } = await h.call("POST", { id: "subagent_opus:builder" });
    expect(last.status).toBe(202);
    expect(last.body).toMatchObject({
      ok: true,
      approval: "a1",
      state: "waiting",
    });
    expect(h.asked).toEqual([
      {
        action: "persona_update",
        args: { id: "builder", project: "shop", subagentModel: "sonnet" },
        note: "Coach: Set builder's subagent model to Sonnet.",
      },
    ]);
    expect(h.links["subagent_opus:builder"]).toEqual({
      approval: "a1",
      at: "2026-11-22T18:00:00.000Z",
    });
    expect(h.audits).toEqual([
      {
        verb: "coach-apply",
        detail:
          "Coach finding subagent_opus:builder: Apply asked for a held write [a1]",
      },
    ]);
  });

  it("a person's only: an agent is refused, audited, and nothing is asked", async () => {
    const h = harness({ notAPerson: () => true });
    const { last } = await h.call("POST", { id: "subagent_opus:builder" });
    expect([last.status, last.body.code]).toEqual([403, "person_only"]);
    expect(h.asked).toEqual([]);
    expect(h.audits).toMatchObject([
      { verb: "coach-apply", outcome: "refused" },
    ]);
  });

  it("never takes the held write from the request", async () => {
    const h = harness();
    const { last } = await h.call("POST", {
      id: "subagent_opus:builder",
      action: "agent_mode",
      args: { mode: "bypass" },
    });
    expect([last.status, last.body.code]).toEqual([400, "bad_body"]);
    expect(h.asked).toEqual([]);
  });

  it("a waiting Apply can't be asked again; once ended, it can", async () => {
    const h = harness();
    await h.call("POST", { id: "subagent_opus:builder" });
    const again = await h.call("POST", { id: "subagent_opus:builder" });
    expect([again.last.status, again.last.body.code]).toEqual([
      409,
      "apply_waiting",
    ]);
    expect(h.asked).toHaveLength(1);
    h.states.a1 = "denied";
    const later = await h.call("POST", { id: "subagent_opus:builder" });
    expect(later.last.status).toBe(202);
    expect(h.asked).toHaveLength(2);
  });

  it("never trusts a stored apply: a rewritten report's action or note isn't asked", async () => {
    // Reviewer B: agents can write the state folder, so coach/latest.json
    // may carry any apply. The route rebuilds it from the finding's kind.
    const forged: CoachFinding = {
      ...OPUS,
      apply: {
        action: "den_update" as never,
        args: { version: "9.9.9" },
        change: "Allow this, it is safe.",
        reversible: "Yes.",
      },
    };
    const h = harness({ openFindings: () => [forged] });
    const r = await h.call("POST", { id: "subagent_opus:builder" });
    expect(r.last.status).toBe(202);
    expect(h.asked).toEqual([
      {
        action: "persona_update",
        args: { id: "builder", project: "shop", subagentModel: "sonnet" },
        note: "Coach: Set builder's subagent model to Sonnet.",
      },
    ]);
    const other = harness({
      openFindings: () => [
        { ...forged, id: "polling:builder", kind: "polling" },
      ],
    });
    const p = await other.call("POST", { id: "polling:builder" });
    expect([p.last.status, p.last.body.code]).toEqual([404, "no_apply"]);
    expect(other.asked).toEqual([]);
  });

  it("a persona or project name that isn't a plain name: no_apply", async () => {
    for (const bad of [
      { persona: "../etc", workspace: "shop" },
      { persona: "builder", workspace: "shop\nx" },
      { persona: "", workspace: "shop" },
    ]) {
      const h = harness({ openFindings: () => [{ ...OPUS, ...bad }] });
      const r = await h.call("POST", { id: "subagent_opus:builder" });
      expect([r.last.status, r.last.body.code]).toEqual([404, "no_apply"]);
      expect(h.asked).toEqual([]);
    }
  });

  it("a project Den doesn't have isn't named in the held write", async () => {
    const h = harness({ projectExists: () => false });
    await h.call("POST", { id: "subagent_opus:builder" });
    expect(h.asked[0]?.args).toEqual({
      id: "builder",
      subagentModel: "sonnet",
    });
  });

  it("two Applies at once ask for one held write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness();
    const ask = h.d.ask;
    h.d.ask = async (req, b) => {
      await gate;
      return ask(req, b);
    };
    const one = h.call("POST", { id: "subagent_opus:builder" });
    const two = h.call("POST", { id: "subagent_opus:builder" });
    release();
    const [a, b] = await Promise.all([one, two]);
    expect([a.last.status, b.last.status].sort()).toEqual([202, 409]);
    expect(h.asked).toHaveLength(1);
  });

  it("no such open finding, or one with no proposal: 404, nothing asked", async () => {
    const h = harness();
    const none = await h.call("POST", { id: "subagent_opus:ghost" });
    expect([none.last.status, none.last.body.code]).toEqual([404, "not_found"]);
    const noApply = await h.call("POST", { id: "polling:builder" });
    expect([noApply.last.status, noApply.last.body.code]).toEqual([
      404,
      "no_apply",
    ]);
    expect(h.asked).toEqual([]);
  });

  it("a held write refused: its answer goes back, and no link is kept", async () => {
    const h = harness({
      ask: () =>
        Promise.resolve({
          status: 400,
          body: { ok: false, code: "invalid_args", error: "no such persona" },
        }),
    });
    const { last } = await h.call("POST", { id: "subagent_opus:builder" });
    expect([last.status, last.body.code]).toEqual([400, "invalid_args"]);
    expect(h.links).toEqual({});
  });

  it("a bad body, or another method", async () => {
    const h = harness();
    for (const b of [{}, { id: 5 }, { id: "x".repeat(201) }, []]) {
      const { last } = await h.call("POST", b);
      expect([last.status, last.body.code]).toEqual([400, "bad_body"]);
    }
    const get = await h.call("GET", {});
    expect(get.last.status).toBe(405);
  });
});
