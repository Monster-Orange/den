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
 *    the browser's session cookie (SEC-1b), looked up server-side. Once
 *    Den's own named https address works, a session cookie on a loopback
 *    name doesn't count (loopbackSessions): it lives on that address.
 *  - An agent's token (SEC-1c, §5) never reaches: web.secret's management
 *    and sign-in (/api/web/*, /auth, /api/session/logout), the lock (R8:
 *    /api/sudo-password*), or a shell-grade route other than its own
 *    session's /api/sessions/<id>/*: agent start and resume mint tokens.
 *    403 `agent_forbidden`. Two exceptions: MCP agent_resume (AG-14.4)
 *    and agent_import (AG-17.1), each when mcp.actions lists it, inside
 *    its own workspace or a granted one (agent-resume-grant.ts). WS-3a (0.4.2) adds the workspace check at
 *    agentRefusal's seam.
 *  - Sign-in (§4, route-classes.ts): beyond loopback (a LAN name, a peer
 *    that isn't loopback, or the edge hostname for a client on another
 *    machine) every route needs a session or a bearer. Otherwise 401
 *    `signin_required`. On loopback (0.4.71) every route that isn't
 *    `readonly` needs one too: writes, upgrades, shell-grade routes and
 *    the GETs that run something. A plain read there passes with the Host
 *    check. SIGNIN_FREE routes never need one.
 *  - The edge (0.4.3, 0.4.5: edgeClient): the edge hostname from an edge
 *    peer gets loopback's treatment when the edge attests the client is
 *    this machine (the right-most X-Forwarded-For entry, the one the edge
 *    itself appended, is loopback or one of this machine's addresses). A
 *    client it can't place (none, or a Docker/VM gateway's address) signs
 *    in unless `web.edge_unattested: local`; another machine always does,
 *    as does every edge request when this server is deliberately exposed
 *    (`exposed`: a non-loopback DEN_BIND_HOST bind). `localhost` (a
 *    loopback Host from a loopback peer) never asks.
 *  - Signing in with GitHub (SEC-2a): its start and poll are sign-in free,
 *    and its start needs an allowed Origin but no CSRF token (a signed-out
 *    page has none; route-classes.ts SIGNIN_CSRF_FREE).
 *  - Origin, on POST/PUT/PATCH/DELETE and every WebSocket upgrade: an
 *    allowed host (http or https). No Origin needs a valid bearer.
 *    Otherwise 403 `origin_rejected`.
 *  - CSRF: a browser mutation (Origin, no bearer) carries `X-Den-CSRF`:
 *    the session's own token, from `GET /api/session` (only a signed-in
 *    browser gets one). Otherwise 403 `csrf`.
 *
 * GETs, pages and SSE streams on loopback pass with only the Host check
 * (§6), except the GETs route-classes.ts marks `mutating` or `shell-grade`
 * (a run, a service's lifecycle command, a log tail): a sign-in, and
 * same-origin only, or a CLI's bearer. A sign-in GET (SIGNIN_GETS: /auth, the GitHub sign-in poll) may
 * also come with no fetch metadata at all, as a plain-http LAN origin's do.
 *
 * The audit actor (auditActorOf, principalOf) comes from the credential,
 * never from a header the caller sets: `agent:<id>` for an actor token,
 * `person:<os user>` for a person token or a signed-in browser. An
 * x-den-actor claim is kept only as an unverified label.
 */
import { timingSafeEqual, createHash } from "crypto";
import type * as http from "http";
import { readMcpConfig, type InstallMode } from "../../shared/den-config.js";
import { installModeNow } from "../../shared/gates/browser-container.js";
import { scopeReaches, scopeWords } from "../../shared/agents/scope-rule.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import { LIFECYCLE_CMDS } from "../mcp/guards.js";
import {
  AGENT_IMPORT_HELD,
  agentImportRefusal,
  agentImportTarget,
  agentResumeRefusal,
  agentResumeTarget,
} from "./agent-resume-grant.js";
import * as net from "net";
import * as os from "os";
import {
  actorFromHeaders,
  type Actor,
  type AgentActor,
} from "../../shared/agent-actor.js";
import { osUser } from "../../shared/web/web-secret.js";
import { FIXTURE_PRINCIPAL } from "../../shared/fixture-person.js";
import {
  OPERATOR_PRINCIPAL,
  type OperatorAct,
} from "../../shared/test-operator.js";
import {
  notTestBedRefusal,
  TEST_PERSON_HEADER,
  testPersonCredentialRefusal,
} from "../../shared/test-person.js";

/** Issue 796: the audit client of an agent's read-only view. */
export const AGENT_VIEW_CLIENT = "page view (read-only)";
import { RUNNER_TOKEN_PREFIX } from "../../shared/gates/runner-tokens.js";
import { isDockerBridgeAddress } from "../../shared/edge/docker-bridge.js";
export { isDockerBridgeAddress };
import {
  EMBED_KEY_ROUTES,
  RUNNER_ROUTES,
  isMutatingGet,
  pathMatches,
  ROUTES,
  routeClass,
  SIGNIN_CSRF_FREE,
  SIGNIN_ID_BEACONS,
  SIGNIN_ID_DELETES,
  SIGNIN_FREE,
  SIGNIN_GETS,
  type RouteClass,
} from "./route-classes.js";

export const CSRF_HEADER = "x-den-csrf";
// Only GET and HEAD are reads: any other method is checked as a change
// (the server answers 405 to one outside the six before this runs).
const READS = new Set(["GET", "HEAD"]);
const changes = (method: string) => !READS.has(method);

/** An agent's actor token (SEC-1c): what it was minted as. */
export interface AgentPrincipal {
  kind: "agent";
  actor: `agent:${string}`;
  workspace: string;
  grants: readonly string[];
  /** The session it runs in: its name and the host's id for it. */
  session: { name: string; id?: string };
}

/**
 * Issue 621: a gate-only runner token (a CI job in a runner VM). It
 * reaches RUNNER_ROUTES only; it is never a person and never an agent.
 */
export interface RunnerPrincipal {
  kind: "gate-runner";
  /** The token's id (only it renews or releases its slots). */
  id: string;
  /** The runner's name, as the person allowed it. */
  name: string;
}

/** Who a request proved itself to be. */
export type Principal =
  | {
      kind: "person";
      actor: `person:${string}`;
      /** Issue 636: a test bed's CLI, on the test-person path. */
      testPerson?: true;
    }
  | AgentPrincipal
  | {
      kind: "person-browser";
      session?: string;
      /** Issue 810: the fixture person's session (a test install's live checks). */
      fixture?: true;
      /** Issue 796: an agent's read-only view: the agent and its project. */
      view?: { agent: string; workspace: string };
    }
  | RunnerPrincipal;

/** What the request checks need of a signed-in browser session. */
export interface GuardSession {
  /** The record's key (never the cookie's value). */
  key: string;
  /** The session's own CSRF token. */
  csrf: string;
  /** sha256 of its approval key (approvals.ts); unset before 0.4.15. */
  approveKeyHash?: string;
  /**
   * Minted over https through the edge with its proof (the `__Host-`
   * cookie). Once Den's own named https address works, only such a
   * session counts (loopbackSessions).
   */
  secure?: boolean;
  /** How it signed in (web-session.ts); "fixture": the fixture person (issue 810). */
  via?: string;
  /** Issue 796: an agent's view (via "agent-view"): whose, and its project. */
  agent?: string;
  agentWorkspace?: string;
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
   * revoked (SEC-1 §6c.2), `"elsewhere"` for a live actor token sent from
   * a process outside its agent's session (#70), or null when it doesn't
   * verify.
   */
  verifyBearer: (
    token: string,
    req: http.IncomingMessage,
  ) => `person:${string}` | AgentPrincipal | "revoked" | "elsewhere" | null;
  /**
   * Issue 621: what a gate-only runner token (`den_gr_`) proves: its id
   * and name, `"revoked"`, or null. Unset: no runner token verifies.
   */
  verifyRunner?: (
    token: string,
  ) => { id: string; name: string } | "revoked" | null;
  /**
   * The live session the request's cookie names (SEC-1b), or null. `via`:
   * how it reached Den (which cookie name counts: session-cookie.ts).
   */
  session?: (req: http.IncomingMessage, via: Via) => GuardSession | null;
  /**
   * Whether a session counts on a loopback name. False once Den's own
   * named https address works (named-address.ts): the session lives only
   * there, since browsers share a host's cookies across its ports. Unset:
   * true (an install with no working https address, a unit test).
   */
  loopbackSessions?: () => boolean;
  /**
   * Whether the request's peer is loopback. Unset: taken as loopback (a
   * request object without a socket, in a unit test); the server sets it.
   */
  peerIsLoopback?: (req: http.IncomingMessage) => boolean;
  /**
   * one: a LAN client that sends `Host: <edge hostname>` straight to this
   * server's port gets 421. Unset: taken as yes (a unit test).
   */
  peerIsEdge?: (req: http.IncomingMessage) => boolean;
  /**
   * This machine's own addresses and container/VM bridges (localNet), for
   * telling whether an edge request's client is this machine. Unset: none
   * (a unit test): only loopback and the Docker ranges count as local.
   */
  localNet?: () => LocalNet;
  /**
   * A deliberate network exposure (a non-loopback DEN_BIND_HOST bind other
   * than the Docker bridge the edge uses on Linux): the edge hostname
   * needs a sign-in too, as before 0.4.3.
   */
  exposed?: boolean;
  /**
   * `web.edge_unattested` (SEC-2a): an edge client Den can't place signs
   * in (`signin`, the default when unset) or counts as local (`local`).
   */
  edgeUnattested?: "local" | "signin";
  /**
   * H1 (0.4.48): the request carries the edge's proof (edge/proof.ts).
   * Only then is the edge's forwarded client believed: without it, a
   * request on the edge hostname is never this machine and signs in,
   * whatever web.edge_unattested says. Unset: no proof (fails closed).
   */
  edgeProved?: (req: http.IncomingMessage) => boolean;
  edgeStarting?: () => boolean;
  /**
   * Issue 636: whether this install is a test bed right now (issue 810's
   * test install binding). Unset: never (the test-person path is refused).
   */
  testBed?: () => boolean;
}

export type GuardResult =
  | {
      ok: true;
      principal: Principal | null;
      /** How the request reached Den. */
      via: Via;
      /** Beyond loopback: the edge, a LAN name, or a non-loopback peer. */
      beyond: boolean;
      /**
       * Via the edge, with the install's own edge's proof (H1), and the edge
       * attests the client is this machine (edgeClient "local"): never an
       * unattested client, even where web.edge_unattested counts it local.
       * Issue 1034: the test operator's own shell through the edge.
       */
      edgeLocal: boolean;
      /** The signed-in session, when the cookie names a live one. */
      session: GuardSession | null;
      /**
       * Sign-out only: the session its cookie names when that session no
       * longer counts (its own CSRF token proved the page). It ends it.
       */
      ending?: GuardSession;
      /** The client's address when Den can attest it (SEC-2a: a device's record). */
      client?: string;
    }
  | {
      ok: false;
      status: 401 | 403 | 421 | 503;
      code:
        | "misdirected"
        | "unauthorized"
        | "token_revoked"
        | "agent_token_elsewhere"
        | "signin_required"
        | "origin_rejected"
        | "csrf"
        | "cross_site"
        | "agent_forbidden"
        | "embed_key_scope"
        | "runner_scope"
        | "test_person_refused"
        | "not_test_bed"
        | "edge_starting";
      error: string;
      /** signin_required: why (beyond loopback: `den`). */
      scope?: SigninScope;
      via?: Via;
      beyond?: boolean;
      /** agent_forbidden: the agent refused; not_test_bed: the person. For the audit. */
      principal?: Principal;
    };

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

export function isDockerRangeAddress(addr: string | undefined): boolean {
  const a = String(addr ?? "")
    .toLowerCase()
    .replace(/^::ffff:/, "");
  if (!net.isIPv4(a)) return false;
  const [x, y, z] = a.split(".").map(Number);
  return (
    (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168 && z === 65)
  );
}

let EDGE_ADDRESSES: ReadonlySet<string> | null = null;

export function setEdgeAddresses(addrs: readonly string[] | null): void {
  EDGE_ADDRESSES = addrs?.length ? new Set(addrs.map(normAddress)) : null;
}

/** The edge: loopback, or the addresses of this install's labelled edge
 * container. No other Docker-range peer. */
export function isEdgePeer(
  addr: string | undefined,
  edge: ReadonlySet<string> | null = EDGE_ADDRESSES,
): boolean {
  if (isLoopbackAddress(addr)) return true;
  if (!addr || !edge) return false;
  return edge.has(normAddress(addr));
}

/** An address without its zone, IPv4-mapped prefix or brackets, lowercase. */
function normAddress(a: string): string {
  return a
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
    .replace(/^::ffff:(?=\d+\.)/, "");
}

/** This machine's own addresses, and the container/VM bridges it hosts. */
export interface LocalNet {
  /** Every interface address (loopback, LAN, a VPN's such as Tailscale's 100.x). */
  own: readonly string[];
  /** IPv4 subnets of its container/VM bridges (Docker, OrbStack, VMs). */
  bridges: readonly { address: string; netmask: string }[];
}

/** Interface names of container/VM bridges: their peers are this machine's. */
const BRIDGE_IFACE =
  /^(docker\d*|br-|bridge\d+|vmnet|virbr|veth|cni|podman|vboxnet)/;

/** localNet from os.networkInterfaces() (or a given table, in a test). */
export function localNet(
  ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): LocalNet {
  const own: string[] = [];
  const bridges: { address: string; netmask: string }[] = [];
  for (const [name, list] of Object.entries(ifaces))
    for (const a of list ?? []) {
      own.push(normAddress(a.address));
      if (a.family === "IPv4" && BRIDGE_IFACE.test(name))
        bridges.push({ address: a.address, netmask: a.netmask });
    }
  return { own: [...new Set(own)], bridges };
}

function ipv4(a: string): number {
  return a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
}
function inSubnet(a: string, net4: { address: string; netmask: string }) {
  if (!net.isIPv4(a) || !net.isIPv4(net4.address)) return false;
  const m = ipv4(net4.netmask);
  // Unsigned compare of the masked halves (no 32-bit sign games).
  const lo = (x: number) => x - (x % (2 ** 32 - m));
  return m > 0 && lo(ipv4(a)) === lo(ipv4(net4.address));
}

/** One X-Forwarded-For entry as an IP (a port or brackets dropped), or undefined. */
function forwardedEntry(entry: string | undefined): string | undefined {
  let a = entry?.trim();
  if (!a) return undefined;
  const b = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (b) a = b[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(a)) a = a.replace(/:\d+$/, "");
  a = normAddress(a);
  return net.isIP(a) ? a : undefined;
}

/**
 * The client the edge vouches for (SEC-2a): the right-most X-Forwarded-For
 * entry, the one the edge's proxy appended itself (its TCP peer, or the
 * client a trusted front passed on with the PROXY protocol). The entries
 * left of it are whatever the client, or a hop the edge trusts, sent, so
 * they are never believed (0.4.4 and earlier read the left-most: forgeable). Undefined
 * when there is none, or it isn't an IP.
 */
export function forwardedClient(xff: string | undefined): string | undefined {
  const all = xff?.split(",") ?? [];
  return forwardedEntry(all[all.length - 1]);
}

/** Who an edge request's client is, as far as Den can tell (edgeClient). */
export type EdgeClient = "local" | "unattested" | "foreign";

/**
 * Who an edge request (the edge hostname from an edge peer) comes from, by
 * the client the edge vouches for (forwardedClient):
 *  - loopback, or one of this machine's own interface addresses (its LAN
 *    or VPN address, a Tailscale 100.x one included): `local`;
 *  - missing, unreadable, or a container/VM network's address (the Docker
 *    one of the edge's own Docker networks, or OrbStack's 0.250.250.254):
 *    `unattested`. Docker Desktop and OrbStack on macOS hand the edge
 *    their gateway's address, and a TCP passthrough in front hides the
 *    client, so Den can't tell. With SEC-2a it signs in, unless
 *    `web.edge_unattested: local` (0.4.4's allow);
 *  - anything else: `foreign`, another machine (sign-in required).
 */
export function edgeClient(
  xff: string | undefined,
  local: LocalNet = { own: [], bridges: [] },
): EdgeClient {
  const c = forwardedClient(xff);
  if (!c) return "unattested";
  if (isLoopbackAddress(c)) return "local";
  if (isDockerRangeAddress(c) || local.bridges.some((b) => inSubnet(c, b)))
    return "unattested";
  // 0.0.0.0/8 ("this network") is never a client on another machine:
  // OrbStack presents the host to its containers as 0.250.250.254.
  if (net.isIPv4(c) && c.startsWith("0.")) return "unattested";
  return local.own.includes(c) ? "local" : "foreign";
}

/**
 * Whether the request came over HTTPS: the socket's own encryption, or,
 * only for the edge hostname from an edge peer that carries the edge's
 * proof (`proved`, H1), `X-Forwarded-Proto: https`. A spoofed header on a
 * loopback Host, or from a local process without the proof, never counts.
 * The edge says `wss` for a WebSocket upgrade over TLS (the terminal
 * pane's): that is https too.
 */
export function requestIsHttps(
  req: http.IncomingMessage,
  via: Via | null,
  proved = false,
): boolean {
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted)
    return true;
  if (!proved || via !== "edge" || !isEdgePeer(req.socket?.remoteAddress))
    return false;
  const xfp = header(req, "x-forwarded-proto")
    ?.split(",")[0]
    .trim()
    .toLowerCase();
  return xfp === "https" || xfp === "wss";
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
  if (via === "edge" && ctx.edgeStarting?.())
    return {
      ok: false,
      status: 503,
      code: "edge_starting",
      error: `${title} is starting. Try again in a moment.`,
      via,
    };
  // Issue 334: an embed key reaches its own routes only, never another
  // (loopback lets an anonymous request through: the key must not ride along).
  if (header(req, "x-den-embed-key") !== undefined) {
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!EMBED_KEY_ROUTES.some((r) => pathMatches(r, p)))
      return {
        ok: false,
        status: 403,
        code: "embed_key_scope",
        error:
          "An embed key reaches only its agent's embed routes (say and state). Nothing ran.",
      };
  }
  const peerLoopback = ctx.peerIsLoopback ? ctx.peerIsLoopback(req) : true;
  // The edge: local when it attests this machine; a client it can't place
  // signs in unless web.edge_unattested is local; never local when this
  // server is deliberately exposed. A LAN name or peer is beyond.
  // H1: the forwarded client is the edge's word only with its proof; a
  // peer that merely sits where the edge does is believed in nothing.
  const xff = header(req, "x-forwarded-for");
  const proved = via === "edge" && !!ctx.edgeProved?.(req);
  const who = proved ? edgeClient(xff, ctx.localNet?.()) : null;
  const beyond =
    via === "edge"
      ? !proved ||
        !!ctx.exposed ||
        who === "foreign" ||
        (who === "unattested" && ctx.edgeUnattested !== "local")
      : via !== "loopback" || !peerLoopback;
  // The address a device's record keeps: the edge's attested client, or
  // the peer itself off the edge (never an unproved forwarded one).
  const client =
    via === "edge"
      ? who === "local" || who === "foreign"
        ? forwardedClient(xff)
        : undefined
      : (req.socket?.remoteAddress ?? undefined);

  let principal: Principal | null = null;
  const auth = header(req, "authorization");
  const bearer = auth ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
  // Issue 621: a gate-only runner token reaches the runner routes only
  // (ask, renew, release a gate slot), and nothing else, whatever else
  // the request carries.
  if (bearer?.[1].startsWith(RUNNER_TOKEN_PREFIX)) {
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!RUNNER_ROUTES.includes(p))
      return {
        ok: false,
        status: 403,
        code: "runner_scope",
        error:
          "A runner token reaches only the gate-slot ask, renew and release routes. Nothing ran.",
      };
    const r = ctx.verifyRunner?.(bearer[1]) ?? null;
    if (r === "revoked")
      return {
        ok: false,
        status: 401,
        code: "token_revoked",
        error: "This runner token was revoked. Ask the person for a new one.",
      };
    if (!r)
      return {
        ok: false,
        status: 401,
        code: "unauthorized",
        error: "This runner token is not valid here.",
      };
    principal = { kind: "gate-runner", id: r.id, name: r.name };
  } else if (bearer) {
    const proved = ctx.verifyBearer(bearer[1], req);
    if (proved === "elsewhere")
      return {
        ok: false,
        status: 403,
        code: "agent_token_elsewhere",
        error:
          // Issue 1131: what to do. A busy machine can make Den miss the
          // agent's own process; the token is never in this text.
          `This agent token works only from its own agent's processes, and ${title} couldn't tell this call came from one of them. Nothing ran. If it came from this agent's own tools, try the call again (a busy machine can cause this); if it keeps happening, run \`${cli} doctor\` and restart the agent from Agents.`,
      };
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
  // Issue 636: the test-person path counts only with the person's own
  // token, from this machine, on a test bed. Anything else is refused
  // here, before any route runs.
  if (header(req, TEST_PERSON_HEADER) !== undefined) {
    if (principal?.kind !== "person" || beyond)
      return {
        ok: false,
        status: 403,
        code: "test_person_refused",
        error: testPersonCredentialRefusal(),
      };
    if (!ctx.testBed?.())
      return {
        ok: false,
        status: 403,
        code: "not_test_bed",
        error: notTestBedRefusal(),
        principal,
      };
    principal = { ...principal, testPerson: true };
  }
  // Once Den's own named https address works, sessions count only when
  // minted on it: none on a loopback name, and none minted elsewhere.
  const namedOnly = ctx.loopbackSessions?.() === false;
  const found = principal ? null : (ctx.session?.(req, via) ?? null);
  // Issue 796: an agent's read-only view lives on loopback only, so it
  // still counts there.
  const loopView = via === "loopback" && found?.via === "agent-view";
  const session =
    namedOnly && (via === "loopback" || !found?.secure) && !loopView
      ? null
      : found;

  const method = (req.method ?? "GET").toUpperCase();
  const reqUrl = new URL(req.url ?? "/", "http://localhost");
  const pathname = reqUrl.pathname;
  // Sign-out of a session that no longer counts: it may end that session
  // only, with its own CSRF token (checked below, with the Origin).
  const ending =
    !session && found && method === "POST" && pathname === SIGNOUT
      ? found
      : null;
  const cls: RouteClass =
    routeClass(method, pathname) ??
    (changes(method) || isUpgrade(req) ? "mutating" : "readonly");

  if (principal?.kind === "agent") {
    const refused = agentRefusal(
      principal,
      method,
      pathname,
      cls,
      reqUrl.searchParams,
    );
    if (refused)
      return {
        ok: false,
        status: 403,
        code: "agent_forbidden",
        error: refused,
        principal,
      };
  }

  // §4: a session (or a bearer) beyond loopback for every route; on this
  // machine too (0.4.71) for every route that changes something, runs
  // something or reaches a shell: what isn't `readonly`, every write
  // method and every upgrade. A plain read on loopback passes as before.
  const signinFree = SIGNIN_FREE.some((r) => pathMatches(r, pathname));
  const needsSignin = cls !== "readonly" || changes(method) || isUpgrade(req);
  if (
    !principal &&
    !session &&
    !ending &&
    !signinFree &&
    (beyond || needsSignin)
  ) {
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
    edgeLocal: proved && who === "local",
    session,
    ...(client ? { client: normAddress(client) } : {}),
  });
  const browser: Principal | null = session
    ? {
        kind: "person-browser",
        session: session.key,
        ...(session.via === "fixture" ? { fixture: true as const } : {}),
        ...(session.via === "agent-view" && session.agent
          ? {
              view: {
                agent: session.agent,
                workspace: session.agentWorkspace ?? "",
              },
            }
          : {}),
      }
    : null;

  if (!changes(method) && !isUpgrade(req)) {
    if (isMutatingGet(method, pathname)) {
      const refused = mutatingGetRefusal(req, ctx, pathname, principal, cli);
      if (refused) return refused;
    }
    return ok(principal ?? browser);
  }

  const origin = header(req, "origin");
  if (origin === undefined) {
    if (principal) return ok(principal);
    // Issue 334: a web app's own server sends no Origin; its app key is the
    // proof (the route checks it; a browser always sends an Origin here).
    if (
      pathname === "/api/embed/say" &&
      (header(req, "x-den-embed-key") ?? "").startsWith("den_sk_")
    )
      return ok(null);
    return {
      ok: false,
      status: 403,
      code: "origin_rejected",
      error:
        "A request that changes something needs an Origin from this server, " +
        `or \`Authorization: Bearer <token>\` (run \`${cli} web token --print\` in your own terminal for it).`,
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
  // Starting a GitHub sign-in from the signed-out page (which holds no
  // CSRF token): the allowed Origin above is the check.
  if (!session && SIGNIN_CSRF_FREE.some((r) => pathMatches(r, pathname)))
    return ok(null);
  // D67: a code request's page withdraws it by its poll id (the proof).
  if (
    method === "DELETE" &&
    SIGNIN_ID_DELETES.some((r) => pathMatches(r, pathname))
  )
    return ok(null);
  // Issue 320: the same withdraw, as the page's beacon (a POST).
  if (
    method === "POST" &&
    SIGNIN_ID_BEACONS.some((r) => pathMatches(r, pathname))
  )
    return ok(null);
  // A browser's WebSocket can't send a header: on an upgrade the token
  // rides as a subprotocol, `den.csrf.<token>` (AG-4a-term's io).
  const csrf =
    header(req, CSRF_HEADER) ??
    (isUpgrade(req) ? csrfFromProtocols(req) : undefined);
  if (ending && csrf && same(csrf, ending.csrf))
    return {
      ok: true,
      principal: null,
      via,
      beyond,
      edgeLocal: proved && who === "local",
      session: null,
      ending,
      ...(client ? { client: normAddress(client) } : {}),
    };
  // The session's own token: there is no other (0.4.71).
  if (!csrf || !session || !same(csrf, session.csrf))
    return {
      ok: false,
      status: 403,
      code: "csrf",
      error:
        "The request is missing this page's CSRF token; reload the page and try again.",
    };
  return ok(browser ?? { kind: "person-browser" });
}

/** Sign-out's route. */
const SIGNOUT = "/api/session/logout";

/** Routes an agent's token never reaches, whatever the method (SEC-1 §5). */
export const AGENT_FORBIDDEN: readonly string[] = [
  // web.secret's management and the browser sign-in: an agent mints nothing.
  "/api/web/*",
  "/api/github/*",
  "/api/signin/*",
  "/auth",
  "/signin",
  "/api/session/logout",
  // D34: what a person sees of an agent's helpers is the person's to clear.
  "/api/workspaces/:ws/agents/:id/clear-helpers",
  // Issue 278: deliveries held after a compaction loop wait for a person.
  "/api/workspaces/:ws/agents/:id/compacting-clear",
  // D65: what an agent is listed under is the person's to say.
  "/api/workspaces/:ws/agents/:id/link",
  // D72: an agent never moves itself (or another) out of its scope.
  "/api/workspaces/:ws/agents/:id/move",
  // Issue 1182: an agent's folder: it asks with the held write agent_folder.
  "/api/workspaces/:ws/agents/:id/folder",
];

/**
 * Routes an agent's token may read but never change: the admin password
 * (R8), and Local environment (MODE-5).
 * Privileged actions stay with people (AG-5); its status is a read.
 */
export const AGENT_READ_ONLY: readonly string[] = [
  "/api/sudo-password",
  "/api/sudo-password/*",
  // MODE-5: Local environment, a person's setting (Settings › Command line).
  "/api/local-dev",
];

/**
 * Writes that are a person's (0.4.46): an agent's token may read these
 * paths but never change anything through them. What an agent may change
 * is listed, with why, in tests/unit/server/agent-write-routes.test.ts; a
 * write an agent wants goes through an approval (POST /api/approvals).
 */
export const AGENT_PERSON_WRITES: readonly string[] = [
  // Allow and Deny on a held write: never the asking agent's.
  "/api/approvals/:id/decide",
  // Issue 214: a schedule's standing Allow, and running it now: a person's.
  "/api/verify/schedules/allow",
  "/api/verify/schedules/run",
  // Issue 964: taking an Allow back: a person's too.
  "/api/verify/schedules/revoke",
  // Issue 1182: importing or removing an outside runner's run: a person's.
  "/api/verify/import",
  "/api/verify/remove",
  // Issue 52: the Coach's Run now is a person's (the handler checks too).
  "/api/coach/run",
  // Issue 52: Dismiss a Coach finding, and Undo it: a person's.
  "/api/coach/dismiss",
  "/api/coach/undismiss",
  // Issue 110: Apply a Coach finding's change (a held write): a person's.
  "/api/coach/apply",
  "/api/settings",
  // Issue 1371 Part 2: Undo of a setting an agent changed: the person's.
  "/api/settings/undo",
  "/api/scope",
  "/api/web-url",
  // Issue 666: an alias made this install's address: the owner's.
  "/api/web-url/adopt",
  // Issue 163: re-installs the launchd jobs (and may run sudo): a person's.
  "/api/keep-running-after-logout",
  // #299: the agents' sign-in token, into the secrets store: a person's.
  "/api/agents/signin-token",
  // Issue 339: the agents' sign-in accounts: a person's.
  "/api/agents/accounts",
  "/api/agents/accounts/token",
  "/api/agents/accounts/order",
  // Issue 1182: removing one, and its token.
  "/api/agents/accounts/remove",
  "/api/release/config",
  "/api/release/deploy",
  "/api/personas",
  "/api/personas/:id",
  "/api/report/send",
  // An agent saves a draft (stamped as its own); it never discards one.
  "/api/report/drafts/:id",
  "/api/report/github-send",
  "/api/editor/open",
  "/api/terminal/open",
  // Projects: made, renamed, removed and set up by a person (an agent asks).
  "/api/workspaces",
  "/api/workspaces/rename",
  "/api/workspaces/create",
  // Issue 1182: a reset to the blueprint replaces a project's entries.
  "/api/workspaces/seed",
  "/api/workspaces/settings",
  "/api/workspaces/services",
  "/api/workspaces/services/mode",
  "/api/workspaces/services/autostart",
  "/api/workspaces/:ws/hub-project",
  "/api/workspaces/:ws/hub-rename",
  "/api/workspaces/:ws/hub-create",
  // Another agent's life and record: a person's (an agent resumes and
  // imports only when opted in, above).
  "/api/workspaces/:ws/agents/:id/stop",
  "/api/workspaces/:ws/agents/:id/name",
  "/api/workspaces/:ws/agents/:id/remove",
  "/api/workspaces/:ws/agents/:id/keep",
  "/api/workspaces/:ws/agents/:id/settings",
  // Issue 199: what an agent may do without asking (agent_mode asks).
  "/api/workspaces/:ws/agents/:id/mode",
  // Issue 225: a project's mode, and its agents follow it (project_mode asks).
  "/api/workspaces/:ws/agent-modes",
  // Issue 352: change or remove a project's MCP server (project_mcp_* asks).
  "/api/workspaces/:ws/mcp-servers/:name",
  // Issue 1480: add or remove a project's app event feed (writes only: an
  // agent still reads the list; project_event_feed_* asks).
  "/api/workspaces/:ws/event-feeds",
  "/api/workspaces/:ws/event-feeds/:name",
  // Issue 103: a composer's Send types into an agent's session.
  "/api/workspaces/:ws/agents/:id/say",
  // Issue 96: the order a person sees their agents in is the person's.
  "/api/workspaces/:ws/agents/:id/order",
  // Issue 103: letting a web app use an agent is a person's.
  "/api/embed/keys",
  // Issue 334: the app keys a person made.
  "/api/embed/app-keys",
  "/api/agents/clear-stopped",
  "/api/agents/restore",
  "/api/agents/rotation",
  "/api/server-agent/runtime",
  "/api/server-agent/model",
  // The person's bell.
  "/api/notifications/read",
  "/api/notifications/clear",
  "/api/notifications/mute",
  "/api/notifications/looking",
  // Issue 172: the person's devices for push alerts.
  "/api/alerts/subscribe",
  "/api/alerts/unsubscribe",
  "/api/alerts/test",
  "/api/alerts/forget",
  "/api/alerts/presence",
  "/api/alerts/ack",
  // This install's Hub link.
  "/api/hub/connect",
  "/api/hub/disconnect",
  "/api/hub/sync",
  "/api/hub/link-suggestions",
  "/api/hub/connect-review",
  "/api/hub/names-check",
  // Issue 144: ending a gate slot early is a person's.
  "/api/gate-slots/end",
  // Issue 621: a CI runner's slot routes take its runner token only (an
  // agent asks with gate_slot_request); revoking one is a person's.
  "/api/gate-slots/ask",
  "/api/gate-slots/renew",
  "/api/gate-slots/release",
  "/api/gate-slots/runners/revoke",
  // Issue 625: the test boxes are a person's to change.
  "/api/gate-slots/boxes",
  "/api/gate-slots/boxes/remove",
  "/api/gate-slots/boxes/enable",
  // Issue 642: CI runner entries; an agent asks with gate_runner_entry_set.
  "/api/gate-slots/runner-entries",
  "/api/gate-slots/runner-entries/remove",
];

/** Commands a person runs, streamed over GET: an agent never starts one. */
export const AGENT_PERSON_RUNS: readonly string[] = [
  "/api/aws/login",
  "/api/workspace/exec",
  // The person's own reports, live from GitHub as the person.
  "/api/report/mine",
];

/** `/api/sessions/<id>/…`: a session's own routes (AG-4a-term's io). */
const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)(?:\/|$)/;

