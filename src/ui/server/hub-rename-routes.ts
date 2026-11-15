/**
 * Issue 167 (mock v6 A2, A3): POST /api/workspaces/:ws/hub-rename {name}.
 * A project linked to Hub shows Hub's name, so Den never renames it here:
 * it asks Hub for a held rename of the linked Hub project (Hub's POST
 * /api/projects/plan, with this install's token), and a person decides it
 * in Hub. The ask is kept next to the link ({to, held, url, askedAt},
 * hub_rename) and shown until a sync brings that name.
 *
 *   → { ok, project, pending }   asked; nothing else changed
 *   400 an empty, too long or unchanged name; 404 no such project;
 *   409 not linked, or this install isn't connected to Hub;
 *   502 Hub refused it or didn't answer (its words); nothing is kept.
 *
 * A person's only. Withdraw waits on mo-den-hub issue 72 (Hub has no API
 * to take a held change back yet).
 */
import type * as http from "http";
import type {
  HubProjectLink,
  HubRename,
} from "../../shared/hub-project-link.js";
import { WORKSPACE_NAME_MAX } from "../../shared/workspace-name.js";
import { readBody, sendJson } from "./http-helpers.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
} from "./request-guard.js";

export const HUB_RENAME_ROUTE = /^\/api\/workspaces\/([^/]+)\/hub-rename$/;

/** The longest name Settings takes (the Name row's own limit). */
const NAME_MAX = Math.min(60, WORKSPACE_NAME_MAX);

export interface HubRenameRouteDeps {
  exists: (ws: string) => boolean;
  read: (ws: string) => HubProjectLink | null;
  /** Hub's held change; null: this install isn't connected to Hub. */
  plan: (ask: {
    project: string;
    name: string;
    reason: string;
  }) => Promise<{ held: string; state: string; url?: string } | null>;
  write: (ws: string, r: HubRename | null, by?: string) => void;
  now?: () => Date;
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export async function hubRenameRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  wsRaw: string,
  d: HubRenameRouteDeps,
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
          "Asking Hub to rename a project is a person's ask; an agent can't.",
      },
      403,
    );
    return true;
  }
  if (!d.exists(ws)) {
    sendJson(res, { ok: false, error: `there is no project "${ws}"` }, 404);
    return true;
  }
  let name = "";
  try {
    const raw = await readBody(req);
    const b = (raw ? JSON.parse(raw) : {}) as { name?: unknown };
    name = typeof b.name === "string" ? b.name.replace(/\s+/g, " ").trim() : "";
  } catch {
    sendJson(res, { ok: false, error: "the body must be JSON" }, 400);
    return true;
  }
  const link = d.read(ws);
  if (!link) {
    sendJson(
      res,
      {
        ok: false,
        error: `"${ws}" isn't linked to a Hub project; rename it in Den.`,
      },
      409,
    );
    return true;
  }
  if (!name || name.length > NAME_MAX || name === link.name) {
    sendJson(
      res,
      {
        ok: false,
        error: `name: 1 to ${NAME_MAX} characters, not the name it has now`,
      },
      400,
    );
    return true;
  }
  let held: Awaited<ReturnType<HubRenameRouteDeps["plan"]>>;
  try {
    held = await d.plan({
      project: link.slug,
      name,
      reason: `Asked in Den, Settings › Project setup › Name, for "${ws}"`,
    });
  } catch (e) {
    sendJson(res, { ok: false, error: (e as Error).message }, 502);
    return true;
  }
  if (!held) {
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
  const pending: HubRename = {
    to: name,
    held: held.held,
    ...(held.url ? { url: held.url } : {}),
    askedAt: (d.now?.() ?? new Date()).toISOString(),
  };
  d.write(
    ws,
    pending,
    `Settings › Name, asked Hub (${principalOf(req) ?? "person"})`,
  );
  sendJson(res, { ok: true, project: ws, pending });
  return true;
}

/** The deps on this install: its projects, its links, Hub with its token. */
export async function defaultHubRenameDeps(): Promise<HubRenameRouteDeps> {
  const [link, w] = await Promise.all([
    import("../../shared/hub-project-link.js"),
    import("../../shared/environment-manager/workspaces.js"),
  ]);
  return {
    exists: (ws) => {
      try {
        return Boolean(w.readWorkspacesFile().workspaces[ws]);
      } catch {
        return false;
      }
    },
    read: (ws) => link.hubProjectOf(ws),
    plan: async (ask) => {
      const { hubAndToken } = await import("./hub-sync-service.js");
      const at = await hubAndToken();
      if (!at) return null;
      const hub = await import("../../shared/hub.js");
      return hub.hubPlanRename(at.url, at.token, ask);
    },
    write: (ws, r, by) => link.setHubRename(ws, r, by),
  };
}
