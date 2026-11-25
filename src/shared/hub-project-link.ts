/**
 * H5 (Ward: "how do I reconnect a project ... with the project in den
 * hub?!"): each project setup records the Hub project it works on, as the
 * person picked it: `<ws>.hub_project: {id, slug, name}` in
 * config/local/workspaces.yml (this install's own). Den sends the id on
 * every Hub call as X-Den-Project (`none` when not linked); Hub files by it
 * and never guesses. The slug and name are what the person saw when they
 * linked, for display; the id is what counts.
 *
 * Den never links on its own: Hub's suggestions (same repo, same name) are
 * offered, and the person confirms.
 */
import {
  readWorkspacesFile,
  writeWorkspacesFile,
} from "./environment-manager/workspaces.js";
import type { WorkspacesFile } from "./types/index.js";
import { callerName } from "./config-audit.js";
import { forgetLinkSeen } from "./hub-links-seen.js";
import { WORKSPACE_NAME_MAX } from "./workspace-name.js";
import { parseHubCreate, type HubCreate } from "./hub-project-create.js";
import { hubOrigin, readHubBinding, type HubBinding } from "./hub-binding.js";
import { getStateDir } from "./paths.js";

export interface HubProjectLink {
  /** Hub's project id (proj_…). */
  id: string;
  slug: string;
  name: string;
  /**
   * Issue 646: the Hub (its origin) and the company the link was made on,
   * from hub/bound.json at the time. None on a link written before.
   */
  hub?: LinkHub;
}

/** Issue 646: which Hub and company a link belongs to. */
export interface LinkHub {
  origin: string;
  /** The company's slug (else its name), as hub/bound.json says it. */
  company?: string;
}

/** The Hub this install is bound to now (issue 726), or null. */
function boundNow(): HubBinding | null {
  try {
    return readHubBinding(getStateDir());
  } catch {
    return null;
  }
}

/**
 * Issue 646: whether `link` points at another Hub than `bound`: another
 * origin, or another company on the same one. A link with no Hub recorded
 * (written before 646) is the bound Hub's: issue 726 archives every link
 * when the Hub changes. No binding yet: nothing is elsewhere.
 */
export function isLinkElsewhere(
  link: HubProjectLink,
  bound: HubBinding | null,
): boolean {
  if (!link.hub || !bound) return false;
  if (link.hub.origin !== bound.origin) return true;
  return Boolean(
    link.hub.company && bound.company && link.hub.company !== bound.company,
  );
}

/**
 * A Hub project id, as Hub writes them: opaque to Den, kept as Hub gave it.
 * `proj_…` before Hub's Postgres port, a uuid after; Hub takes both.
 */
export const HUB_PROJECT_ID_RE =
  /^(?:proj_[a-z0-9]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const plain = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v
        .replace(/[^\x20-\x7e\u00a0-\uffff]/g, "")
        .trim()
        .slice(0, max)
    : "";

/** A link as written, checked: null when missing or not a Hub project id. */
export function parseHubProjectLink(v: unknown): HubProjectLink | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = plain(o.id, 64);
  if (!HUB_PROJECT_ID_RE.test(id)) return null;
  const slug = plain(o.slug, 100) || id;
  const h = (o.hub ?? null) as Record<string, unknown> | null;
  const origin = h && typeof h.origin === "string" ? hubOrigin(h.origin) : "";
  const company = h ? plain(h.company, 100) : "";
  return {
    id,
    slug,
    name: plain(o.name, 200) || slug,
    ...(origin ? { hub: { origin, ...(company ? { company } : {}) } } : {}),
  };
}

/**
 * Project `ws`'s Hub project, or null (not linked, or unreadable). Issue
 * 646: a link to another Hub or company counts as not linked.
 */
export function hubProjectOf(
  ws: string,
  read: () => WorkspacesFile = readWorkspacesFile,
  bound: () => HubBinding | null = boundNow,
): HubProjectLink | null {
  try {
    const link = parseHubProjectLink(read().workspaces[ws]?.hub_project);
    return link && !isLinkElsewhere(link, bound()) ? link : null;
  } catch {
    return null;
  }
}

/**
 * Issue 646: project `ws`'s link when it points at another Hub or company
 * than the bound one (doctor fails it; Connect's review says it), else null.
 */
export function hubLinkElsewhere(
  ws: string,
  read: () => WorkspacesFile = readWorkspacesFile,
  bound: () => HubBinding | null = boundNow,
): HubProjectLink | null {
  try {
    const link = parseHubProjectLink(read().workspaces[ws]?.hub_project);
    return link && isLinkElsewhere(link, bound()) ? link : null;
  } catch {
    return null;
  }
}

/**
 * Issue 646: of `names`, the projects whose link points at another Hub or
 * company ({ws: true}); the page counts them as not linked. One read.
 */
export function hubElsewhereMap(
  names: string[],
  read: () => WorkspacesFile = readWorkspacesFile,
  bound: () => HubBinding | null = boundNow,
): Record<string, true> {
  const out: Record<string, true> = {};
  try {
    const file = read();
    const b = bound();
    for (const ws of names) {
      const link = parseHubProjectLink(file.workspaces[ws]?.hub_project);
      if (link && isLinkElsewhere(link, b)) out[ws] = true;
    }
  } catch {
    /* none: nothing marked */
  }
  return out;
}

/**
 * Link project `ws` to a Hub project, or unlink it (null). `by` names who
 * asked, for the audit row (0.4.44): "Settings (person:…)", "cli hub link".
 */
