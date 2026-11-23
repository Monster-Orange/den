/**
 * Issue 476: a review leg's findings come back through review_submit. Den
 * accepts them only from the agent it started for that leg, for that PR
 * and head, proven by the agent's actor token, and only once. Anything
 * else is refused with a reason the caller writes to the audit trail.
 */
import { describe, expect, it } from "@jest/globals";
import { ReviewLegs } from "../../../src/shared/review/mesh/legs.js";

const now = Date.parse("2026-11-22T18:00:00Z");
const leg = {
  agent: "rev-7f3a",
  repo: "octo/app",
  pr: 12,
  sha: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
};
const who = (agent: string, verified = true) => ({ agent, verified });

describe("review legs", () => {
  it("the agent Den started, for that PR and head, may submit once", () => {
    const legs = new ReviewLegs();
    const id = legs.open(leg, now, 60);
    expect(
      legs.accept(
        who("rev-7f3a"),
        { leg: id, repo: "octo/app", pr: 12, sha: leg.sha },
        now + 1000,
      ),
    ).toEqual({ ok: true, leg: { id, ...leg } });
    expect(
      legs.accept(
        who("rev-7f3a"),
        { leg: id, repo: "octo/app", pr: 12, sha: leg.sha },
        now + 2000,
      ),
    ).toEqual({ ok: false, why: "already_submitted" });
  });

  it("anyone else, or the wrong PR, head or leg, is refused with the reason", () => {
    const legs = new ReviewLegs();
    const id = legs.open(leg, now, 60);
    const sub = { leg: id, repo: "octo/app", pr: 12, sha: leg.sha };
    expect(legs.accept(who("rev-7f3a", false), sub, now)).toEqual({
      ok: false,
      why: "unverified_actor",
    });
    expect(legs.accept(who("author-1"), sub, now)).toEqual({
      ok: false,
      why: "wrong_agent",
    });
    expect(legs.accept(who("rev-7f3a"), { ...sub, pr: 13 }, now)).toEqual({
      ok: false,
      why: "wrong_pr",
    });
    expect(
      legs.accept(who("rev-7f3a"), { ...sub, repo: "octo/x" }, now),
    ).toEqual({
      ok: false,
      why: "wrong_pr",
    });
    expect(
      legs.accept(who("rev-7f3a"), { ...sub, sha: "0".repeat(40) }, now),
    ).toEqual({ ok: false, why: "wrong_head" });
    expect(legs.accept(who("rev-7f3a"), { ...sub, leg: "nope" }, now)).toEqual({
      ok: false,
      why: "unknown_leg",
    });
    // None of the refusals used the leg up.
    expect(legs.accept(who("rev-7f3a"), sub, now).ok).toBe(true);
  });

  it("a leg past its time is refused", () => {
    const legs = new ReviewLegs();
    const id = legs.open(leg, now, 60);
    expect(
      legs.accept(
        who("rev-7f3a"),
        { leg: id, repo: "octo/app", pr: 12, sha: leg.sha },
        now + 61 * 60_000,
      ),
    ).toEqual({ ok: false, why: "expired" });
  });

  it("leg ids can't be guessed from each other", () => {
    const legs = new ReviewLegs();
    const a = legs.open(leg, now, 60);
    const b = legs.open(leg, now, 60);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });

  it("a leg opened before its agent exists takes no submission until bound, once", () => {
    const legs = new ReviewLegs();
    const id = legs.open({ ...leg, agent: "" }, now, 60);
    const sub = { leg: id, repo: "octo/app", pr: 12, sha: leg.sha };
    expect(legs.accept(who(""), sub, now)).toEqual({
      ok: false,
      why: "unverified_actor",
    });
    expect(legs.accept(who("rev-7f3a"), sub, now)).toEqual({
      ok: false,
      why: "wrong_agent",
    });
    legs.bind(id, "rev-7f3a");
    expect(() => legs.bind(id, "someone-else")).toThrow();
    expect(legs.accept(who("rev-7f3a"), sub, now).ok).toBe(true);
  });
});
