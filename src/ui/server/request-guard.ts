/**
 * SEC-1a and SEC-1b (SEC-1 spec §3, §4): the checks every request passes
 * before any route.
 *
 *  - Host allowlist (DNS rebinding): `localhost`, `127.0.0.1` and `[::1]`
 *    with the server's port, plus the edge hostnames that route to Den, plus
 *    (a non-loopback bind with `web.allow_plain_http_remote`) this
 *    machine's own LAN names with the port. Anything else: 421
 *    `misdirected`.
 *  - Credential: `Authorization: Bearer den_pt_…` (the person token, §5).
 *    A bearer that doesn't verify: 401 `unauthorized`. Or the browser's
 *    session cookie (SEC-1b), looked up server-side.
 *  - Sign-in (§4, route-classes.ts): beyond loopback (the edge hostname, a
 *    LAN name, or a peer that isn't loopback) every route needs a session
 *    or a bearer; on loopback only `shell-grade` routes do. Otherwise 401
 *    `signin_required`. SIGNIN_FREE routes never need one.
 *  - Origin, on POST/PUT/PATCH/DELETE and every WebSocket upgrade: an
 *    allowed host (http or https). No Origin needs a valid bearer.
 *    Otherwise 403 `origin_rejected`.
 *  - CSRF: a browser mutation (Origin, no bearer) carries `X-Den-CSRF`:
 *    the session's token when it is signed in, else (loopback) this server
 *    start's. Both come from `GET /api/session`. Otherwise 403 `csrf`.
 *
 * GETs, pages and SSE streams on loopback pass with only the Host check
 * (§6), except the GETs route-classes.ts marks `mutating` or `shell-grade`
 * (a run, a service's lifecycle command): same-origin only, or a CLI's
 * bearer. Seam: SEC-1c adds agent tokens beside the person token in
 * `verifyBearer`.
 */
import { randomBytes, timingSafeEqual, createHash } from "crypto";
import type * as http from "http";
import * as net from "net";
import {
  isMutatingGet,
  routeClass,
  SIGNIN_FREE,
  type RouteClass,
} from "./route-classes.js";

export const CSRF_HEADER = "x-den-csrf";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Who a request proved itself to be. */
export type Principal =
  | { kind: "person"; actor: `person:${string}` }
  | { kind: "person-browser"; session?: string };

/** What the request checks need of a signed-in browser session. */
export interface GuardSession {
  /** The record's key (never the cookie's value). */
  key: string;
  /** The session's own CSRF token. */
  csrf: string;
}

/** How a request reached Den. `edge` and `lan` are beyond loopback. */
export type Via = "loopback" | "edge" | "lan";

export interface GuardContext {
  /** The server's own port. */
  port: number;
  /** Loopback names accepted with the port (lowercase, IPv6 bracketed). */
  loopbackNames: readonly string[];
  /** Edge hostnames that route to Den (lowercase), any port. */
  edgeHosts: () => readonly string[];
  /**
   * This machine's LAN names, accepted with the port (a non-loopback bind
   * with `web.allow_plain_http_remote` only). Beyond loopback.
   */
  lanHosts?: () => readonly string[];
  /** The actor a bearer token proves, or null when it doesn't verify. */
  verifyBearer: (token: string) => `person:${string}` | null;
  /** This server start's CSRF token (loopback, no session). */
  csrfToken: string;
  /** The live session the request's cookie names (SEC-1b), or null. */
  session?: (req: http.IncomingMessage) => GuardSession | null;
  /**
   * Whether the request's peer is loopback. Unset: taken as loopback (a
   * request object without a socket, in a unit test); the server sets it.
   */
  peerIsLoopback?: (req: http.IncomingMessage) => boolean;
}

export type GuardResult =
  | {
      ok: true;
      principal: Principal | null;
      /** How the request reached Den. */
      via: Via;
      /** Beyond loopback: the edge, a LAN name, or a non-loopback peer. */
      beyond: boolean;
      /** The signed-in session, when the cookie names a live one. */
      session: GuardSession | null;
    }
  | {
      ok: false;
      status: 401 | 403 | 421;
      code:
        | "misdirected"
        | "unauthorized"
        | "signin_required"
        | "origin_rejected"
        | "csrf"
        | "cross_site";
      error: string;
      /** signin_required: why (a shell-grade route on loopback, or beyond loopback). */
      scope?: "terminal" | "den";
      via?: Via;
      beyond?: boolean;
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
  ctx: Pick<GuardContext, "port" | "loopbackNames" | "edgeHosts" | "lanHosts">,
): Via | null {
  if (!raw) return null;
  const h = parseHostHeader(raw);
  if (!h) return null;
  if (ctx.loopbackNames.includes(h.name) && h.port === ctx.port)
    return "loopback";
  if (ctx.edgeHosts().includes(h.name)) return "edge";
  if (h.port === ctx.port && (ctx.lanHosts?.() ?? []).includes(h.name))
    return "lan";
  return null;
}

