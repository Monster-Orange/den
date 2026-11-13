/**
 * H5: GET/PUT /api/workspaces/:ws/hub-project, the Hub project a project
 * works on (Settings › Project setup › Hub project).
 *
 *   GET → { project, hub: {id, slug, name} | null, connected,
 *           suggestions, projects, error? }
 *         Hub's suggestions (the same repo, then the same name) and every
 *         project of this install's company, from Hub; nothing is written.
 *   PUT { hub: "<id | slug | name>" | null } → links it to one of the
 *         company's Hub projects (checked against Hub's list), or unlinks.
 *         A person's only: an agent's token or an MCP caller is refused.
 */
import type * as http from "http";
import {
  hubProjectOf,
  pickHubProject,
  setHubProject,
  type HubProjectChoice,
  type HubProjectLink,
} from "../../shared/hub-project-link.js";
import type { Uncovered } from "../../shared/hub-project-sync.js";
import { readBody, sendJson } from "./http-helpers.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
} from "./request-guard.js";

export const HUB_PROJECT_ROUTE = /^\/api\/workspaces\/([^/]+)\/hub-project$/;

export interface HubProjectRouteDeps {
  /** Whether project `ws` exists here. */
  exists: (ws: string) => boolean;
  /** Hub's projects and suggestions; null: Hub isn't connected. */
  choices: (ws: string) => Promise<{
    suggestions: HubProjectChoice[];
    projects: HubProjectChoice[];
  } | null>;
  read: (ws: string) => HubProjectLink | null;
  /** `by`: who asked, for the audit row (0.4.44). */
  write: (ws: string, link: HubProjectLink | null, by?: string) => void;
  /** Repos in `ws` Den Hub's GitHub App can't see, from the last sync. */
  uncovered: (ws: string) => Uncovered[];
  /** After a link or unlink: send the project list again. */
  changed: () => void;
}

async function defaultUncovered(ws: string): Promise<Uncovered[]> {
  const s = await import("./hub-sync-service.js");
  return s.projectSync().uncoveredFor(ws);
}

export function defaultChanged(): void {
  void import("./hub-sync-service.js").then((s) => s.projectSync().request());
}

export async function defaultChoices(ws: string) {
  const hub = await import("../../shared/hub.js");
  const cfg = hub.readHubConfig();
  if (!cfg) return null;
  const token = await hub.readHubToken(cfg);
  if (!token) return null;
  const { projectRepos } = await import("../../shared/project-repos.js");
  return hub.hubProjectChoices(cfg.url, token, {
    workspace: ws,
    repos: projectRepos(ws),
  });
}

async function defaultExists(ws: string): Promise<boolean> {
  const w = await import("../../shared/environment-manager/workspaces.js");
  try {
    return Boolean(w.readWorkspacesFile().workspaces[ws]);
  } catch {
    return false;
  }
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export async function hubProjectRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  wsRaw: string,
  over: Partial<HubProjectRouteDeps> = {},
): Promise<true> {
  const ws = decode(wsRaw);
  const method = (req.method ?? "GET").toUpperCase();
  const exists = over.exists ?? null;
  const ok = exists ? exists(ws) : await defaultExists(ws);
  if (!ok) {
    sendJson(res, { ok: false, error: `there is no project "${ws}"` }, 404);
    return true;
  }
  const read = over.read ?? ((w: string) => hubProjectOf(w));
  const write = over.write ?? setHubProject;
  const choicesOf = over.choices ?? defaultChoices;
  const changed = over.changed ?? defaultChanged;
  const uncovered = over.uncovered
    ? async (w: string) => over.uncovered!(w)
    : defaultUncovered;

  if (method === "GET" || method === "HEAD") {
    const hub = read(ws);
    const unseen = await uncovered(ws).catch(() => []);
    try {
      const c = await choicesOf(ws);
      sendJson(res, {
        ok: true,
        project: ws,
        hub,
        connected: c !== null,
        suggestions: c?.suggestions ?? [],
        projects: c?.projects ?? [],
        uncovered: unseen,
      });
    } catch (e) {
      sendJson(res, {
        ok: true,
        project: ws,
        hub,
        connected: true,
        suggestions: [],
        projects: [],
        uncovered: unseen,
        error: `Hub didn't list its projects: ${(e as Error).message}`,
      });
    }
    return true;
  }
  if (method !== "PUT") {
    res.setHeader("Allow", "GET, PUT");
    sendJson(res, { ok: false, error: "use GET or PUT" }, 405);
    return true;
  }
  if (agentPrincipalOf(req) || auditActorOf(req)) {
    sendJson(
      res,
      {
        ok: false,
        code: "person_only",
        error: "Linking a project to Hub is a person's ask; an agent can't.",
      },
      403,
    );
    return true;
  }
  let body: { hub?: unknown };
  try {
    const raw = await readBody(req);
    body = raw ? (JSON.parse(raw) as { hub?: unknown }) : {};
  } catch {
    sendJson(res, { ok: false, error: "the body must be JSON" }, 400);
    return true;
  }
  const by = `Settings › Hub project (${principalOf(req) ?? "person"})`;
  if (body.hub === null) {
    write(ws, null, by);
    changed();
    sendJson(res, { ok: true, project: ws, hub: null });
    return true;
  }
  if (typeof body.hub !== "string" || !body.hub.trim()) {
    sendJson(
      res,
      { ok: false, error: "hub: a Hub project's id, slug or name, or null" },
      400,
    );
    return true;
  }
  let c: Awaited<ReturnType<HubProjectRouteDeps["choices"]>>;
  try {
    c = await choicesOf(ws);
  } catch (e) {
    sendJson(
      res,
      {
        ok: false,
        error: `Hub didn't list its projects: ${(e as Error).message}`,
      },
      502,
    );
    return true;
  }
  if (!c) {
    sendJson(
      res,
      {
        ok: false,
        error: "This install isn't connected to Hub. Connect it first.",
      },
      409,
    );
    return true;
  }
  const pick = pickHubProject(body.hub, c.projects);
  if (!pick) {
    sendJson(
      res,
      {
        ok: false,
        error: `Your company has no Hub project "${body.hub.trim()}".`,
      },
      404,
    );
    return true;
  }
  const link = { id: pick.id, slug: pick.slug, name: pick.name };
  write(ws, link, by);
  changed();
  sendJson(res, { ok: true, project: ws, hub: link });
  return true;
}
