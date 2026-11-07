/**
 * SEC-2a's routes: Sign in with GitHub (the signed-out page), the owner's
 * link (Settings › Access, `web owner …`), and Pair a device.
 *
 *   POST /api/github/signin            start a sign-in (sign-in free; an
 *                                      allowed Origin, no CSRF token)
 *   GET  /api/github/signin/<id>       its outcome; approved by the owner:
 *                                      the session cookie, once
 *   GET  /api/web/owner                who the owner is
 *   POST /api/web/owner/link           start linking the owner (shell-grade)
 *   GET  /api/web/owner/link/<id>      its code and outcome
 *   POST /api/web/owner/unlink         unlink the owner (shell-grade)
 *   GET  /api/web/pair                 the edge hostnames a link can be for
 *   POST /api/web/pair { host }        a one-time sign-in link for one
 *
 * The token GitHub hands back is used once, for `GET /user`, and dropped
 * (device-flows.ts). Nothing here logs a code, a token or a cookie.
 */
import type * as http from "http";
import { githubPrincipal } from "../../shared/github-device.js";
import {
  clearWebOwner,
  readWebOwner,
  writeWebOwner,
} from "../../shared/web-owner.js";
import type { DeviceFlows, FlowView } from "./device-flows.js";

export interface GithubRouteDeps {
  flows: DeviceFlows;
  /** The configured client id ("" when none). */
  clientId: () => string;
  /** The app issued an expiring token (its token expiry is on): a misconfiguration. */
  tokensExpire?: () => boolean;
  cli: string;
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  /** A new browser session for this request; its Set-Cookie line. */
  signIn: (
    req: http.IncomingMessage,
    via: "github" | "link",
    login?: string,
  ) => string;
  /** The edge hostnames that route here, and the URL a browser uses for each. */
  edgeRoutes: () => { host: string; url: string }[];
  /** A one-time sign-in link at `origin` (60 s), or null with no secret. */
  mintLink: (origin: string) => { url: string; expiresAt: number } | null;
  log: (line: string) => void;
  /** Where the owner file lives (the server's state dir). */
  stateDir: () => string;
}

const SIGNIN_PATH = /^\/api\/github\/signin\/([A-Za-z0-9_-]{16,64})$/;
const LINK_PATH = /^\/api\/web\/owner\/link\/([A-Za-z0-9_-]{16,64})$/;

/** What an identity means for a flow: the owner's sign-in, or the owner's link. */
export function decideFlow(
  stateDir: () => string,
  log: (line: string) => void,
): (
  purpose: "signin" | "link",
  identity: { id: number; login: string },
) => "ok" | "refused" {
  return (purpose, identity) => {
    const owner = readWebOwner(stateDir());
    if (purpose === "signin") {
      const ok = owner?.owner === githubPrincipal(identity.id);
      log(
        ok
          ? `  ✓ signed in with GitHub (@${identity.login})`
          : `  ✗ GitHub sign-in refused: @${identity.login} isn't this Den's owner`,
      );
      return ok ? "ok" : "refused";
    }
    if (owner) return "refused";
    writeWebOwner(identity, stateDir());
    log(`  ✓ owner linked: @${identity.login}`);
    return "ok";
  };
}

/** A flow as the page sees it: the code and where to enter it, while it waits. */
function flowJson(v: FlowView): Record<string, unknown> {
  return {
    id: v.id,
    state: v.state,
    ...(v.state === "pending"
      ? {
          userCode: v.userCode,
          verificationUri: v.verificationUri,
          expiresAt: new Date(v.expiresAt).toISOString(),
        }
      : {}),
    ...(v.login ? { login: v.login } : {}),
  };
}

function finishedMessage(v: FlowView, cli: string): string | undefined {
  switch (v.state) {
    case "refused":
      return v.purpose === "signin"
        ? `@${v.login} isn't allowed on this Den. Ask the owner to add you.`
        : `An owner is linked already; \`${cli} web owner unlink\` first.`;
    case "expired":
      return "The code expired before it was approved. Start again.";
    case "denied":
      return "The request was cancelled on GitHub.";
    case "error":
      return v.message ?? "GitHub couldn't be reached.";
    default:
      return undefined;
  }
}

async function startFlow(
  deps: GithubRouteDeps,
  res: http.ServerResponse,
  purpose: "signin" | "link",
): Promise<void> {
  let r;
  try {
    r = await deps.flows.start(purpose);
  } catch (e) {
    return deps.sendJson(
      res,
      { ok: false, code: "github_unreachable", error: (e as Error).message },
      502,
    );
  }
  if ("error" in r)
    return r.error === "busy"
      ? deps.sendJson(
          res,
          {
            ok: false,
            code: "busy",
            error:
              "Too many GitHub sign-ins are in progress. Try again in a few minutes.",
          },
          429,
        )
      : deps.sendJson(
          res,
          {
            ok: false,
            code: "no_client_id",
            error: `Sign in with GitHub needs a GitHub App client id: set web.github_client_id in config/local/user.yml and restart (\`${deps.cli} web restart\`).`,
          },
          409,
        );
  return deps.sendJson(res, { ok: true, ...flowJson(r) });
}

