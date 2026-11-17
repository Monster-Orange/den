/**
 * Issue 271: POST /api/workspaces/:ws/hub-create {name}. Settings ›
 * Project › Hub project's "Create a Hub project named …": Den asks Hub for
 * a new project with its project plan path (held for an owner in Hub),
 * and keeps the ask next to the project (shared/hub-project-create.ts).
 * GET /api/workspaces/:ws/hub-project then says what became of it, and
 * links it once an owner allowed it.
 *
 *   → { ok, project, ask }   asked; nothing linked yet
 *   400 an empty or too long name; 404 no such project;
 *   409 already linked, an ask waiting, or Hub not connected;
 *   502 Hub refused it or didn't answer (its words); nothing is kept.
 *
 * A person's only: an agent asks with the held write hub_project_create,
 * which runs the same code.
 */
import type * as http from "http";
import {
  askHubCreate,
  type HubCreateDeps,
} from "../../shared/hub-project-create.js";
import { readBody, sendJson } from "./http-helpers.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
} from "./request-guard.js";

export const HUB_CREATE_ROUTE = /^\/api\/workspaces\/([^/]+)\/hub-create$/;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export async function hubCreateRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  wsRaw: string,
  d: HubCreateDeps,
): Promise<true> {
  const ws = decode(wsRaw);
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, { ok: false, error: "use POST" }, 405);
    return true;
  }
  if (agentPrincipalOf(req) || auditActorOf(req)) {
    sendJson(
      res,
      {
        ok: false,
        code: "person_only",
        error:
          "Creating a Hub project from Settings is a person's ask; an agent asks with hub_project_create.",
      },
      403,
    );
    return true;
  }
  let name = "";
  try {
    const raw = await readBody(req);
    const b = (raw ? JSON.parse(raw) : {}) as { name?: unknown };
    name = typeof b.name === "string" ? b.name : "";
  } catch {
    sendJson(res, { ok: false, error: "the body must be JSON" }, 400);
    return true;
  }
  const r = await askHubCreate(d, {
    ws,
    name,
    by: "person",
    auditBy: `Settings › Hub project, asked Hub for a new project (${principalOf(req) ?? "person"})`,
  });
  if (!r.ok) {
    sendJson(res, { ok: false, code: r.code, error: r.error }, r.status);
    return true;
  }
  sendJson(res, { ok: true, project: ws, ask: r.ask });
  return true;
}

/** The deps on this install: its projects, its links, Hub with its token. */
export async function defaultHubCreateDeps(): Promise<HubCreateDeps> {
  const [link, w, sync] = await Promise.all([
    import("../../shared/hub-project-link.js"),
    import("../../shared/environment-manager/workspaces.js"),
    import("./hub-sync-service.js"),
  ]);
  return {
    exists: (ws) => {
      try {
        return Boolean(w.readWorkspacesFile().workspaces[ws]);
      } catch {
        return false;
      }
    },
    linked: (ws) => link.hubProjectOf(ws),
    asked: (ws) => link.hubCreateOf(ws),
    hub: () => sync.hubAndToken(),
    taken: async () => {
      const at = await sync.hubAndToken();
      if (!at) return [];
      const hub = await import("../../shared/hub.js");
      const c = await hub.hubProjectChoices(at.url, at.token, {
        workspace: "",
        repos: [],
      });
      return c.projects.map((p) => p.slug);
    },
    keep: (ws, c, by) => link.setHubCreate(ws, c, by),
    link: (ws, l, by) => link.setHubProject(ws, l, by),
    changed: () => sync.projectSync().request(),
  };
}

/**
 * Issue 271: settle every project's waiting ask (applied → linked). Den
 * runs it on the project sync's check, and when Hub's push says a held
 * change was decided, so a project links on its own with no page open.
 * Asks Hub only for projects with an ask waiting.
 */
export async function settleAllHubCreates(
  d?: HubCreateDeps,
): Promise<string[]> {
  const [{ readWorkspacesFile }, link, c] = await Promise.all([
    import("../../shared/environment-manager/workspaces.js"),
    import("../../shared/hub-project-link.js"),
    import("../../shared/hub-project-create.js"),
  ]);
  const waiting = Object.keys(readWorkspacesFile().workspaces).filter((ws) => {
    const a = link.hubCreateOf(ws);
    return a && !a.outcome;
  });
  if (!waiting.length) return [];
  const deps = d ?? (await defaultHubCreateDeps());
  const linked: string[] = [];
  for (const ws of waiting)
    if ((await c.settleHubCreate(deps, ws)).state === "applied")
      linked.push(ws);
  return linked;
}
