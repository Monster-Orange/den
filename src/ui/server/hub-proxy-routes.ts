/**
 * D52: Den's proxy to Hub, for agents. An agent calls Hub through Den
 * (`/hub/<path>` on Den's own port) with its own Den token; Den attaches
 * the install's Hub token and who is calling, from its own records. The
 * install token never reaches an agent: not its env, its files, its MCP
 * config or its CLI's output.
 *
 *   - Only an agent's actor token (SEC-1c) gets through. A person's token
 *     or a browser gets 403: a person uses Hub itself.
 *   - Only Hub's agent paths: HUB_PROXY_PATHS. Anything else is a 404, so
 *     an agent can't reach Hub's Settings, members or browser routes
 *     through Den. Hub's file links (/f/*) are GET and HEAD only (405).
 *   - The agent's own Authorization and any X-Den-* header it sent are
 *     dropped. Den sets Authorization (the agent's own Hub token, bound to
 *     it on Hub, else the install's: issue 249), X-Den-Agent,
 *     X-Den-Agent-Id, X-Den-Workspace, X-Den-Session, X-Den-Repos and X-Den-Project.
 *   - Redirects are not followed; Hub's status and body pass through as
 *     they are (its 413 says its own limit). Bodies stream both ways, with
 *     no size of Den's own: Hub enforces its limits.
 */
import * as http from "http";
import * as https from "https";
import { agentPrincipalOf } from "./request-guard.js";
import { pathMatches } from "./route-classes.js";
import { sendJson } from "./http-helpers.js";

export const HUB_PROXY_PREFIX = "/hub";
const HUB_CALLBACK = "/hub/callback";

/** Hub's paths an agent reaches through Den (Hub's own list). */
export const HUB_PROXY_PATHS: readonly string[] = [
  "/mcp",
  "/api/inbox",
  "/api/notifications",
  "/api/notifications/*",
  "/api/import/packs",
  "/api/import/packs/*",
  "/api/import/ds/*",
  "/api/reports/*",
  "/api/admin/fixtures/*",
  "/api/admin/fold/*",
  // den#49: an artifact's version as files (hub put / hub pull).
  "/api/artifacts/*",
  // Hub's file links: reads only (READ_ONLY_PATHS).
  "/f/*",
];

/** Hub paths an agent may only read (GET, HEAD): Hub serves nothing else there. */
const READ_ONLY_PATHS: readonly string[] = ["/f/*"];

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE"]);