export function setHubProject(
  ws: string,
  link: HubProjectLink | null,
  by: string = callerName(),
): void {
  const file = readWorkspacesFile();
  const cfg = file.workspaces[ws];
  if (!cfg) throw new Error(`project "${ws}" does not exist`);
  const next = { ...cfg };
  const was = parseHubProjectLink(cfg.hub_project);
  if (link) {
    const ok = parseHubProjectLink(link);
    if (!ok) throw new Error(`"${link.id}" is not a Hub project id`);
    // Issue 646: the link is the bound Hub's (and its company's).
    const b = ok.hub ? null : boundNow();
    next.hub_project = b
      ? {
          ...ok,
          hub: {
            origin: b.origin,
            ...(b.company ? { company: b.company } : {}),
          },
        }
      : ok;
    // Issue 167: a rename asked of another Hub project isn't this one's.
    if (was?.id !== ok.id) delete next.hub_rename;
    // Issue 271: linked now, so a new Hub project asked for it is moot.
    delete next.hub_create;
  } else {
    // 0.4.45 (Vision 11-13): unlink keeps Hub's last name as the project's
    // own, so the name shown does not change. The slug never changes.
    const last = parseHubProjectLink(cfg.hub_project)?.name?.trim();
    if (last) next.name = last.slice(0, WORKSPACE_NAME_MAX);
    delete next.hub_project;
    delete next.hub_rename;
  }
  file.workspaces[ws] = next;
  writeWorkspacesFile(file, by);
  // An unlink the person asked for: doctor doesn't call it lost.
  if (!link) forgetLinkSeen(ws);
}

/**
 * Issue 167 (mock v6 A3): a rename asked of Hub, waiting for a person's
 * decision there: `<ws>.hub_rename: {to, held, url?, askedAt}`, kept next
 * to the link until a sync brings that name (hub-sync-service). The name
 * shown stays Hub's until then.
 */
export interface HubRename {
  to: string;
  /** Hub's held change id. */
  held: string;
  /** Hub's page for it (http(s) only). */
  url?: string;
  askedAt: string;
}

/** A waiting rename as written, checked: null when missing or bad. */
export function parseHubRename(v: unknown): HubRename | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const to = plain(o.to, WORKSPACE_NAME_MAX);
  const held = plain(o.held, 100);
  if (!to || !held) return null;
  const url = plain(o.url, 2048);
  const at = typeof o.askedAt === "string" ? Date.parse(o.askedAt) : NaN;
  return {
    to,
    held,
    ...(/^https?:\/\//.test(url) ? { url } : {}),
    askedAt: new Date(Number.isNaN(at) ? 0 : at).toISOString(),
  };
}

/** Project `ws`'s rename waiting in Hub, or null. */
export function hubRenameOf(
  ws: string,
  read: () => WorkspacesFile = readWorkspacesFile,
): HubRename | null {
  try {
    return parseHubRename(read().workspaces[ws]?.hub_rename);
  } catch {
    return null;
  }
}

/** Keep a rename asked of Hub for `ws`, or drop it (null). */
export function setHubRename(
  ws: string,
  r: HubRename | null,
  by: string = callerName(),
): void {
  const file = readWorkspacesFile();
  const cfg = file.workspaces[ws];
  if (!cfg) throw new Error(`project "${ws}" does not exist`);
  const next = { ...cfg };
  const ok = r ? parseHubRename(r) : null;
  if (ok) next.hub_rename = ok;
  else delete next.hub_rename;
  file.workspaces[ws] = next;
  writeWorkspacesFile(file, by);
}

/** Issue 271: project `ws`'s new Hub project asked of Hub, or null. */
export function hubCreateOf(
  ws: string,
  read: () => WorkspacesFile = readWorkspacesFile,
): HubCreate | null {
  try {
    return parseHubCreate(read().workspaces[ws]?.hub_create);
  } catch {
    return null;
  }
}

/** Issue 271: keep a new Hub project asked for `ws`, or drop it (null). */
export function setHubCreate(
  ws: string,
  c: HubCreate | null,
  by: string = callerName(),
): void {
  const file = readWorkspacesFile();
  const cfg = file.workspaces[ws];
  if (!cfg) throw new Error(`project "${ws}" does not exist`);
  const next = { ...cfg };
  const ok = c ? parseHubCreate(c) : null;
  if (ok) next.hub_create = ok;
  else if (!("hub_create" in next)) return;
  else delete next.hub_create;
  file.workspaces[ws] = next;
  writeWorkspacesFile(file, by);
}

/** What Hub's /api/projects/suggest answers (projects of the token's company). */
export interface HubProjectChoice {
  id: string;
  slug: string;
  name: string;
  /** Why Hub suggests it: the same repo, or the same name. */
  why?: "repo" | "name";
}

/** Hub's answer, read defensively: suggestions first, then every project. */
export function readHubProjectChoices(body: unknown): {
  suggestions: HubProjectChoice[];
  projects: HubProjectChoice[];
} {
  const list = (v: unknown, withWhy: boolean): HubProjectChoice[] =>
    (Array.isArray(v) ? v : []).flatMap((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const link = parseHubProjectLink({
        id: o.project_id ?? o.id,
        slug: o.slug,
        name: o.name,
      });
      if (!link) return [];
      const why = o.why === "repo" || o.why === "name" ? o.why : undefined;
      return [withWhy && why ? { ...link, why } : link];
    });
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    suggestions: list(b.suggestions, true),
    projects: list(b.projects, false),
  };
}

/** The one Hub project `typed` names among `projects`: its id, slug or name. */
export function pickHubProject(
  typed: string,
  projects: HubProjectChoice[],
): HubProjectChoice | null {
  const t = typed.trim().toLowerCase();
  return (
    projects.find((p) => p.id === typed.trim()) ??
    projects.find((p) => p.slug.toLowerCase() === t) ??
    projects.find((p) => p.name.toLowerCase() === t) ??
    null
  );
}
