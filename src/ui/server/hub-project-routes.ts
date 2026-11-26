/**
 * H5: GET/PUT /api/workspaces/:ws/hub-project, the Hub project a project
 * works on (Settings › Project setup › Hub project).
 *
 *   GET → { project, hub: {id, slug, name} | null, connected,
 *           suggestions, projects, pick, error? }
 *         Hub's suggestions (the same repo, then the same name) and every
 *         project of this install's company, from Hub; nothing is written.
 *         pick (issue 167): not linked, and Den can't tell which Hub
 *         project fits (hubMatchOf), so it waits for a person's pick.
 *         Issue 271: name (the project's), owner (true/false: whether
 *         this install's person is an owner in Hub; null: Hub didn't
 *         say), company, create (a new Hub project asked for it, read
 *         from Hub first: an allowed one is linked by then).
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
} from "../../shared/hub/hub-project-link.js";
import type { Uncovered } from "../../shared/hub/hub-project-sync.js";
import type { HubCreate } from "../../shared/hub/hub-project-create.js";
import { readBody, sendJson } from "./http-helpers.js";
import { hubMatchOf } from "./hub-link-all-routes.js";
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
  /**
   * Issue 167: a project Den couldn't match was just linked here; the
   * bell's "N projects need your pick" counts down (pickDone).
   */
  picked?: (n: number) => void;
  /** Issue 271: the name project `ws` shows (the Create option's default). */
  name?: (ws: string) => string;
  /**
   * Issue 271: this install's person in Hub: their role (an owner allows
   * Hub's held changes) and the company's name; null when Hub didn't say.
   */
  whoami?: () => Promise<{ role?: string; company?: string } | null>;
  /**
   * Issue 271: the new Hub project asked for `ws`, after reading what
   * became of it (an allowed one is linked by then); null: none.
   */
  create?: (ws: string) => Promise<HubCreate | null>;
  /**
   * Issue 646 (mock v2, 3b): the link when it points at another Hub or
   * company, with the one connected now; null: none (or on this Hub).
   */
  elsewhere?: (ws: string) => LinkElsewhere | null;
}

export interface LinkElsewhere {
  name: string;
  origin: string;
  company?: string;
  now?: { origin: string; company?: string };
}

async function defaultElsewhere(ws: string): Promise<LinkElsewhere | null> {
  const [link, binding, paths] = await Promise.all([
    import("../../shared/hub/hub-project-link.js"),
    import("../../shared/hub/hub-binding.js"),
    import("../../shared/paths.js"),
  ]);
  const away = link.hubLinkElsewhere(ws);
  if (!away?.hub) return null;
  const b = binding.readHubBinding(paths.getStateDir());
  return {
    name: away.name,
    origin: away.hub.origin,
    ...(away.hub.company ? { company: away.hub.company } : {}),
    ...(b?.origin
      ? {
          now: {
            origin: b.origin,
            ...(b.company ? { company: b.company } : {}),
          },
        }
      : {}),
  };
}

async function defaultName(ws: string): Promise<string> {
  const [w, n] = await Promise.all([
    import("../../shared/environment-manager/workspaces.js"),
    import("../../shared/workspace-name.js"),
  ]);
  try {
    return n.workspaceDisplayName(ws, w.readWorkspacesFile().workspaces[ws]);
  } catch {
    return ws;
  }
}

async function defaultWhoami(): Promise<{
  role?: string;
  company?: string;
} | null> {
  const { hubAndToken } = await import("./hub-sync-service.js");
  const at = await hubAndToken();
  if (!at) return null;
  const hub = await import("../../shared/hub.js");
  const w = await hub.hubWhoami(at.url, at.token);
  return {
    ...(w.role ? { role: w.role } : {}),
    ...(w.company?.name ? { company: w.company.name } : {}),
  };
}

async function defaultCreate(ws: string): Promise<HubCreate | null> {
  const [{ defaultHubCreateDeps }, c] = await Promise.all([
    import("./hub-create-routes.js"),
    import("../../shared/hub/hub-project-create.js"),
  ]);
  const d = await defaultHubCreateDeps();
  if (!d.asked(ws)) return null;
  await c.settleHubCreate(d, ws);
  return d.asked(ws);
}

function defaultPicked(n: number): void {
  void Promise.all([
    import("./hub-link-all-routes.js"),
    import("./notification-service.js"),
  ])
    .then(([la, ns]) => la.pickDone(ns.notificationDeps().store, n))
    .catch(() => undefined);
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
  const picked = over.picked ?? defaultPicked;
  const uncovered = over.uncovered
    ? async (w: string) => over.uncovered!(w)
    : defaultUncovered;

  if (method === "GET" || method === "HEAD") {
    // Issue 271: first what became of a new Hub project asked for it (an
    // allowed one is linked here), then the rest as before.
    const create = await (over.create ?? defaultCreate)(ws).catch(() => null);
    const hub = read(ws);
    const unseen = await uncovered(ws).catch(() => []);
    const shown = over.name
      ? over.name(ws)
      : await defaultName(ws).catch(() => ws);
    const who = await (over.whoami ?? defaultWhoami)().catch(() => null);
    const away = hub
      ? null
      : await Promise.resolve(
          over.elsewhere ? over.elsewhere(ws) : defaultElsewhere(ws),
        ).catch(() => null);
    const more = {
      ...(away ? { elsewhere: away } : {}),
      name: shown,
      owner: who?.role ? who.role === "owner" : null,
      company: who?.company ?? null,
      create,
    };
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
        pick: !hub && !!c && "unclear" in hubMatchOf(c.suggestions),
        ...more,
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
        pick: false,
        ...more,
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
  // Issue 167: unlinked and unclear before: this link is a person's pick.
  const wasPick = !read(ws) && "unclear" in hubMatchOf(c.suggestions);
  write(ws, link, by);
  changed();
  if (wasPick) picked(1);
  sendJson(res, { ok: true, project: ws, hub: link });
  return true;
}