/** The request headers that go to Hub (the rest stay here). */
const FORWARD = [
  "accept",
  "content-type",
  "content-length",
  "transfer-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

/** The response headers that come back. */
const BACK = [
  "content-type",
  "content-length",
  "cache-control",
  "mcp-session-id",
  "retry-after",
  "location",
];

export interface HubUpstream {
  base: string;
  mcpUrl: string;
  headers: Record<string, string>;
}

export interface HubProxyDeps {
  /** Hub for this agent, or null when it isn't set up. */
  upstream: (who: {
    agentId: string;
    workspace: string;
    session: string;
  }) => Promise<HubUpstream | null>;
  /**
   * An agent's MCP initialize (a POST to /mcp with no Mcp-Session-Id) and
   * what it got: whoami reports a failed one (hub-mcp-connect.ts).
   */
  onMcpInit?: (agentId: string, o: { ok: boolean; error?: string }) => void;
  /**
   * 0.4.48: each answer an agent got for Hub path `sub`: Hub's status, or
   * null with why when Den didn't reach Hub. Den re-reads its token on a
   * 401 and keeps the agent's note (hub-mcp.json) live.
   */
  onHubAnswer?: (
    agentId: string,
    o: { sub: string; status: number | null; error?: string },
  ) => void;
  /**
   * 0.4.48: why Hub isn't there when it is set up but its token can't be
   * read now, in plain words; null when it simply isn't connected.
   */
  whyNotConnected?: () => string | null;
}

/**
 * The Hub path under /hub, or null for a path that isn't the proxy's.
 * /hub/callback is Den's own (Connect's return, agent-routes.ts).
 */
export function hubProxyPath(pathname: string): string | null {
  if (!pathname.startsWith("/hub/") || pathname === HUB_CALLBACK) return null;
  return pathname.slice(HUB_PROXY_PREFIX.length);
}

/** Whether Hub path `sub` is one an agent may reach. */
export function hubProxyAllowed(sub: string): boolean {
  // No dot segments or encoded slashes: the path Hub sees is the one checked.
  if (/(^|\/)\.\.?(\/|$)|%2f|%5c|\\/i.test(sub)) return false;
  // NT-6: marking the person's Hub notifications read is the person's
  // (Den's bell does it with the install's own call); never an agent's.
  if (/^\/api\/notifications(\/[^/]+)?\/read\/?$/i.test(sub)) return false;
  return HUB_PROXY_PATHS.some((r) => pathMatches(r, sub));
}

/** Handle `/hub/*`; false for any other path. */
export async function handleHubProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: HubProxyDeps,
): Promise<boolean> {
  const sub = hubProxyPath(pathname);
  if (sub === null) return false;
  const method = (req.method ?? "GET").toUpperCase();
  const p = agentPrincipalOf(req);
  if (!p) {
    sendJson(
      res,
      {
        error:
          "Hub through Den is for agents, with their own Den token. A person opens Hub itself.",
        code: "agents_only",
      },
      403,
    );
    return true;
  }
  if (!hubProxyAllowed(sub) || !METHODS.has(method)) {
    sendJson(res, { error: `Den doesn't pass ${sub} to Hub.` }, 404);
    return true;
  }
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    READ_ONLY_PATHS.some((r) => pathMatches(r, sub))
  ) {
    sendJson(
      res,
      { error: `Den passes only GET and HEAD for ${sub} to Hub.` },
      405,
    );
    return true;
  }
  const agentId = p.actor.slice("agent:".length);
  const init =
    sub === "/mcp" && method === "POST" && !req.headers["mcp-session-id"];
  const answered = (status: number | null, error?: string) => {
    if (!deps.onHubAnswer) return;
    try {
      deps.onHubAnswer(agentId, {
        sub,
        status,
        ...(error !== undefined ? { error } : {}),
      });
    } catch {
      // A note never changes the agent's answer.
    }
  };
  const noteInit = (ok: boolean, error?: string) => {
    if (!init || !deps.onMcpInit) return;
    try {
      deps.onMcpInit(
        agentId,
        ok ? { ok } : { ok, ...(error ? { error } : {}) },
      );
    } catch {
      // A note never changes the agent's answer.
    }
  };
  const up = await deps
    .upstream({
      agentId,
      workspace: p.workspace,
      session: p.session.id ?? p.session.name,
    })
    .catch(() => null);
  const why = up ? null : (deps.whyNotConnected?.() ?? null);
  if (!up && why) {
    noteInit(false, "Den couldn't read its Hub token");
    answered(null, why);
    sendJson(
      res,
      {
        error: `${why}. Hub is still connected: nothing for the person to do, and no need to reconnect. Try this call again after that.`,
        code: "hub_token_unreadable",
      },
      503,
    );
    return true;
  }
  if (!up) {
    noteInit(false, "hub isn't connected here");
    answered(null, "hub isn't connected here");
    sendJson(
      res,
      {
        error:
          "Hub isn't connected here. The person connects it in Settings › Hub.",
        code: "hub_not_connected",
      },
      503,
    );
    return true;
  }
  const query = new URL(req.url ?? "/", "http://localhost").search;
  const target = new URL(
    sub === "/mcp" ? up.mcpUrl : `${up.base.replace(/\/+$/, "")}${sub}`,
  );
  if (sub !== "/mcp") target.search = query;
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    noteInit(false, "hub's address isn't http(s)");
    answered(null, "hub's address isn't http(s)");
    sendJson(res, { error: "Hub's address isn't http(s)." }, 502);
    return true;
  }
  const headers: Record<string, string | string[]> = {};
  for (const h of FORWARD) {
    const v = req.headers[h];
    if (v !== undefined) headers[h] = v;
  }
  // Den's, last: the agent's own Authorization and X-Den-* never pass.
  Object.assign(headers, up.headers);
  const lib = target.protocol === "https:" ? https : http;
  await new Promise<void>((resolve) => {
    const out = lib.request(target, { method, headers }, (hubRes) => {
      const back: Record<string, string | string[]> = {};
      for (const h of BACK) {
        const v = hubRes.headers[h];
        if (v !== undefined) back[h] = v;
      }
      if (/^text\/event-stream/i.test(String(back["content-type"] ?? "")))
        back["x-accel-buffering"] = "no";
      const status = hubRes.statusCode ?? 502;
      answered(status);
      noteInit(
        status >= 200 && status < 300,
        `hub (${status}): ${http.STATUS_CODES[status] ?? "error"}`,
      );
      res.writeHead(status, back);
      res.flushHeaders?.();
      hubRes.pipe(res);
      hubRes.on("end", resolve);
      hubRes.on("error", () => {
        res.destroy();
        resolve();
      });
    });
    out.on("error", () => {
      if (!res.headersSent) noteInit(false, "hub didn't answer");
      if (!res.headersSent) answered(null, "hub didn't answer");
      if (!res.headersSent)
        sendJson(
          res,
          { error: "Hub didn't answer.", code: "hub_unreachable" },
          502,
        );
      else res.destroy();
      resolve();
    });
    // The agent went away: so does the call to Hub.
    res.on("close", () => {
      if (!res.writableFinished) out.destroy();
      resolve();
    });
    if (method === "GET" || method === "HEAD") out.end();
    else req.pipe(out);
  });
  return true;
}
