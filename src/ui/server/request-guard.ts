/**
 * SEC-1a and SEC-1b (SEC-1 spec §3, §4): the checks every request passes
 * before any route.
 *
 *  - Host allowlist (DNS rebinding): `localhost`, `127.0.0.1` and `[::1]`
 *    with the server's port, plus the edge hostnames that route to Den, plus
 *    (a non-loopback bind with `web.allow_plain_http_remote`) this
 *    machine's own LAN names with the port. Anything else: 421
 *    `misdirected`.
 *  - Credential: `Authorization: Bearer den_pt_…` (the person token, §5)
 *    or `den_at_…` (SEC-1c: an agent's actor token, live only while its
 *    session runs). A bearer that doesn't verify: 401 `unauthorized`; an
 *    actor token `web logout --all` revoked: 401 `token_revoked` ("restart
 *    or resume the agent"). Or
 *    the browser's session cookie (SEC-1b), looked up server-side.
 *  - An agent's token (SEC-1c, §5) never reaches: web.secret's management
 *    and sign-in (/api/web/*, /auth, /api/session/logout), the lock (R8:
 *    /api/sudo-password*), or a shell-grade route other than its own
 *    session's /api/sessions/<id>/*: agent start and resume mint tokens.
 *    403 `agent_forbidden`. WS-3a (0.4.2) adds the workspace check at
 *    agentRefusal's seam.
 *  - Sign-in (§4, route-classes.ts): beyond loopback (the edge hostname, a
 *    LAN name, or a peer that isn't loopback) every route needs a session
 *    or a bearer. Otherwise 401 `signin_required`. On loopback no route
 *    does, shell-grade ones included (Ward, 2026-11-06: the lock, R8, is
 *    the only prompt there; Host, Origin and CSRF cover CSRF and DNS
 *    rebinding). SIGNIN_FREE routes never need one.
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
 * bearer.
 *
 * The audit actor (auditActorOf, principalOf) comes from the credential,
 * never from a header the caller sets: `agent:<id>` for an actor token,
 * `person:<os user>` for a person token or a signed-in browser. An
 * x-den-actor claim is kept only as an unverified label.
 */
import { randomBytes, timingSafeEqual, createHash } from "crypto";
import type * as http from "http";
import * as net from "net";
import {
  actorFromHeaders,
  type Actor,
  type AgentActor,
} from "../../shared/agent-actor.js";
import { osUser } from "../../shared/web-secret.js";
import {
  isMutatingGet,
  pathMatches,
  routeClass,
  SIGNIN_FREE,
  type RouteClass,
} from "./route-classes.js";

export const CSRF_HEADER = "x-den-csrf";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** An agent's actor token (SEC-1c): what it was minted as. */
export interface AgentPrincipal {
  kind: "agent";
  actor: `agent:${string}`;
  workspace: string;
  grants: readonly string[];
  /** The session it runs in: its name and the host's id for it. */
  session: { name: string; id?: string };
}

/** Who a request proved itself to be. */
export type Principal =
  | { kind: "person"; actor: `person:${string}` }
  | AgentPrincipal
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
  /**
   * What a bearer token proves (a person token's `person:<user>`, an actor
   * token's agent), `"revoked"` for an actor token `web logout --all`
   * revoked (SEC-1 §6c.2), or null when it doesn't verify.
   */
  verifyBearer: (
    token: string,
  ) => `person:${string}` | AgentPrincipal | "revoked" | null;
  /** This server start's CSRF token (loopback, no session). */
  csrfToken: string;
  /** The live session the request's cookie names (SEC-1b), or null. */
  session?: (req: http.IncomingMessage) => GuardSession | null;
  /**
   * Whether the request's peer is loopback. Unset: taken as loopback (a
   * request object without a socket, in a unit test); the server sets it.
   */
  peerIsLoopback?: (req: http.IncomingMessage) => boolean;
  /**
   * Whether the request's peer is one the edge's proxy runs on (isEdgePeer:
   * loopback or a Docker network). The edge hostname is believed only from
   * one: a LAN client that sends `Host: <edge hostname>` straight to this
   * server's port gets 421. Unset: taken as yes (a unit test).
   */
  peerIsEdge?: (req: http.IncomingMessage) => boolean;
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
        | "token_revoked"
        | "signin_required"
        | "origin_rejected"
        | "csrf"
        | "cross_site"
        | "agent_forbidden";
      error: string;
      /** signin_required: why (beyond loopback: `den`). */
      scope?: SigninScope;
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