/**
 * Why an agent's token can't make this request, or null (SEC-1 §5):
 *  - a route in AGENT_FORBIDDEN;
 *  - a shell-grade route, unless it is its own session's
 *    (`/api/sessions/<its session id or name>/…`): agent start and resume
 *    mint tokens, the browser sessions are a person's.
 */
export function agentRefusal(
  p: AgentPrincipal,
  method: string,
  pathname: string,
  cls: RouteClass,
  /** The query: service exec's command and environment are checked. */
  search?: URLSearchParams,
  mode: () => InstallMode = installModeNow,
): string | null {
  // An agent runs a service's up, down or restart, and only on local
  // (the MCP tool's rule, held here too: a token can skip the tool).
  if (pathname === "/api/service/exec") {
    const cmd = search?.get("cmd") ?? "";
    const env = search?.get("env") ?? "local";
    if (!(LIFECYCLE_CMDS as readonly string[]).includes(cmd))
      return `${p.actor} can run ${LIFECYCLE_CMDS.join(", ")} only, not "${cmd}".`;
    if (env !== "local")
      return `${p.actor} can run a service on local only, not on ${env}.`;
  }
  if (pathMatches("/api/workspaces/:ws/agents/:id/clear-helpers", pathname))
    return `${p.actor} can't use ${pathname}: clearing an agent's helpers is a person's.`;
  if (
    AGENT_FORBIDDEN.some((r) => pathMatches(r, pathname)) ||
    (method !== "GET" &&
      method !== "HEAD" &&
      AGENT_READ_ONLY.some((r) => pathMatches(r, pathname)))
  )
    return `${p.actor} can't use ${pathname}: signing in, web.secret and the admin password are a person's.`;
  if (
    AGENT_PERSON_RUNS.some((r) => pathMatches(r, pathname)) ||
    (method !== "GET" &&
      method !== "HEAD" &&
      AGENT_PERSON_WRITES.some((r) => pathMatches(r, pathname)))
  )
    return `${p.actor} can't change ${pathname}: that is a person's to do. An agent asks for it through an approval.`;
  // D32's helpers count is the list's, no session's: read-grade.
  const m =
    pathname === "/api/sessions/helpers" ? null : SESSION_ROUTE.exec(pathname);
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
  // AG-14.4: MCP agent_resume, opted in, inside the agent's scope.
  const target = method === "POST" ? agentResumeTarget(pathname) : null;
  if (target)
    return (
      agentResumeRefusal(p, target.ws, target.id, mcpActions()) ??
      workspaceRefusal(p, method, pathname, cls, search, mode)
    );
  // AG-17.1: MCP agent_import, opted in, inside the agent's scope (its
  // list as well as its import: conversation titles are a person's).
  const imp = agentImportTarget(pathname);
  if (imp)
    return (
      // Issue 160: the bring-in itself is a held write, never the route.
      (imp.imports ? `${p.actor}: ${AGENT_IMPORT_HELD}.` : null) ??
      agentImportRefusal(p, imp.ws, mcpActions()) ??
      workspaceRefusal(p, method, pathname, cls, search, mode)
    );
  if (cls === "shell-grade")
    return `${p.actor} can't ${method === "GET" ? "open" : "use"} ${pathname}: starting or resuming an agent, and the browser sessions, are a person's.`;
  return workspaceRefusal(p, method, pathname, cls, search, mode);
}

