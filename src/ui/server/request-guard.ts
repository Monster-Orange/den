/**
 * SEC-1a (SEC-1 spec §3): the checks every request passes before any route.
 *
 *  - Host allowlist (DNS rebinding): `localhost`, `127.0.0.1` and `[::1]`
 *    with the server's port, plus the edge hostnames that route to Den.
 *    Anything else: 421 `misdirected`.
 *  - Credential: `Authorization: Bearer den_pt_…` (the person token, §5).
 *    A bearer that doesn't verify: 401 `unauthorized`.
 *  - Origin, on POST/PUT/PATCH/DELETE and every WebSocket upgrade: an
 *    allowed host (http or https). No Origin needs a valid bearer.
 *    Otherwise 403 `origin_rejected`.
 *  - CSRF: a browser mutation (Origin, no bearer) carries `X-Den-CSRF`
 *    with the token `GET /api/session` hands out. Otherwise 403 `csrf`.
 *
 * GETs, pages and SSE streams pass with only the Host check (§6), except
 * the GETs route-classes.ts marks `mutating` or `shell-grade` (a run, a
 * service's lifecycle command): same-origin only, or a CLI's bearer.
 * Seams: SEC-1b adds the session cookie (`principal` gains it, and `via`
 * says whether the request came through the edge); SEC-1c adds agent
 * tokens beside the person token in `verifyBearer`.
 */
import { randomBytes, timingSafeEqual, createHash } from "crypto";
import type * as http from "http";
import { isMutatingGet } from "./route-classes.js";

export const CSRF_HEADER = "x-den-csrf";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Who a request proved itself to be. */
export type Principal =
  | { kind: "person"; actor: `person:${string}` }
  | { kind: "person-browser" };

export interface GuardContext {
  /** The server's own port. */
  port: number;
  /** Loopback names accepted with the port (lowercase, IPv6 bracketed). */
  loopbackNames: readonly string[];
  /** Edge hostnames that route to Den (lowercase), any port. */
  edgeHosts: () => readonly string[];
  /** The actor a bearer token proves, or null when it doesn't verify. */
  verifyBearer: (token: string) => `person:${string}` | null;
  /** This server start's CSRF token. */
  csrfToken: string;
}

export type GuardResult =
  | {
      ok: true;
      principal: Principal | null;
      /** How the request reached Den (SEC-1b: the edge is beyond loopback). */
      via: "loopback" | "edge";
    }
  | {
      ok: false;
      status: 401 | 403 | 421;
      code:
        | "misdirected"
        | "unauthorized"
        | "origin_rejected"
        | "csrf"
        | "cross_site";
      error: string;
    };

/** A fresh per-start CSRF token. */
export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/** `host[:port]` → { name, port }; IPv6 names keep their brackets. */
export function parseHostHeader(
  raw: string,
): { name: string; port: number | null } | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(v);
  if (!m) return null;
  return {
    name: m[1].replace(/\.$/, ""),
    port: m[2] === undefined ? null : Number(m[2]),
  };
}

/** Where an allowed Host reaches Den from, or null when it isn't allowed. */
export function hostAllowed(
  raw: string | undefined,
  ctx: Pick<GuardContext, "port" | "loopbackNames" | "edgeHosts">,
): "loopback" | "edge" | null {
  if (!raw) return null;
  const h = parseHostHeader(raw);
  if (!h) return null;
  if (ctx.loopbackNames.includes(h.name) && h.port === ctx.port)
    return "loopback";
  if (ctx.edgeHosts().includes(h.name)) return "edge";
  return null;
}

/** The Origin header's host, when it is http(s) and an allowed host. */
export function originAllowed(
  raw: string | undefined,
  ctx: Pick<GuardContext, "port" | "loopbackNames" | "edgeHosts">,
): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password || (u.pathname && u.pathname !== "/"))
    return false;
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return hostAllowed(`${u.hostname}:${port}`, ctx) !== null;
}