/** An upgrade's CSRF token, offered as the subprotocol `den.csrf.<token>`. */
export const CSRF_PROTOCOL_PREFIX = "den.csrf.";
function csrfFromProtocols(req: http.IncomingMessage): string | undefined {
  const raw = req.headers["sec-websocket-protocol"];
  const all = (Array.isArray(raw) ? raw.join(",") : (raw ?? ""))
    .split(",")
    .map((s) => s.trim());
  const p = all.find((s) => s.startsWith(CSRF_PROTOCOL_PREFIX));
  return p ? p.slice(CSRF_PROTOCOL_PREFIX.length) : undefined;
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
 * A Docker bridge address (172.16.0.0/12): where a Linux host's containers
 * reach it as host.docker.internal (`host-gateway`, the edge's
 * extra_hosts). One address, never 0.0.0.0 or ::.
 */
export function isDockerBridgeAddress(addr: string): boolean {
  const a = addr.trim();
  if (!net.isIPv4(a)) return false;
  const [x, y] = a.split(".").map(Number);
  return x === 172 && y >= 16 && y <= 31;
}

/**
 * §4: why a bind may not start, or null. A non-loopback bind needs
 * `web.allow_plain_http_remote: true`, edge or no edge: whatever is in
 * front, this server's own port still answers plain HTTP on that address,
 * so a session cookie (or a LAN client posing as the edge) would cross the
 * network in clear text. The one exception is the edge's own path on
 * Linux: with HTTPS in front (`fronted`), a Docker bridge address (the
 * host-gateway host.docker.internal resolves to there), which only this
 * machine's containers reach. On macOS Docker Desktop delivers
 * host.docker.internal to loopback, so the default bind serves the edge.
 */
export function bindRefusal(
  bind: string,
  opts: { allowPlainHttpRemote: boolean; fronted: boolean },
): string | null {
  if (isLoopbackBind(bind) || opts.allowPlainHttpRemote) return null;
  if (opts.fronted && isDockerBridgeAddress(bind)) return null;
  return (
    `Refusing to listen on ${bind}: it is reachable beyond this machine, ` +
    "and this server's own port answers plain HTTP there, so a session " +
    "cookie would cross the network in clear text, even with the edge in " +
    "front. The edge reaches Den on loopback (or, on Linux, on the Docker " +
    "bridge address: DEN_BIND_HOST=172.17.0.1). To accept plain HTTP from " +
    "other machines, set web.allow_plain_http_remote: true in " +
    "config/local/user.yml (this machine's file; the distribution config's " +
    "is ignored)."
  );
}

/**
 * Why a sign-in is asked for. The request checks ask only beyond loopback
 * (`den`); `terminal` and `agents` are kept for the page's wording.
 */
export type SigninScope = "terminal" | "agents" | "den";

/** What signin_required says, by why it was asked for. */
export function signinMessage(
  scope: SigninScope,
  cli: string,
  title: string,
): string {
  const what =
    scope === "terminal"
      ? "use the terminal"
      : scope === "agents"
        ? "start agents"
        : `use ${title}`;
  return `Sign in to ${what}: run \`${cli} web login\` and open the link.`;
}

export function checkRequest(
  req: http.IncomingMessage,
  ctx: GuardContext,
  cli = "den",
  title = "Den",
): GuardResult {
  const named = hostAllowed(header(req, "host"), ctx);
  // The edge hostname from a peer that isn't the edge: not the edge.
  const via =
    named === "edge" && ctx.peerIsEdge && !ctx.peerIsEdge(req) ? null : named;
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
    const proved = ctx.verifyBearer(bearer[1]);
    if (proved === "revoked")
      return {
        ok: false,
        status: 401,
        code: "token_revoked",
        error:
          "This agent's token was revoked (`web logout --all`): restart or resume the agent to get a new one.",
      };
    if (!proved)
      return {
        ok: false,
        status: 401,
        code: "unauthorized",
        error: bearer[1].startsWith("den_at_")
          ? "This agent token is not valid here: its agent was stopped or resumed, or its session ended."
          : `The bearer token is not valid here; \`${cli} web token --print\` prints the current one.`,
      };
    principal =
      typeof proved === "string" ? { kind: "person", actor: proved } : proved;
  }
  const session = principal ? null : (ctx.session?.(req) ?? null);

  const method = (req.method ?? "GET").toUpperCase();
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const cls: RouteClass =
    routeClass(method, pathname) ??
    (MUTATING.has(method) || isUpgrade(req) ? "mutating" : "readonly");

  if (principal?.kind === "agent") {
    const refused = agentRefusal(principal, method, pathname, cls);
    if (refused)
      return {
        ok: false,
        status: 403,
        code: "agent_forbidden",
        error: refused,
      };
  }

  // §4: a session (or a bearer) beyond loopback; on loopback, never.
  if (!principal && !session && !SIGNIN_FREE.includes(pathname) && beyond) {
    const scope: SigninScope = "den";
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
  // A browser's WebSocket can't send a header: on an upgrade the token
  // rides as a subprotocol, `den.csrf.<token>` (AG-4a-term's io).
  const csrf =
    header(req, CSRF_HEADER) ??
    (isUpgrade(req) ? csrfFromProtocols(req) : undefined);
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

/** Routes an agent's token never reaches, whatever the method (SEC-1 §5). */
export const AGENT_FORBIDDEN: readonly string[] = [
  // web.secret's management and the browser sign-in: an agent mints nothing.
  "/api/web/*",
  "/auth",
  "/signin",
  "/api/session/logout",
];

/**
 * Routes an agent's token may read but never change: the lock (R8).
 * Privileged actions stay with people (AG-5); its status is a read.
 */
export const AGENT_READ_ONLY: readonly string[] = [
  "/api/sudo-password",
  "/api/sudo-password/*",
];

/** `/api/sessions/<id>/…`: a session's own routes (AG-4a-term's io). */
const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)(?:\/|$)/;

/**
 * Why an agent's token can't make this request, or null (SEC-1 §5):
 *  - a route in AGENT_FORBIDDEN;
 *  - a shell-grade route, unless it is its own session's
 *    (`/api/sessions/<its session id or name>/…`): agent start and resume
 *    mint tokens, the browser sessions are a person's.
 * Seam (WS-3a, 0.4.2): the route's workspace against `p.workspace` and
 * `p.grants` is checked here; nothing is yet.
 */
export function agentRefusal(
  p: AgentPrincipal,
  method: string,
  pathname: string,
  cls: RouteClass,
): string | null {
  if (
    AGENT_FORBIDDEN.some((r) => pathMatches(r, pathname)) ||
    (method !== "GET" &&
      method !== "HEAD" &&
      AGENT_READ_ONLY.some((r) => pathMatches(r, pathname)))
  )
    return `${p.actor} can't use ${pathname}: signing in, web.secret and the lock are a person's.`;
  const m = SESSION_ROUTE.exec(pathname);
  if (m) {
    let id = m[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      /* compared as given */
    }
    if (id === p.session.id || id === p.session.name) return null;
    return `${p.actor} can use its own session only, not ${id}.`;
  }
  if (cls === "shell-grade")
    return `${p.actor} can't ${method === "GET" ? "open" : "use"} ${pathname}: starting or resuming an agent, and the browser sessions, are a person's.`;
  return workspaceRefusal(p, pathname);
}

/** WS-3a's seam (0.4.2): an agent's route outside its workspace. Not yet. */
function workspaceRefusal(_p: AgentPrincipal, _pathname: string): null {
  return null;
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

/** The agent a request's actor token proves (SEC-1c), if any. */
export function agentPrincipalOf(
  req: http.IncomingMessage,
): AgentPrincipal | null {
  const p = PRINCIPALS.get(req);
  return p?.kind === "agent" ? p : null;
}

/**
 * Who the request's credential proves it is, for the audit trail:
 * `agent:<id>` for an actor token, `person:<user>` for a person token,
 * `person:<os user>` for a signed-in browser (a session is the OS user's:
 * only they can mint its login code). Undefined with no credential. Never
 * anything a header the caller sets claims.
 */
export function principalOf(req: http.IncomingMessage): string | undefined {
  const p = PRINCIPALS.get(req);
  if (p?.kind === "person" || p?.kind === "agent") return p.actor;
  if (p?.kind === "person-browser" && p.session) return `person:${osUser()}`;
  return undefined;
}

/**
 * The audit actor of a request (recordAction's first argument), from its
 * credential (SEC-1c):
 *  - an actor token: that agent and its workspace, verified; the MCP
 *    client's self-reported name and version are labels only;
 *  - anything else: null (the person), unless the caller sent x-den-actor
 *    headers. Those are never the actor: they are kept as an unverified
 *    claim (AuditEntry.claimed), whatever credential came with them.
 */
export function auditActorOf(req: http.IncomingMessage): Actor {
  const claimed = actorFromHeaders(req.headers);
  const agent = agentPrincipalOf(req);
  if (agent) {
    const actor: AgentActor = {
      kind: "agent",
      client: claimed?.client ?? "unknown",
      clientVersion: claimed?.clientVersion ?? "unknown",
      mcpPid: claimed?.mcpPid ?? null,
      session: claimed?.session ?? "",
      agent: agent.actor,
      workspace: agent.workspace,
    };
    return actor;
  }
  return claimed ? { ...claimed, unverified: true } : null;
}