/** The org config's mcp.actions; none when it can't be read. */
function mcpActions(): readonly string[] {
  try {
    return readMcpConfig().actions;
  } catch {
    return [];
  }
}

const LITERAL_PATHS = new Set(
  ROUTES.filter((r) => !/[:*]/.test(r.path)).map((r) => r.path),
);
const PROJECT_SEGMENTS = [":ws", ":project"];
const WS_ROUTES = ROUTES.flatMap((r) => {
  const at = r.path
    .split("/")
    .findIndex((seg) => PROJECT_SEGMENTS.includes(seg));
  return at < 0 ? [] : [{ path: r.path, at }];
});

export function routeWorkspace(pathname: string): string | null {
  if (LITERAL_PATHS.has(pathname)) return null;
  const hit = WS_ROUTES.find((r) => pathMatches(r.path, pathname));
  if (!hit) return null;
  const seg = pathname.split("/")[hit.at] ?? "";
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export function requestWorkspaces(
  pathname: string,
  search?: URLSearchParams,
): string[] {
  const out: string[] = [];
  const inPath = routeWorkspace(pathname);
  if (inPath !== null) out.push(inPath);
  for (const k of ["ws", "workspace"])
    for (const v of search?.getAll(k) ?? []) if (v) out.push(v);
  return out;
}

function readsOnly(method: string, cls: RouteClass): boolean {
  return (method === "GET" || method === "HEAD") && cls === "readonly";
}

export const STRICT_PERSON_READS: readonly string[] = [
  "/api/server-log",
  "/api/approvals",
  "/api/alerts",
  "/api/alerts/devices",
  "/api/alerts/stream",
  "/api/report/diagnostics",
  "/api/report/drafts",
  "/api/report/drafts/:id",
  "/api/report/shots/:id",
  "/api/report/shot-share",
  "/api/report/github-send/:id",
  "/api/perf-report/current",
  "/api/health/stream",
  "/api/service/daemons",
  "/api/catalog",
  "/api/release/config",
  "/api/release/branches",
  "/api/release/deploy/active",
  "/api/release/deploy",
  "/api/runs/last",
  "/api/workspaces/cleanup-preview",
  "/api/personas",
  "/api/personas/:id",
  "/api/verify/overview",
  "/api/verify/runs/:id",
  "/api/verify/runs/:id/report",
  "/api/verify/schedules",
  "/api/embed/app-keys",
  "/api/hub/github",
  "/api/hub/link-suggestions",
  "/api/hub/groups",
  "/api/hub/connect-review",
  "/api/hub/names-check",
  "/api/gate-slots/runners",
  "/api/gate-slots/runner-entries",
];

function workspaceRefusal(
  p: AgentPrincipal,
  method: string,
  pathname: string,
  cls: RouteClass,
  search: URLSearchParams | undefined,
  mode: () => InstallMode,
): string | null {
  if (
    (method === "GET" || method === "HEAD") &&
    STRICT_PERSON_READS.some((r) => pathMatches(r, pathname)) &&
    !isServerScope(p.workspace) &&
    mode() === "strict"
  )
    return `${p.actor} can't read this on a strict install: it is the person's own, across every project.`;
  const outside = requestWorkspaces(pathname, search).find(
    (ws) => !scopeReaches(p, ws),
  );
  if (outside === undefined) return null;
  if (readsOnly(method, cls) && mode() !== "strict") return null;
  return `${p.actor} can reach ${scopeWords(p)} only, not "${printableName(outside)}". A person adds the project to agents.<id>.grants in user.yml to widen it.`;
}

function printableName(v: string): string {
  return v.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
}

export function agentFocusRefusal(
  req: http.IncomingMessage,
  focused: string | null | undefined,
  what: string,
): string | null {
  const p = agentPrincipalOf(req);
  if (!p || !focused || scopeReaches(p, focused)) return null;
  return `${p.actor} can reach ${scopeWords(p)} only, not "${printableName(focused)}" (the focused project ${what}).`;
}

export const FOCUSED_READS: Readonly<Record<string, "named" | "focused">> = {
  "/api/workspaces/available-repos": "named",
  "/api/workspaces/settings": "named",
  "/api/workspaces/deps-check": "named",
  "/api/test-sources": "focused",
};

export function agentFocusedReadRefusal(
  req: http.IncomingMessage,
  pathname: string,
  search: URLSearchParams,
  focused: string | null | undefined,
  mode: () => InstallMode = installModeNow,
): string | null {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  const reads = Object.hasOwn(FOCUSED_READS, pathname)
    ? FOCUSED_READS[pathname]
    : undefined;
  if (!reads || (reads === "named" && search.get("workspace"))) return null;
  if (mode() !== "strict") return null;
  return agentFocusRefusal(req, focused, "this reads");
}

export function agentFocusMoved(
  req: http.IncomingMessage,
  checked: string | null | undefined,
  now: string | null | undefined,
): string | null {
  if (!agentPrincipalOf(req) || (checked ?? null) === (now ?? null))
    return null;
  return "the focused project changed after the check: start it again";
}

export function agentRowFilter(
  req: http.IncomingMessage,
  mode: () => InstallMode = installModeNow,
): ((ws: string) => boolean) | null {
  const p = agentPrincipalOf(req);
  if (!p || mode() !== "strict") return null;
  return (ws) => scopeReaches(p, ws);
}

/**
 * A GET that runs or changes something (route-classes.ts: `mutating` or
 * `shell-grade`; they stream over GET because an EventSource can't POST or
 * send a header). A cross-site `<img src>` or `fetch(…, { mode: "no-cors" })`
 * is a GET too, so these pass only:
 *  - from this server's own pages: Sec-Fetch-Site same-origin (or none, a
 *    URL the person typed), and an Origin, if any, that is allowed;
 *  - or with neither header (the CLI, curl, MCP) and a valid bearer, or
 *    (SIGNIN_GETS) a sign-in GET, which carries its own credential.
 * Sec-Fetch-Site same-site or cross-site: 403 `cross_site` (another port on
 * localhost is same-site, not same-origin).
 */
function mutatingGetRefusal(
  req: http.IncomingMessage,
  ctx: GuardContext,
  pathname: string,
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
  // A sign-in GET (route-classes.ts SIGNIN_GETS) may come with neither
  // header. A plain-http origin that isn't localhost (a LAN bind with
  // web.allow_plain_http_remote) is not "potentially trustworthy", so
  // Chromium sends it no Sec-Fetch-* headers, and a top-level navigation
  // sends no Origin: the person's own `web login --origin` link arrives
  // bare. That is safe: the request carries its own unguessable credential
  // (/auth a one-time code derived from web.secret, the poll its flow id),
  // which another site can't know, and a cross-site request from a modern
  // browser sends Sec-Fetch-Site or Origin, which the checks above refuse.
  if (
    site === undefined &&
    origin === undefined &&
    !principal &&
    !SIGNIN_GETS.some((r) => pathMatches(r, pathname))
  )
    return {
      ok: false,
      status: 403,
      code: "origin_rejected",
      error:
        "This request runs something: it needs this server's own page, or " +
        `\`Authorization: Bearer <token>\` (run \`${cli} web token --print\` in your own terminal for it).`,
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

/**
 * Issue 814: the test operator's act a request was let through as (the
 * request gate in index.ts sets it, after operatorRefusal), or none. Only
 * on a fixture session's request; it never makes the request the person's.
 */
const OPERATOR_ACTS = new WeakMap<http.IncomingMessage, OperatorAct>();

/** Remember what the request proved (for the audit trail). */
export function setPrincipal(
  req: http.IncomingMessage,
  p: Principal | null,
): void {
  if (p) PRINCIPALS.set(req, p);
}

/** Issue 621: the gate-only runner a request's token proves, if any. */
export function storedPrincipal(req: http.IncomingMessage): Principal | null {
  return PRINCIPALS.get(req) ?? null;
}

export function runnerPrincipalOf(
  req: http.IncomingMessage,
): RunnerPrincipal | null {
  const p = PRINCIPALS.get(req);
  return p?.kind === "gate-runner" ? p : null;
}

/** The agent a request's actor token proves (SEC-1c), if any. */
export function agentPrincipalOf(
  req: http.IncomingMessage,
): AgentPrincipal | null {
  const p = PRINCIPALS.get(req);
  if (p?.kind === "agent") return p;
  // Issue 796: an agent's read-only view is that agent everywhere a
  // handler refuses an agent's token or scopes it to its project, so no
  // handler can forget it. It carries no grants.
  if (p?.kind === "person-browser" && p.view) return viewAgent(p.view);
  return null;
}

/** Issue 796: the agent an agent's view stands for (agentRefusal's shape). */
export function viewAgent(v: {
  agent: string;
  workspace: string;
}): AgentPrincipal {
  return {
    kind: "agent",
    actor: v.agent as `agent:${string}`,
    workspace: v.workspace,
    grants: [],
    session: { name: "" },
  };
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
  // Issue 810: the fixture person is named as such, never the human;
  // issue 814: the test operator's act as the test operator.
  if (p?.kind === "person-browser" && p.session && p.fixture)
    return OPERATOR_ACTS.has(req) ? OPERATOR_PRINCIPAL : FIXTURE_PRINCIPAL;
  // Issue 796: an agent's view is the agent, never the person.
  if (p?.kind === "person-browser" && p.session && p.view) return p.view.agent;
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
  const p = PRINCIPALS.get(req);
  // Issue 796: an agent's read-only view, named as that agent (its session
  // was minted for the agent's own token), never the person.
  if (p?.kind === "person-browser" && p.view)
    return {
      kind: "agent",
      client: AGENT_VIEW_CLIENT,
      clientVersion: "-",
      mcpPid: null,
      session: "",
      agent: p.view.agent as `agent:${string}`,
      workspace: p.view.workspace,
    };
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
  // Issue 810: the fixture person is never the person. Every person-only
  // check of the form agentPrincipalOf(req) || auditActorOf(req) refuses
  // it, and the audit keeps it as a claim, labelled as such.
  if (p?.kind === "person-browser" && p.fixture)
    return {
      kind: "agent",
      client: OPERATOR_ACTS.has(req) ? OPERATOR_PRINCIPAL : FIXTURE_PRINCIPAL,
      clientVersion: "-",
      mcpPid: null,
      session: "",
      unverified: true,
    };
  return claimed ? { ...claimed, unverified: true } : null;
}

/**
 * Issue 810: whether a person-only check must refuse this request: an
 * agent's token, a claimed agent, the fixture person, or (issue 796) an
 * agent's read-only view.
 */
export function notAPersonOf(req: http.IncomingMessage): boolean {
  return !!agentPrincipalOf(req) || !!auditActorOf(req);
}

/**
 * Whether this request proved a person: the CLI's
 * bearer, or a signed-in browser that is neither an agent's view nor the
 * fixture person, with no agent's token or claim on it. A loopback caller
 * that proved nothing is not one.
 */
export function provenPersonOf(req: http.IncomingMessage): boolean {
  if (notAPersonOf(req)) return false;
  const p = PRINCIPALS.get(req);
  if (p?.kind === "person") return true;
  return p?.kind === "person-browser" && !p.view && !p.fixture;
}

/**
 * Whether this request is a test bed's CLI on the test-person path (issue
 * 636): a person token marked testPerson. A person-only write that widens
 * what runs refuses it (issue 642 review).
 */
export function testPersonOf(req: http.IncomingMessage): boolean {
  const p = PRINCIPALS.get(req);
  return p?.kind === "person" && p.testPerson === true;
}

/**
 * Issue 402: whether this request is a test install's fixture person
 * itself: its browser session, with no agent's token or claim on it.
 */
export function fixturePersonOf(req: http.IncomingMessage): boolean {
  const p = PRINCIPALS.get(req);
  return (
    p?.kind === "person-browser" &&
    p.fixture === true &&
    !actorFromHeaders(req.headers)
  );
}

export function markOperatorAct(
  req: http.IncomingMessage,
  act: OperatorAct,
): void {
  const p = PRINCIPALS.get(req);
  if (p?.kind === "person-browser" && p.fixture) OPERATOR_ACTS.set(req, act);
}

export function operatorActOf(req: http.IncomingMessage): OperatorAct | null {
  return OPERATOR_ACTS.get(req) ?? null;
}

/**
 * Issue 814: a person-only check that also lets the test operator through
 * for `act`, and only that act: a person, or a fixture session's request
 * the gate let through as `act`. Every other caller is refused as
 * notAPersonOf refuses it.
 */
export function personOrOperator(
  req: http.IncomingMessage,
  act: OperatorAct,
): boolean {
  if (!notAPersonOf(req)) return true;
  return !agentPrincipalOf(req) && OPERATOR_ACTS.get(req) === act;
}