function same(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** A WebSocket (or any) upgrade request. */
export function isUpgrade(req: http.IncomingMessage): boolean {
  return header(req, "upgrade") !== undefined;
}

export function checkRequest(
  req: http.IncomingMessage,
  ctx: GuardContext,
  cli = "den",
): GuardResult {
  const via = hostAllowed(header(req, "host"), ctx);
  if (!via)
    return {
      ok: false,
      status: 421,
      code: "misdirected",
      error:
        "This server answers only to its own host names (localhost, " +
        "127.0.0.1, [::1] with its port, or its edge hostname).",
    };

  let principal: Principal | null = null;
  const auth = header(req, "authorization");
  const bearer = auth ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
  if (bearer) {
    const actor = ctx.verifyBearer(bearer[1]);
    if (!actor)
      return {
        ok: false,
        status: 401,
        code: "unauthorized",
        error: `The bearer token is not valid here; \`${cli} web token --print\` prints the current one.`,
      };
    principal = { kind: "person", actor };
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (!MUTATING.has(method) && !isUpgrade(req)) {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (isMutatingGet(method, pathname)) {
      const refused = mutatingGetRefusal(req, ctx, principal, cli);
      if (refused) return refused;
    }
    return { ok: true, principal, via };
  }

  const origin = header(req, "origin");
  if (origin === undefined) {
    if (principal) return { ok: true, principal, via };
    return {
      ok: false,
      status: 403,
      code: "origin_rejected",
      error:
        "A request that changes something needs an Origin from this server, " +
        `or \`Authorization: Bearer $(${cli} web token --print)\`.`,
    };
  }
  if (!originAllowed(origin, ctx))
    return {
      ok: false,
      status: 403,
      code: "origin_rejected",
      error: "Requests from another site can't change anything here.",
    };
  // A valid bearer is a CLI's or an agent's call: no CSRF to prove.
  if (principal) return { ok: true, principal, via };
  const csrf = header(req, CSRF_HEADER);
  if (!csrf || !same(csrf, ctx.csrfToken))
    return {
      ok: false,
      status: 403,
      code: "csrf",
      error:
        "The request is missing this page's CSRF token; reload the page and try again.",
    };
  return { ok: true, principal: { kind: "person-browser" }, via };
}

/**
 * A GET that runs or changes something (route-classes.ts: `mutating` or
 * `shell-grade`; they stream over GET because an EventSource can't POST or
 * send a header). A cross-site `<img src>` or `fetch(…, { mode: "no-cors" })`
 * is a GET too, so these pass only:
 *  - from this server's own pages: Sec-Fetch-Site same-origin (or none, a
 *    URL the person typed), and an Origin, if any, that is allowed;
 *  - or with neither header (the CLI, curl, MCP) and a valid bearer.
 * Sec-Fetch-Site same-site or cross-site: 403 `cross_site` (another port on
 * localhost is same-site, not same-origin).
 */
function mutatingGetRefusal(
  req: http.IncomingMessage,
  ctx: GuardContext,
  principal: Principal | null,
  cli: string,
): Extract<GuardResult, { ok: false }> | null {
  const site = header(req, "sec-fetch-site");
  const origin = header(req, "origin");
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return {
      ok: false,
      status: 403,
      code: "cross_site",
      error: "Another site can't start or change anything here.",
    };
  if (origin !== undefined && !originAllowed(origin, ctx))
    return {
      ok: false,
      status: 403,
      code: "origin_rejected",
      error: "Requests from another site can't start or change anything here.",
    };
  if (site === undefined && origin === undefined && !principal)
    return {
      ok: false,
      status: 403,
      code: "origin_rejected",
      error:
        "This request runs something: it needs this server's own page, or " +
        `\`Authorization: Bearer $(${cli} web token --print)\`.`,
    };
  return null;
}

/**
 * `GET /api/session` answers only a same-origin caller: no Origin or an
 * allowed one, and no cross-site Sec-Fetch-Site.
 */
export function sessionRequestAllowed(
  req: http.IncomingMessage,
  ctx: Pick<GuardContext, "port" | "loopbackNames" | "edgeHosts">,
): boolean {
  const origin = header(req, "origin");
  if (origin !== undefined && !originAllowed(origin, ctx)) return false;
  const site = header(req, "sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}

const PRINCIPALS = new WeakMap<http.IncomingMessage, Principal>();

/** Remember what the request proved (for the audit trail). */
export function setPrincipal(
  req: http.IncomingMessage,
  p: Principal | null,
): void {
  if (p) PRINCIPALS.set(req, p);
}

/**
 * The audit actor the request's credential proves: `person:<user>` for a
 * person token, never anything a header the caller sets claims. Undefined
 * for a browser call (SEC-1a has no browser credential yet).
 */
export function principalOf(req: http.IncomingMessage): string | undefined {
  const p = PRINCIPALS.get(req);
  return p?.kind === "person" ? p.actor : undefined;
}
