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
import type { HubGroupsMode } from "../../shared/hub.js";
import {
  fetchHubGroups,
  GROUPS_FEATURE,
  groupComposeUrl,
  groupHubUrl,
  isGroupSlug,
  isOwnAgent,
  type GroupsRead,
} from "../../shared/hub-groups.js";
import { sendJson } from "./http-helpers.js";

export const HUB_GROUPS_PATH = "/api/hub/groups";

export interface HubGroupsDeps {
  /** Den's Hub connection now, or null with none. */
  hub: () => Promise<{ url: string; token: string } | null>;
  /** The company's slug from Den's Hub binding, or null when not known. */
  company: () => string | null;
  /**
   * Who this install is on Hub (whoami), for `here`, and what Hub lists
   * (features, for auto); {} when not known. Throws with no answer.
   */
  self: () => Promise<{
    install?: string;
    login?: string;
    features?: readonly string[];
  }>;
  /** hub.groups_cache_seconds. */
  cacheSeconds: () => number;
  /** hub.groups: auto (the default), on or off. */
  mode: () => HubGroupsMode;
  /** The in-memory copy, by Hub URL (never written anywhere). */
  cache: Map<
    string,
    { at: number; read: GroupsRead; self: { install?: string; login?: string } }
  >;
  now?: () => number;
}

/** One copy for this server: the page's last read, per Hub. */
const memory: HubGroupsDeps["cache"] = new Map();

/** The company's page in Hub: <hub>/<company>. */
function companyUrl(hubUrl: string, company: string): string | null {
  const g = groupHubUrl(hubUrl, company, "x");
  return g ? g.replace(/\/groups\/x$/, "") : null;
}

/**
 * The groups read's answer (the route's body; `den hub groups` prints
 * it). `fresh`: read Hub now, past the copy in memory.
 */
export async function groupsView(
  d: HubGroupsDeps,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<Record<string, unknown>> {
  // hub.groups off: nothing new on the page, Hub not asked.
  const mode = d.mode();
  if (mode === "off") {
    d.cache.clear();
    return { ok: true, state: "off" };
  }
  const hub = await d.hub().catch(() => null);
  if (!hub) {
    d.cache.clear();
    // Auto with no Hub: nothing about groups. On: the Connect line.
    return { ok: true, state: mode === "auto" ? "off" : "none" };
  }
  const now = (d.now ?? Date.now)();
  const kept = d.cache.get(`${mode} ${hub.url}`);
  let read: GroupsRead;
  let self: { install?: string; login?: string };
  if (!fresh && kept && now - kept.at < d.cacheSeconds() * 1000) {
    read = kept.read;
    self = kept.self;
  } else if (mode === "auto") {
    // Auto: Hub's groups only when its whoami lists groups.read; a Hub
    // without it reads as one with no groups route (kept), and no
    // whoami answer as off (asked again next time).
    const w = await d.self().catch(() => null);
    d.cache.clear();
    if (!w) {
      return { ok: true, state: "off" };
    }
    self = { install: w.install, login: w.login };
    read = w.features?.includes(GROUPS_FEATURE)
      ? await fetchHubGroups(hub.url, hub.token)
      : { state: "absent", noFeature: true };
    if (read.state !== "unreachable")
      d.cache.set(`${mode} ${hub.url}`, { at: now, read, self });
  } else {
    read = await fetchHubGroups(hub.url, hub.token);
    self = read.state === "ok" ? await d.self().catch(() => ({})) : {};
    d.cache.clear();
    // Only an answer is kept: a Hub that didn't answer is asked again.
    if (read.state !== "unreachable")
      d.cache.set(`${mode} ${hub.url}`, { at: now, read, self });
  }
  const own = d.company();
  const company = isGroupSlug(own)
    ? own
    : read.state === "ok"
      ? read.groups.team
      : "";
  const home = companyUrl(hub.url, company);
  // A Hub with no groups route: the same as off.
  if (read.state === "absent") {
    return {
      ok: true,
      state: "off",
      ...(read.noFeature ? { why: "hub-lacks-groups-read" } : {}),
    };
  }
  if (read.state !== "ok") {
    return {
      ok: true,
      state: read.state,
      ...(read.state === "unavailable" ? { hub: home ?? hub.url } : {}),
    };
  }
  return {
    ok: true,
    state: "ok",
    rule: read.groups.rule,
    hub: home ?? hub.url,
    groupsUrl: home ? `${home}/groups` : null,
    groups: read.groups.groups.map((g) => ({
      ...g,
      lead: g.lead
        ? { ...g.lead, ...(isOwnAgent(g.lead, self) ? { here: true } : {}) }
        : null,
      members: g.members.map((m) =>
        isOwnAgent(m, self) ? { ...m, here: true } : m,
      ),
      open: groupHubUrl(hub.url, company, g.slug),
      compose: groupComposeUrl(hub.url, company, g.slug),
    })),
  };
}

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

/** The deps on this install: Den's Hub config, token and binding. */
export async function defaultHubGroupsDeps(): Promise<HubGroupsDeps> {
  const [hub, binding, paths] = await Promise.all([
    import("../../shared/hub.js"),
    import("../../shared/hub-binding.js"),
    import("../../shared/paths.js"),
  ]);
  const cfg = (() => {
    try {
      return hub.readHubConfig();
    } catch {
      return null;
    }
  })();
  const token = async () => (cfg ? hub.readHubToken(cfg) : null);
  return {
    hub: async () => {
      const t = await token();
      return cfg && t ? { url: cfg.url, token: t } : null;
    },
    company: () => {
      const b = binding.readHubBinding(paths.getStateDir());
      return b && cfg && b.origin === binding.hubOrigin(cfg.url)
        ? (b.company ?? null)
        : null;
    },
    self: async () => {
      const t = await token();
      if (!cfg || !t) return {};
      const w = await hub.hubWhoami(cfg.url, t);
      return {
        ...(w.install ? { install: w.install } : {}),
        ...(w.login ? { login: w.login } : {}),
        ...(w.features ? { features: w.features } : {}),
      };
    },
    cacheSeconds: () => cfg?.groupsCacheSeconds ?? 30,
    // Without a Hub address (no hub config): the default, auto.
    mode: () => cfg?.groups ?? "auto",
    cache: memory,
  };
}
