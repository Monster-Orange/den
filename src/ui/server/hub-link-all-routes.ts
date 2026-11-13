/**
 * #68: link every project to Hub's suggestion in one confirm (Settings ›
 * Agents › Link projects to Hub; `<cli> hub link --suggested` sends the
 * person there).
 *
 *   GET  /api/hub/link-suggestions → { connected, projects: [{project,
 *        hub, suggestion}] }: each project, its Hub project (or null), and
 *        Hub's first suggestion for an unlinked one (the same repos, then
 *        the same name). Nothing is written.
 *   POST { links: [{project, hub: <Hub project id>}] } → { linked,
 *        skipped }: links each pair that is still that project's
 *        suggestion and still unlinked; the rest are skipped, saying why.
 *        One sync to Hub after. Each link is audited. A person's only: an
 *        agent's token or an MCP caller is refused.
 */
import type * as http from "http";
import type {
  HubProjectChoice,
  HubProjectLink,
} from "../../shared/hub-project-link.js";
import { readBody, sendJson } from "./http-helpers.js";
import { agentPrincipalOf, auditActorOf } from "./request-guard.js";

export const HUB_LINK_ALL_PATH = "/api/hub/link-suggestions";

type Suggestion = HubProjectChoice & { why?: "repo" | "name" };

export interface HubLinkAllDeps {
  /** Every project here (the server agent's scope is never one). */
  projects: () => string[];
  /** Hub's projects and suggestions for `ws`; null: Hub isn't connected. */
  choices: (ws: string) => Promise<{
    suggestions: Suggestion[];
    projects: HubProjectChoice[];
  } | null>;
  read: (ws: string) => HubProjectLink | null;
  write: (ws: string, link: HubProjectLink) => void;
  /** After any link: send the project list to Hub again. */
  changed: () => void;
  /** One line per link, for the audit trail. */
  audit: (line: string) => void;
}

const MAX_LINKS = 200;

export async function hubLinkAllRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  d: HubLinkAllDeps,
): Promise<true> {
  const method = (req.method ?? "GET").toUpperCase();
  const projects = d.projects();

  if (method === "GET" || method === "HEAD") {
    let connected = true;
    const rows = await Promise.all(
      projects.map(async (project) => {
        const hub = d.read(project);
        if (hub) return { project, hub, suggestion: null };
        const c = await d.choices(project).catch(() => null);
        if (c === null) connected = false;
        const s = c?.suggestions[0];
        return {
          project,
          hub: null,
          suggestion: s
            ? {
                id: s.id,
                slug: s.slug,
                name: s.name,
                ...(s.why ? { why: s.why } : {}),
              }
            : null,
        };
      }),
    );
    // With every project linked, ask Hub once whether it is there at all.
    if (rows.every((r) => r.hub) && projects.length)
      connected = (await d.choices(projects[0]).catch(() => null)) !== null;
    sendJson(res, { ok: true, connected, projects: rows });
    return true;
  }

  if (method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    sendJson(res, { ok: false, error: "use GET or POST" }, 405);
    return true;
  }
  if (agentPrincipalOf(req) || auditActorOf(req)) {
    sendJson(
      res,
      {
        ok: false,
        code: "person_only",
        error: "Linking projects to Hub is a person's ask; an agent can't.",
      },
      403,
    );
    return true;
  }
  let links: { project: string; hub: string }[];
  try {
    const raw = await readBody(req);
    const b = (raw ? JSON.parse(raw) : {}) as { links?: unknown };
    if (
      !Array.isArray(b.links) ||
      b.links.length > MAX_LINKS ||
      !b.links.every(
        (l) =>
          l &&
          typeof (l as { project?: unknown }).project === "string" &&
          typeof (l as { hub?: unknown }).hub === "string",
      )
    )
      throw new Error("bad");
    links = b.links as { project: string; hub: string }[];
  } catch {
    sendJson(
      res,
      {
        ok: false,
        error: `links: a list of {project, hub} (at most ${MAX_LINKS})`,
      },
      400,
    );
    return true;
  }
  const known = new Set(projects);
  const linked: { project: string; hub: HubProjectLink }[] = [];
  // code: what the page translates; why: the same in words, for the CLI.
  const skipped: {
    project: string;
    code: "unknown" | "linked" | "offline" | "stale";
    why: string;
  }[] = [];
  for (const { project, hub } of links) {
    if (!known.has(project)) {
      skipped.push({ project, code: "unknown", why: "no such project" });
      continue;
    }
    if (d.read(project)) {
      skipped.push({ project, code: "linked", why: "already linked" });
      continue;
    }
    // Checked against Hub now: only what Hub still suggests for it.
    const c = await d.choices(project).catch(() => null);
    if (c === null) {
      skipped.push({ project, code: "offline", why: "Hub didn't answer" });
      continue;
    }
    const s = c.suggestions.find((x) => x.id === hub);
    if (!s) {
      skipped.push({
        project,
        code: "stale",
        why: "not Hub's suggestion for it",
      });
      continue;
    }
    const link = { id: s.id, slug: s.slug, name: s.name };
    d.write(project, link);
    d.audit(`${project} → ${s.slug}`);
    linked.push({ project, hub: link });
  }
  if (linked.length) d.changed();
  sendJson(res, { ok: true, linked, skipped });
  return true;
}