/** The Origin header's host, when it is http(s) and an allowed host. */
export function originAllowed(
  raw: string | undefined,
  ctx: Pick<GuardContext, "port" | "loopbackNames" | "edgeHosts" | "lanHosts">,
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

/** A loopback IP (127/8, ::1, or either IPv4-mapped). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase().replace(/^::ffff:/, "");
  if (a === "::1") return true;
  return net.isIPv4(a) && a.startsWith("127.");
}

/**
 * A peer the edge's X-Forwarded-Proto is believed from: loopback, or a
 * Docker network (172.16.0.0/12, Docker Desktop's 192.168.65.0/24), where
 * the edge's Traefik runs.
 */
export function isEdgePeer(addr: string | undefined): boolean {
  if (isLoopbackAddress(addr)) return true;
  const a = String(addr ?? "")
    .toLowerCase()
    .replace(/^::ffff:/, "");
  if (!net.isIPv4(a)) return false;
  const [x, y, z] = a.split(".").map(Number);
  return (
    (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168 && z === 65)
  );
}

/**
 * Whether the request came over HTTPS: the socket's own encryption, or,
 * only for the edge hostname from an edge peer, `X-Forwarded-Proto: https`.
 * A spoofed header on a loopback Host never counts.
 */
export function requestIsHttps(
  req: http.IncomingMessage,
  via: Via | null,
): boolean {
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted)
    return true;
  if (via !== "edge" || !isEdgePeer(req.socket?.remoteAddress)) return false;
  const xfp = header(req, "x-forwarded-proto");
  return xfp?.split(",")[0].trim().toLowerCase() === "https";
}

/** A bind address that only this machine can reach. */
export function isLoopbackBind(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "localhost" || isLoopbackAddress(h);
}

/**
 * §4: why a bind may not start, or null. A non-loopback bind needs HTTPS in
 * front (the edge) or `web.allow_plain_http_remote: true`: otherwise a
 * session cookie would cross the network in clear text.
 */
export function bindRefusal(
  bind: string,
  opts: { allowPlainHttpRemote: boolean; fronted: boolean },
): string | null {
  if (isLoopbackBind(bind) || opts.allowPlainHttpRemote || opts.fronted)
    return null;
  return (
    `Refusing to listen on ${bind}: it is reachable beyond this machine, ` +
    "and without HTTPS in front a session cookie would cross the network in " +
    "clear text. Put the edge (edge.tls) in front of this server, or set " +
    "web.allow_plain_http_remote: true in config/local/user.yml to accept that."
  );
}

/** What signin_required says, by why it was asked for. */
export function signinMessage(
  scope: "terminal" | "den",
  cli: string,
  title: string,
): string {
  return (
    (scope === "terminal"
      ? "Sign in to use the terminal: run "
      : `Sign in to use ${title}: run `) +
    `\`${cli} web login\` and open the link.`
  );
}

export function checkRequest(
  req: http.IncomingMessage,
  ctx: GuardContext,
  cli = "den",
  title = "Den",
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
  const peerLoopback = ctx.peerIsLoopback ? ctx.peerIsLoopback(req) : true;
  const beyond = via !== "loopback" || !peerLoopback;

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
  const session = principal ? null : (ctx.session?.(req) ?? null);

  const method = (req.method ?? "GET").toUpperCase();
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const cls: RouteClass =
    routeClass(method, pathname) ??
    (MUTATING.has(method) || isUpgrade(req) ? "mutating" : "readonly");

  // §4: a session (or a bearer) where one is needed.
  if (
    !principal &&
    !session &&
    !SIGNIN_FREE.includes(pathname) &&
    (beyond || cls === "shell-grade")
  ) {
    const scope = beyond ? "den" : "terminal";
    return {
      ok: false,
      status: 401,
      code: "signin_required",
      error: signinMessage(scope, cli, title),
      scope,
      via,
      beyond,
    };
  }
  const ok = (p: Principal | null): GuardResult => ({
    ok: true,
    principal: p,
    via,
    beyond,
    session,
  });
  const browser: Principal | null = session
    ? { kind: "person-browser", session: session.key }
    : null;

  if (!MUTATING.has(method) && !isUpgrade(req)) {
    if (isMutatingGet(method, pathname)) {
      const refused = mutatingGetRefusal(req, ctx, principal, cli);
      if (refused) return refused;
    }
    return ok(principal ?? browser);
  }

  const origin = header(req, "origin");
  if (origin === undefined) {
    if (principal) return ok(principal);
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
  if (principal) return ok(principal);
  const csrf = header(req, CSRF_HEADER);
  // Signed in: the session's own token; else (loopback) this start's.
  const want = session ? session.csrf : ctx.csrfToken;
  if (!csrf || !same(csrf, want))
    return {
      ok: false,
      status: 403,
      code: "csrf",
      error:
        "The request is missing this page's CSRF token; reload the page and try again.",
    };
  return ok(browser ?? { kind: "person-browser" });
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
  ctx: Pick<GuardContext, "port" | "loopbackNames" | "edgeHosts" | "lanHosts">,
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
 * for a browser call (SEC-1c sets the audit actor from a session).
 */
export function principalOf(req: http.IncomingMessage): string | undefined {
  const p = PRINCIPALS.get(req);
  return p?.kind === "person" ? p.actor : undefined;
}
