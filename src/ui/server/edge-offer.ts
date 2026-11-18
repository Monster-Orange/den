/**
 * Issue 395: the held edge_up, and Den offering it by itself.
 *
 *   edgeUpHeld      the held write edge_up (approval-routes.ts): Den's own
 *                   agent or a person asks; a project's agent can't (the
 *                   edge is every project's). Its run is applyEdgeConfig,
 *                   the path Settings' Start the edge runs too, and its
 *                   answer carries edge_status (image, version, recreated
 *                   or not, and why).
 *   createEdgeOffer when a config change (a merge, an edit) moves
 *                   edge.image or edge.args away from the edge that runs,
 *                   Den holds an edge_up for the person without being
 *                   asked: "the edge runs X; the config says Y". Once per
 *                   change: the same config offers nothing more, and a
 *                   request still waiting is never doubled.
 */
import type { EdgeApplied, EdgeDrift } from "../../shared/edge/apply.js";
import type { EdgeConfig } from "../../shared/edge/types.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import type { HeldAction, HeldCheck } from "./approval-routes.js";
import type { Approval, ApprovalQueue } from "./approvals.js";

export interface EdgeUpHeldDeps {
  /** The config's edge.image (throws with no edge block). */
  image: () => string;
  /** What the running edge and the config disagree on, or null. */
  drift: () => EdgeDrift | null;
  /** applyEdgeConfig: what `edge up` runs (tests pass a fake). */
  apply: () => Promise<EdgeApplied>;
}

/** Who Den's own offer is from. */
export const EDGE_OFFER_ACTOR = "den:edge-config";

/** How long Den's own offer waits for the person. */
export const EDGE_OFFER_TTL_MS = 24 * 60 * 60_000;

export function edgeUpHeld(d: EdgeUpHeldDeps | undefined): HeldAction {
  return {
    check(_a, who): HeldCheck {
      if (!d) return { ok: false, error: "this Den can't start its edge here" };
      if (who?.project && !isServerScope(who.project))
        return {
          ok: false,
          error: `the edge is every project's: Den's own agent or a person asks to recreate it, not ${who.agent ?? "a project's agent"}`,
        };
      let image: string;
      try {
        image = d.image();
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      let drift: EdgeDrift | null = null;
      try {
        drift = d.drift();
      } catch {
        drift = null; // no docker here: edge up says why when it runs
      }
      return {
        ok: true,
        args: {},
        summary: drift
          ? `recreate the edge: ${drift.line}`
          : `start the edge, or apply the config to it (${image})`,
        params: { image },
        details: [
          ...(drift ? [`Now ${drift.line}.`] : []),
          `Den runs what edge up runs: the edge on the config's image (${image}) and args, then the running stacks rejoin its networks.`,
          "When the edge must be recreated, its routes drop for a few seconds while it restarts. Once it is done, Den says whether it was recreated, and why.",
        ],
        detailKeys: [
          ...(drift
            ? [
                {
                  key: "ap.det.edge_up.drift",
                  vars: { runs: drift.runs, says: drift.says },
                },
              ]
            : []),
          { key: "ap.det.edge_up.runs", vars: { image } },
          { key: "ap.det.edge_up.drops" },
        ],
      };
    },
    async run() {
      try {
        return { ok: true, ...(await d!.apply()) };
      } catch (e) {
        return {
          ok: false,
          error: String((e as Error)?.message ?? e).trim() || "failed",
        };
      }
    },
  };
}

/** The config's part an offer follows: edge.image and edge.args. */
export function edgeConfigKey(cfg: Pick<EdgeConfig, "image" | "args">): string {
  return JSON.stringify([cfg.image, cfg.args]);
}

export function createEdgeOffer(o: {
  /** The edge config now (null: no edge block). */
  config: () => EdgeConfig | null;
  drift: (cfg: EdgeConfig) => EdgeDrift | null;
  queue: () => ApprovalQueue;
  action: HeldAction;
  log?: (line: string) => void;
}): { tick(): Promise<Approval | null> } {
  let last: string | undefined;
  return {
    async tick() {
      let cfg: EdgeConfig | null;
      try {
        cfg = o.config();
      } catch {
        cfg = null;
      }
      if (!cfg) return null;
      const key = edgeConfigKey(cfg);
      if (key === last) return null;
      last = key;
      let drift: EdgeDrift | null;
      try {
        drift = o.drift(cfg);
      } catch {
        drift = null;
      }
      if (!drift) return null;
      const q = o.queue();
      if (
        q
          .pending()
          .some((a) => a.actor === EDGE_OFFER_ACTOR && a.action === "edge_up")
      )
        return null;
      const c = await o.action.check({});
      if (!c.ok) return null;
      try {
        const a = q.request({
          actor: EDGE_OFFER_ACTOR,
          action: "edge_up",
          args: c.args,
          summary: c.summary,
          params: c.params,
          details: c.details,
          detailKeys: c.detailKeys,
          ttlMs: EDGE_OFFER_TTL_MS,
        });
        o.log?.(
          `edge: ${drift.line}; holding edge_up for the person [${a.id}]`,
        );
        return a;
      } catch {
        return null;
      }
    },
  };
}
