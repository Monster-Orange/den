/**
 * Issue 750 (G3): groups in Den, read from Hub. Groups are a Den Hub
 * feature: Den never stores or computes them. It reads an install's groups
 * from Hub to draw the agents page's By group view, and links to Hub's own
 * group pages (Open, and Message group: Hub's composer, where the person
 * sends with their own Hub sign-in). Den adds no group tools; those stay
 * Hub MCP tools.
 *
 * Contract per SPEC-GROUPS (G1/G2, Hub 0.2.29); confirm with Hub:
 *
 *   GET <hub>/api/groups, the install's token →
 *     { team, rule, groups: [{ name, slug, all, address, lead,
 *       escalates_to, members: [{ role, address, name, kind, of,
 *       install?, agent_id? }] }] }
 *     lead: an agent { name, kind: "agent", of, install, agent_id }, or a
 *     person { name, kind: "person", login }. Den matches its agents by
 *     agent_id.
 *   401: the token isn't taken. 403 with code "groups_not_in_plan": the
 *   company's plan has no groups. 403 with code "install_refused" (Hub
 *   0.2.29), or with no code (an older Hub): a guest (the token's person
 *   is a guest in the company). A 403 with any other code isn't about
 *   groups: not shown. Den reads the `code`, never the error's words. No
 *   answer, a 5xx (or an older Hub's 404): not shown.
 *   A member's agent_id may be another person's agent: Den marks as its
 *   own only one whose install and person are this Den's (`here`).
 *
 *   Hub's group pages (confirm with Hub):
 *     <hub>/<company>/groups/<slug>                 the group (Open)
 *     <hub>/<company>/groups/<slug>?compose=1[&to=<slug>/<role>]
 *                                                   Hub's composer, to
 *                                                   <slug>/all by default
 *   Den never sends to a group itself. What reached each member is Den's
 *   delivery acks (hub-delivery.ts: `held`), shown on Hub's own page.
 */
import { HubCallError, hubCall } from "./hub.js";

export const GROUPS_PATH = "/api/groups";
/** Hub's 403 code for a company whose plan has no groups. */
export const GROUPS_NOT_IN_PLAN = "groups_not_in_plan";
/** Hub 0.2.29's 403 code for an install refused for its person's role (a guest). */
export const INSTALL_REFUSED = "install_refused";

export type GroupLead =
  | {
      name: string;
      kind: "agent";
      of?: string;
      install?: string;
      agentId?: string;
    }
  | { name: string; kind: "person"; login?: string };

export interface GroupMember {
  role: string;
  address: string;
  name: string;
  kind: "agent" | "person";
  of?: string;
  install?: string;
  /** Den's own agent key, for an agent on some install. */
  agentId?: string;
}

export interface HubGroup {
  name: string;
  slug: string;
  /** The whole-group address, <slug>/all. */
  all: string;
  /** The lead's address, <slug>/lead. */
  address: string;
  lead: GroupLead | null;
  escalatesTo?: string;
  members: GroupMember[];
}

export interface HubGroups {
  /** The company, as Hub names it in its paths. */
  team: string;
  rule: string;
  groups: HubGroup[];
}

/** What the agents page gets (GET /api/hub/groups). */
export type GroupsRead =
  | { state: "ok"; groups: HubGroups }
  /** No Hub connected: "Groups come with Den Hub." */
  | { state: "none" }
  /** 403 groups_not_in_plan: not in the company's Den Hub plan. */
  | { state: "unavailable" }
  /** 403 install_refused (or no code): a guest in the company. */
  | { state: "refused" }
  /** 401: the token isn't taken. */
  | { state: "rejected" }
  /** No answer, or a 5xx: "Can't reach Den Hub". */
  | { state: "unreachable" };

const MAX_GROUPS = 200;
const MAX_MEMBERS = 200;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROLE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const text = (v: unknown, max = 200): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  // One plain line: no control characters.
  // eslint-disable-next-line no-control-regex
  return s && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s)
    ? s
    : undefined;
};

/** A slug Hub would make: lowercase, digits and dashes. */
export const isGroupSlug = (s: unknown): s is string =>
  typeof s === "string" && SLUG.test(s);

function parseLead(v: unknown): GroupLead | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const name = text(r.name);
  if (!name) return null;
  if (r.kind === "person")
    return {
      name,
      kind: "person",
      ...(text(r.login) ? { login: text(r.login)! } : {}),
    };
  if (r.kind !== "agent") return null;
  return {
    name,
    kind: "agent",
    ...(text(r.of) ? { of: text(r.of)! } : {}),
    ...(text(r.install) ? { install: text(r.install)! } : {}),
    ...(text(r.agent_id, 128) ? { agentId: text(r.agent_id, 128)! } : {}),
  };
}

