/**
 * Issue 476: the review legs Den has started. A leg is one fresh reviewer
 * session for one PR at one head. Its findings come back through the
 * review_submit tool, and Den accepts them only from the agent it started
 * for that leg (proven by the agent's actor token, never a header), for
 * that repo, PR and head, before the leg's time runs out, and only once.
 * A refusal names why, for the audit trail, and doesn't use the leg up.
 */
import { randomBytes } from "crypto";

export interface LegSpec {
  /** The Den agent id started for this leg. */
  agent: string;
  repo: string;
  pr: number;
  /** The head commit the leg reviews. */
  sha: string;
}

export interface Leg extends LegSpec {
  id: string;
}

export type LegRefusal =
  | "unverified_actor"
  | "unknown_leg"
  | "wrong_agent"
  | "wrong_pr"
  | "wrong_head"
  | "expired"
  | "already_submitted";

interface Held extends Leg {
  expiresAt: number;
  used: boolean;
}

export class ReviewLegs {
  private legs = new Map<string, Held>();

  /** Opens a leg for `minutes`; its id is the review_submit `leg`. */
  open(spec: LegSpec, now: number, minutes: number): string {
    const id = randomBytes(16).toString("hex");
    this.legs.set(id, {
      ...spec,
      id,
      expiresAt: now + minutes * 60_000,
      used: false,
    });
    return id;
  }

  get(id: string): Leg | undefined {
    const h = this.legs.get(id);
    return h ? strip(h) : undefined;
  }

  /** Drops a leg (the head moved, or the review ended). */
  close(id: string): void {
    this.legs.delete(id);
  }

  accept(
    who: { agent: string | undefined; verified: boolean },
    sub: { leg: string; repo: string; pr: number; sha: string },
    now: number,
  ): { ok: true; leg: Leg } | { ok: false; why: LegRefusal } {
    if (!who.verified || !who.agent)
      return { ok: false, why: "unverified_actor" };
    const h = this.legs.get(sub.leg);
    if (!h) return { ok: false, why: "unknown_leg" };
    if (h.agent !== who.agent) return { ok: false, why: "wrong_agent" };
    if (h.repo !== sub.repo || h.pr !== sub.pr)
      return { ok: false, why: "wrong_pr" };
    if (h.sha !== sub.sha) return { ok: false, why: "wrong_head" };
    if (now > h.expiresAt) return { ok: false, why: "expired" };
    if (h.used) return { ok: false, why: "already_submitted" };
    h.used = true;
    return { ok: true, leg: strip(h) };
  }
}

function strip(h: Held): Leg {
  return { id: h.id, agent: h.agent, repo: h.repo, pr: h.pr, sha: h.sha };
}