/** Whether `pathname` is one of these routes' (index.ts dispatches them here). */
export function isGithubRoute(pathname: string): boolean {
  return /^\/api\/(github\/|web\/owner(\/|$)|web\/pair$)/.test(pathname);
}

/** Handles a SEC-2a route; false when `pathname` is none of them. */
export async function handleGithubRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: GithubRouteDeps,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  res.setHeader("Cache-Control", "no-store");

  // ── Sign in with GitHub ──────────────────────────────────────────────
  if (pathname === "/api/github/signin" && method === "POST") {
    if (!readWebOwner(deps.stateDir())) {
      deps.sendJson(
        res,
        {
          ok: false,
          code: "no_owner",
          error: `This Den has no owner yet. On the machine it runs on, run \`${deps.cli} web owner link\`.`,
        },
        409,
      );
      return true;
    }
    await startFlow(deps, res, "signin");
    return true;
  }
  const s = SIGNIN_PATH.exec(pathname);
  if (s && (method === "GET" || method === "HEAD")) {
    const v = deps.flows.get(s[1], "signin");
    if (!v) {
      deps.sendJson(
        res,
        {
          ok: false,
          state: "gone",
          code: "not_found",
          error: "That sign-in ended. Start again.",
        },
        404,
      );
      return true;
    }
    if (v.state === "ok") {
      if (!deps.flows.claim(v.id, "signin")) {
        deps.sendJson(res, { ok: false, state: "gone" }, 404);
        return true;
      }
      res.setHeader("Set-Cookie", deps.signIn(req, "github", v.login));
      deps.sendJson(res, { ok: true, state: "ok", login: v.login });
      return true;
    }
    const message = finishedMessage(v, deps.cli);
    deps.sendJson(res, {
      ok: v.state === "pending",
      ...flowJson(v),
      ...(message ? { error: message } : {}),
    });
    return true;
  }

  // ── The owner ────────────────────────────────────────────────────────
  if (pathname === "/api/web/owner" && method === "GET") {
    const o = readWebOwner(deps.stateDir());
    deps.sendJson(res, {
      owner: o ? { id: o.owner, login: o.login, linkedAt: o.linkedAt } : null,
      clientId: deps.clientId() !== "",
      // The app's "Expire user authorization tokens" is on (seen since start).
      tokenExpiry: deps.tokensExpire?.() ?? false,
    });
    return true;
  }
  if (pathname === "/api/web/owner/link" && method === "POST") {
    const o = readWebOwner(deps.stateDir());
    if (o) {
      deps.sendJson(
        res,
        {
          ok: false,
          code: "already_linked",
          error: `This Den's owner is @${o.login} already; unlink first (\`${deps.cli} web owner unlink\`).`,
        },
        409,
      );
      return true;
    }
    await startFlow(deps, res, "link");
    return true;
  }
  const l = LINK_PATH.exec(pathname);
  if (l && (method === "GET" || method === "HEAD")) {
    const v = deps.flows.get(l[1], "link");
    if (!v) {
      deps.sendJson(res, { ok: false, state: "gone", code: "not_found" }, 404);
      return true;
    }
    if (v.state === "ok") deps.flows.claim(v.id, "link");
    const message = finishedMessage(v, deps.cli);
    deps.sendJson(res, {
      ok: v.state === "pending" || v.state === "ok",
      ...flowJson(v),
      ...(message ? { error: message } : {}),
    });
    return true;
  }
  if (pathname === "/api/web/owner/unlink" && method === "POST") {
    const was = clearWebOwner(deps.stateDir());
    if (was) deps.log(`  owner unlinked (was @${was.login})`);
    deps.sendJson(res, { ok: true, was: was ? was.login : null });
    return true;
  }

  // ── Pair a device ────────────────────────────────────────────────────
  if (pathname === "/api/web/pair" && method === "GET") {
    deps.sendJson(res, { hosts: deps.edgeRoutes().map((r) => r.host) });
    return true;
  }
  if (pathname === "/api/web/pair" && method === "POST") {
    let body: { host?: unknown } = {};
    try {
      body = (JSON.parse((await deps.readBody(req)) || "{}") ??
        {}) as typeof body;
    } catch {
      deps.sendJson(
        res,
        { ok: false, error: "the body must be JSON: { host }" },
        400,
      );
      return true;
    }
    const want = String(body.host ?? "")
      .trim()
      .toLowerCase();
    const routes = deps.edgeRoutes();
    const hit = routes.find((r) => r.host === want);
    if (!hit) {
      deps.sendJson(
        res,
        {
          ok: false,
          code: "unknown_host",
          error: routes.length
            ? `${want || "(none)"} isn't an edge hostname that routes here (${routes.map((r) => r.host).join(", ")}).`
            : "No edge hostname routes to this server: add one to edge.routes or edge.aliases, then `edge up`.",
        },
        400,
      );
      return true;
    }
    const link = deps.mintLink(hit.url);
    if (!link) {
      deps.sendJson(res, { ok: false, error: "web.secret is missing" }, 500);
      return true;
    }
    deps.sendJson(res, {
      ok: true,
      host: hit.host,
      url: link.url,
      expiresAt: new Date(link.expiresAt).toISOString(),
    });
    return true;
  }
  return false;
}
