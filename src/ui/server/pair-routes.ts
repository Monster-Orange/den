/**
 * SEC-2a's approve-with-a-code routes (pair-requests.ts):
 *
 *   POST /api/signin/code          a new request (sign-in free; an allowed
 *                                  Origin, no CSRF token: the signed-out
 *                                  page holds none). Its poll id, code,
 *                                  expiry, and the commands that approve it
 *   GET  /api/signin/code/<id>     its state; approved: the session cookie,
 *                                  once (the request is consumed)
 *   GET  /api/web/waiting          the requests waiting (shell-grade)
 *   POST /api/web/approve {code}   approve one (shell-grade: `<cli> web
 *                                  approve`, Settings › Access)
 *   POST /api/web/deny {code}      deny one (shell-grade)
 *
 * Approve and deny are audited with the actor; neither the code nor the
 * poll id is logged.
 */
import type * as http from "http";
import type { PairRequests, PairView } from "./pair-requests.js";

export interface PairRouteDeps {
  pairs: PairRequests;
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  /** A new browser session for this request (via "code"): its Set-Cookie line and approval key. */
  signIn: (req: http.IncomingMessage) => { cookie: string; approveKey: string };
  /** The client's address for a new request's record, when Den knows it. */
  client: (req: http.IncomingMessage) => string | undefined;
  /** The commands that approve `code`: on the server, and by ssh from the browser's machine. */
  commands: (
    req: http.IncomingMessage,
    code: string,
  ) => { approve: string; ssh: string };
  /** Record an approve or deny (who, what, whether it was refused). */
  audit: (
    req: http.IncomingMessage,
    verb: "approve" | "deny",
    detail: string,
    refused?: string,
  ) => void;
}

const POLL_PATH = /^\/api\/signin\/code\/([A-Za-z0-9_-]{16,64})$/;

/** Whether `pathname` is one of these routes' (index.ts dispatches them here). */
export function isPairRoute(pathname: string): boolean {
  return (
    pathname === "/api/signin/code" ||
    POLL_PATH.test(pathname) ||
    pathname === "/api/web/waiting" ||
    pathname === "/api/web/approve" ||
    pathname === "/api/web/deny"
  );
}

function waitingJson(v: PairView): Record<string, unknown> {
  return {
    code: v.code,
    device: v.device,
    ...(v.client ? { client: v.client } : {}),
    createdAt: new Date(v.createdAt).toISOString(),
    expiresAt: new Date(v.expiresAt).toISOString(),
  };
}

const ERRORS: Record<string, { status: number; error: string }> = {
  malformed: {
    status: 400,
    error:
      "That isn't a code: it is six letters and digits, like K7Q-42M (the signed-out page shows it).",
  },
  unknown: {
    status: 404,
    error:
      "No device is waiting with that code. Check the code on the other computer's page; it may have been used or replaced.",
  },
  expired: {
    status: 410,
    error:
      "That code expired. On the other computer, click Get a new code and approve the new one.",
  },
  rate_limited: {
    status: 429,
    error: "Too many approve attempts. Wait a minute and try again.",
  },
};

/** Handles a route here; false when `pathname` is none of them. */
export async function handlePairRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: PairRouteDeps,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  res.setHeader("Cache-Control", "no-store");

  if (pathname === "/api/signin/code" && method === "POST") {
    const r = deps.pairs.create({
      userAgent: req.headers["user-agent"],
      client: deps.client(req),
    });
    deps.sendJson(res, {
      ok: true,
      id: r.id,
      code: r.code,
      expiresAt: new Date(r.expiresAt).toISOString(),
      // What is left, for the page's own countdown (no clock skew).
      expiresIn: Math.max(0, r.expiresAt - Date.now()),
      ...deps.commands(req, r.code),
    });
    return true;
  }
  const p = POLL_PATH.exec(pathname);
  if (p && (method === "GET" || method === "HEAD")) {
    const v = deps.pairs.get(p[1]);
    if (!v) {
      deps.sendJson(
        res,
        {
          ok: false,
          state: "gone",
          code: "not_found",
          error: "That request ended. Get a new code.",
        },
        404,
      );
      return true;
    }
    if (v.state === "approved") {
      if (!deps.pairs.claim(p[1])) {
        deps.sendJson(res, { ok: false, state: "gone" }, 404);
        return true;
      }
      const s = deps.signIn(req);
      res.setHeader("Set-Cookie", s.cookie);
      res.setHeader("Cache-Control", "no-store");
      // The approval key goes to this answer only (web-session.ts).
      deps.sendJson(res, { ok: true, state: "ok", approveKey: s.approveKey });
      return true;
    }
    deps.sendJson(res, {
      ok: v.state === "pending",
      state: v.state,
      expiresAt: new Date(v.expiresAt).toISOString(),
    });
    return true;
  }

  if (
    pathname === "/api/web/waiting" &&
    (method === "GET" || method === "HEAD")
  ) {
    deps.sendJson(res, { waiting: deps.pairs.waiting().map(waitingJson) });
    return true;
  }

  if (
    (pathname === "/api/web/approve" || pathname === "/api/web/deny") &&
    method === "POST"
  ) {
    const verb = pathname === "/api/web/approve" ? "approve" : "deny";
    let body: { code?: unknown } = {};
    try {
      body = (JSON.parse((await deps.readBody(req)) || "{}") ??
        {}) as typeof body;
    } catch {
      deps.sendJson(
        res,
        {
          ok: false,
          code: "bad_request",
          error: "the body must be JSON: { code }",
        },
        400,
      );
      return true;
    }
    const r =
      verb === "approve"
        ? deps.pairs.approve(String(body.code ?? ""))
        : deps.pairs.deny(String(body.code ?? ""));
    if (!r.ok) {
      const e = ERRORS[r.error];
      deps.audit(req, verb, "a waiting device", e.error);
      deps.sendJson(
        res,
        { ok: false, code: r.error, error: e.error },
        e.status,
      );
      return true;
    }
    const who = [r.request.device, r.request.client].filter(Boolean).join(", ");
    deps.audit(req, verb, `a waiting device (${who})`);
    deps.sendJson(res, { ok: true, ...waitingJson(r.request) });
    return true;
  }
  return false;
}
