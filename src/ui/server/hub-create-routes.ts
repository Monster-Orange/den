/**
 * Issue 271: POST /api/workspaces/:ws/hub-create {name}. Settings ›
 * Project › Hub project's "Create a Hub project named …": Den asks Hub for
 * a new project with its project plan path (held for an owner in Hub),
 * and keeps the ask next to the project (shared/hub/hub-project-create.ts).
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
} from "../../shared/hub/hub-project-create.js";
import { HUB_PROJECT_NAME_MAX } from "../../shared/hub.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import type { DetailKey, HeldOpCheck } from "../cli/agent-ops.js";
import type { AskedBy } from "./approvals.js";
import { readWorkspacesFile } from "../../shared/environment-manager/workspaces.js";
import {
  hubCreateOf,
  hubProjectOf,
} from "../../shared/hub/hub-project-link.js";
import { workspaceDisplayName } from "../../shared/workspace-name.js";
import { readRecord } from "../../shared/agents/records.js";
import { getStateDir } from "../../shared/paths.js";
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
    import("../../shared/hub/hub-project-link.js"),
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
    import("../../shared/hub/hub-project-link.js"),
    import("../../shared/hub/hub-project-create.js"),
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

/** What the held write's check reads: the projects, their links and asks. */
export type HubCreateLook = Pick<
  HubCreateDeps,
  "exists" | "linked" | "asked"
> & {
  /** The name project `ws` shows (the default name). */
  name: (ws: string) => string;
};

/**
 * Issue 271: hub_project_create's check, for the Allow: the project (a
 * project's agent its own only; Den's own agent any), the name (default:
 * the project's), refused before anyone is asked when the project is
 * linked already (1:1) or has an ask waiting.
 */
export function checkHubCreateHeld(
  s: HubCreateLook,
  a: Record<string, unknown>,
  who: { agent?: string; project?: string } = {},
): HeldOpCheck<{ project: string; name: string }> {
  const no = (error: string) => ({ ok: false as const, error });
  const ws = typeof a.project === "string" ? a.project.trim() : "";
  if (!ws) return no("project: the project to create a Hub project for");
  if (isServerScope(ws))
    return no(`${ws} is Den's own agent's place, not a project`);
  if (!s.exists(ws)) return no(`no project "${ws}"`);
  if (who.project && !isServerScope(who.project) && who.project !== ws)
    return no(
      `${who.agent ?? "this agent"} works in project ${who.project}: it can ask for that project only, not project ${ws}`,
    );
  const linked = s.linked(ws);
  if (linked)
    return no(
      `project ${ws} is already linked to the Hub project ${linked.name}: one Hub project per project`,
    );
  const was = s.asked(ws);
  if (was && !was.outcome)
    return no(
      `Hub has an ask for "${was.name}" for project ${ws} waiting for an owner; Den links it when they allow it`,
    );
  const name = (
    typeof a.name === "string" && a.name.trim() ? a.name : s.name(ws)
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > HUB_PROJECT_NAME_MAX)
    return no(`name: 1 to ${HUB_PROJECT_NAME_MAX} characters`);
  const lines: [string, DetailKey][] = [
    [`Project: ${ws}`, { key: "ap.hc.project", vars: { project: ws } }],
    [`Name in Hub: ${name}`, { key: "ap.hc.name", vars: { name } }],
    [
      "An owner in Hub allows it there; Den links the project to it once they do.",
      { key: "ap.hc.owner" },
    ],
  ];
  return {
    ok: true,
    summary: `ask Hub to create the Hub project ${name} for project ${ws}`,
    params: { project: ws, name },
    details: lines.map(([l]) => l),
    detailKeys: lines.map(([, k]) => k),
    args: { project: ws, name },
  };
}

/**
 * Issue 271: hub_project_create's run, after the Allow (or the policy):
 * the same ask Settings makes (askHubCreate), as the agent that asked, so
 * Hub's push about the owner's decision reaches it.
 */
export async function runHubCreateHeld(
  d: HubCreateDeps,
  a: Record<string, unknown>,
  asked: AskedBy | undefined,
  agentName: (id: string) => string | undefined,
): Promise<unknown> {
  const ws = String(a.project ?? "");
  const id = asked?.agent;
  const r = await askHubCreate(d, {
    ws,
    name: String(a.name ?? ""),
    by: "agent",
    ...(id ? { agent: { id, name: agentName(id) ?? id } } : {}),
    auditBy: `hub_project_create, asked Hub for a new project (${id ?? "agent"})`,
  });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    project: ws,
    ask: r.ask,
    next: `Hub holds it for an owner. When they decide, Hub tells you, and Den links project ${ws} to the new Hub project by itself.`,
  };
}

/** What the held write's check reads on this install; null: unreadable. */
export function hubCreateLook(): HubCreateLook | null {
  try {
    const file = readWorkspacesFile();
    return {
      exists: (ws) => Boolean(file.workspaces[ws]),
      linked: (ws) => hubProjectOf(ws, () => file),
      asked: (ws) => hubCreateOf(ws, () => file),
      name: (ws) => workspaceDisplayName(ws, file.workspaces[ws]),
    };
  } catch {
    return null;
  }
}

/** The name Hub shows for agent `id` (its session's), else none. */
export function agentNameOf(id: string): string | undefined {
  return readRecord(getStateDir(), id)?.sessionName || undefined;
}