function parseMember(v: unknown): GroupMember | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const name = text(r.name);
  const role = text(r.role, 64);
  const address = text(r.address, 130);
  if (!name || !role || !ROLE.test(role) || !address) return null;
  if (r.kind !== "agent" && r.kind !== "person") return null;
  return {
    role,
    address,
    name,
    kind: r.kind,
    ...(text(r.of) ? { of: text(r.of)! } : {}),
    ...(text(r.install) ? { install: text(r.install)! } : {}),
    ...(r.kind === "agent" && text(r.agent_id, 128)
      ? { agentId: text(r.agent_id, 128)! }
      : {}),
  };
}

/** Hub's GET /api/groups answer, checked; null when it isn't the shape. */
export function parseGroups(v: unknown): HubGroups | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  if (!Array.isArray(b.groups)) return null;
  const groups: HubGroup[] = [];
  for (const g of b.groups.slice(0, MAX_GROUPS)) {
    if (!g || typeof g !== "object") continue;
    const r = g as Record<string, unknown>;
    const name = text(r.name);
    if (!name || !isGroupSlug(r.slug)) continue;
    const slug = r.slug;
    const members = Array.isArray(r.members)
      ? r.members
          .slice(0, MAX_MEMBERS)
          .map(parseMember)
          .filter((m): m is GroupMember => m !== null)
      : [];
    groups.push({
      name,
      slug,
      all: `${slug}/all`,
      address: `${slug}/lead`,
      lead: parseLead(r.lead),
      ...(text(r.escalates_to) ? { escalatesTo: text(r.escalates_to)! } : {}),
      members,
    });
  }
  return {
    team: text(b.team, 64) ?? "",
    rule: b.rule === "enforce" ? "enforce" : "advise",
    groups,
  };
}

/** The Hub's origin and path base, or null for one that isn't http(s). */
function hubBase(hubUrl: string): string | null {
  try {
    const u = new URL(hubUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** A group's page in Hub (Open): <hub>/<company>/groups/<slug>. */
export function groupHubUrl(
  hubUrl: string,
  company: string,
  slug: string,
): string | null {
  const base = hubBase(hubUrl);
  if (!base || !isGroupSlug(company) || !isGroupSlug(slug)) return null;
  return `${base}/${company}/groups/${slug}`;
}

/**
 * Message group: Hub's composer for it, in a new tab. `to` is one of the
 * group's own addresses (<slug>/<role>); else Hub's default, <slug>/all.
 */
export function groupComposeUrl(
  hubUrl: string,
  company: string,
  slug: string,
  to?: string,
): string | null {
  const page = groupHubUrl(hubUrl, company, slug);
  if (!page) return null;
  const own =
    typeof to === "string" &&
    to.startsWith(`${slug}/`) &&
    ROLE.test(to.slice(slug.length + 1)) &&
    to !== `${slug}/all`;
  return `${page}?compose=1${own ? `&to=${encodeURIComponent(to)}` : ""}`;
}

/**
 * Whether a member (or lead) is one of this Den's own agents: an agent
 * with an agent_id, on this install and this Den's person when Hub says
 * whose (another person's agent may share an id). Unknown on either side:
 * the id alone.
 */
export function isOwnAgent(
  m: { kind: string; agentId?: string; install?: string; of?: string },
  self: { install?: string; login?: string },
): boolean {
  if (m.kind !== "agent" || !m.agentId) return false;
  if (m.install && self.install && m.install !== self.install) return false;
  if (m.of && self.login && m.of !== self.login) return false;
  return true;
}

/** Read the install's groups from Hub (GET /api/groups). */
export async function fetchHubGroups(
  hubUrl: string,
  token: string,
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<GroupsRead> {
  const base = hubBase(hubUrl);
  if (!base) return { state: "unreachable" };
  try {
    const b = await hubCall(
      `${base}${GROUPS_PATH}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
      { timeoutMs: 10_000, ...opts },
    );
    const groups = parseGroups(b);
    return groups ? { state: "ok", groups } : { state: "unreachable" };
  } catch (e) {
    if (!(e instanceof HubCallError)) return { state: "unreachable" };
    if (e.kind === "rejected") return { state: "rejected" };
    // A 403: its `code` only, never its words.
    if (e.kind === "forbidden") {
      const code = (e.body as Record<string, unknown> | undefined)?.code;
      if (code === GROUPS_NOT_IN_PLAN) return { state: "unavailable" };
      // A guest's token (Hub 0.2.29 names it); an older Hub sends no code.
      if (code === INSTALL_REFUSED || code === undefined)
        return { state: "refused" };
      // Another refusal (not about groups): no groups, never the guest line.
      return { state: "unreachable" };
    }
    // No answer, a 5xx, or a Hub with no such route (404): not shown.
    return { state: "unreachable" };
  }
}
