/**
 * Issue 750 (G3): GET /api/hub/groups, for the agents page's By group
 * view. Den reads this install's groups from Hub (hub-groups.ts holds the
 * contract) and adds the links into Hub, built from Den's own Hub
 * connection (its URL, and the company's slug from the binding):
 *   hub        the company in Hub (Open Hub)
 *   groupsUrl  its Groups page (Open Groups in Hub)
 *   open       each group's page
 *   compose    Message group: Hub's composer, to <slug>/all; the person
 *              sends with their own Hub sign-in
 * Each member and lead that is one of this Den's own agents is marked
 * `here` (an agent_id may be another person's agent). Den stores no
 * groups and sends none: at most a copy in memory for
 * hub.groups_cache_seconds; `?fresh=1` (Try again) reads Hub now.
 *
 *   → { ok, state: "ok", rule, groups, hub, groupsUrl }
 *     { ok, state: "off" }                  hub.groups off; or auto (the
 *                                           default) with no Hub, a Hub
 *                                           whose whoami lacks groups.read,
 *                                           or no whoami answer; or Hub
 *                                           has no groups route; auto's
 *                                           off for groups.read adds
 *                                           why: "hub-lacks-groups-read"
 *     { ok, state: "none" }                 hub.groups on, no Hub connected
 *     { ok, state: "unavailable", hub }     403 groups_not_in_plan
 *     { ok, state: "refused" }              403 install_refused (a guest)
 *     { ok, state: "rejected" | "unreachable" }
 */
import type * as http from "http";
import {
  groupsView,
  type HubGroupsDeps,
} from "../../shared/hub/hub-groups-view.js";
import { sendJson } from "./http-helpers.js";

export {
  defaultHubGroupsDeps,
  groupsView,
  type HubGroupsDeps,
} from "../../shared/hub/hub-groups-view.js";

export const HUB_GROUPS_PATH = "/api/hub/groups";

export async function hubGroupsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  d: HubGroupsDeps,
): Promise<true> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET");
    sendJson(res, { ok: false, error: "use GET" }, 405);
    return true;
  }
  const fresh = /[?&]fresh=1(&|$)/.test(req.url ?? "");
  sendJson(res, await groupsView(d, { fresh }));
  return true;
}
