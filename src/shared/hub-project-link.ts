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

export interface HubProjectLink {
  /** Hub's project id (proj_…). */
  id: string;
  slug: string;
  name: string;
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
  return { id, slug, name: plain(o.name, 200) || slug };
}

/** Project `ws`'s Hub project, or null (not linked, or unreadable). */
export function hubProjectOf(
  ws: string,
  read: () => WorkspacesFile = readWorkspacesFile,
): HubProjectLink | null {
  try {
    const cfg = read().workspaces[ws];
    return parseHubProjectLink(cfg?.hub_project);
  } catch {
    return null;
  }
}

/** Link project `ws` to a Hub project, or unlink it (null). */
export function setHubProject(ws: string, link: HubProjectLink | null): void {
  const file = readWorkspacesFile();
  const cfg = file.workspaces[ws];
  if (!cfg) throw new Error(`project "${ws}" does not exist`);
  const next = { ...cfg };
  if (link) {
    const ok = parseHubProjectLink(link);
    if (!ok) throw new Error(`"${link.id}" is not a Hub project id`);
    next.hub_project = ok;
  } else delete next.hub_project;
  file.workspaces[ws] = next;
  writeWorkspacesFile(file);
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
