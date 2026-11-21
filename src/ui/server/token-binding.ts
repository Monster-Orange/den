/**
 * #70 (SEC-3 T8): an agent's token counts only from its own agent's
 * processes. A same-user process can read another agent's token (ps once
 * showed it in the environment; a 0600 file is readable by the same user
 * too), so the token alone never proves the caller. The server finds the
 * process on the other end of the request's loopback connection and asks
 * whether it runs inside the token's session (the session's own pid, as
 * the session host recorded it). From anywhere else, even with the right
 * token: refused, and audited.
 *
 * One lookup per connection: keep-alive requests reuse it. Issue 242: it
 * starts when the connection arrives (watchPeer, the server's
 * "connection" event) and never holds the event loop, so a busy Den or a
 * caller that gives up soon can't outrun it. An agent's request waits for
 * it (peerSettled, agents.token_peer_wait_ms) before its token is judged.
 *
 * Issue 609: a caller Den can't place says why (PeerMiss), and one that
 * had already closed its connection is "gone": still refused, but nothing
 * is there to answer, so it is audited apart from a live agent's refusal.
 */
import type * as http from "http";
import type { Socket } from "net";
import {
  hostAllowed,
  isLoopbackAddress,
  type GuardContext,
} from "./request-guard.js";
import { EDGE_PROOF_HEADER } from "../../shared/edge/proof.js";
import {
  descendsFrom,
  loopbackPeerFind,
  parentLine,
  type LookupMiss,
} from "../../shared/peer-process.js";
import { ACTOR_TOKEN_PREFIX } from "../../shared/actor-token.js";
import {
  IN_A_SESSION,
  NOT_CHECKED,
  NOT_LOOPBACK,
} from "../../shared/person-here.js";

/** ok: from the agent's own processes; elsewhere: proved not; unknown: couldn't tell. */
export type TokenCaller = "ok" | "elsewhere" | "unknown";

/**
 * Issue 609: why a caller wasn't placed: the lookup's own reason, or
 * waiting (the request's wait ended while it ran), or gone (the caller
 * closed its connection before it was placed).
 */
export type PeerMiss = LookupMiss | "waiting" | "gone";

type PeerAnswer = number | null | { miss: LookupMiss };

export interface BindingDeps {
  /**
   * The caller's pid from its port and the server's own (issue 196), now
   * or later; or why there is none. Given, the session check is `descends`.
   */
  peer?: (port: number, to: number) => PeerAnswer | Promise<PeerAnswer>;
  descends?: (pid: number, root: number) => boolean;
}

interface Peer {
  /** undefined: still looking. */
  pid?: number | null;
  /** The caller and its parents when it was found (the real lookup). */
  line?: number[];
  /** Issue 609: why it wasn't found. */
  miss?: LookupMiss;
  /** Issue 609: the caller closed its end. */
  gone?: boolean;
  done: Promise<void>;
}

const PEERS = new WeakMap<Socket, Peer>();

/**
 * Start finding the process on the other end of `sock` (loopback only;
 * once per connection). Called as the connection arrives.
 */
export function watchPeer(sock: Socket, d: BindingDeps = {}): void {
  if (!sock || PEERS.has(sock) || !isLoopbackAddress(sock.remoteAddress))
    return;
  // Both ends: a client port alone can be shared with another loopback
  // connection (Linux reuses it per destination), which reads as no pid.
  const from = sock.remotePort ?? 0;
  const to = sock.localPort ?? 0;
  const peer: Peer = { done: Promise.resolve() };
  PEERS.set(sock, peer);
  // Issue 609: the caller's end closing (it gave up, or finished).
  const gone = () => {
    peer.gone = true;
  };
  sock.once?.("end", gone);
  sock.once?.("close", gone);
  const answer = (v: PeerAnswer) => {
    if (typeof v === "number") peer.pid = v;
    else {
      peer.pid = null;
      peer.miss = v?.miss ?? "none";
    }
  };
  if (d.peer) {
    let v: PeerAnswer | Promise<PeerAnswer>;
    try {
      v = d.peer(from, to);
    } catch {
      v = { miss: "failed" };
    }
    if (v instanceof Promise)
      peer.done = v.then(answer, () => answer({ miss: "failed" }));
    else answer(v);
    return;
  }
  peer.done = loopbackPeerFind(from, to).then(
    (f) => {
      if ("line" in f) {
        peer.pid = f.line[0];
        peer.line = f.line;
      } else answer(f);
    },
    () => answer({ miss: "failed" }),
  );
}

/**
 * Issue 609: why this request's caller wasn't placed, or null when it
 * was (or isn't on loopback). A caller that closed its connection and
 * wasn't found: gone, whatever the lookup said.
 */
export function callerMiss(req: http.IncomingMessage): PeerMiss | null {
  const sock = req.socket;
  if (!sock || !isLoopbackAddress(sock.remoteAddress)) return null;
  const peer = PEERS.get(sock);
  if (!peer) return null;
  if (typeof peer.pid === "number") return null;
  const closed = peer.gone === true || sock.destroyed || sock.readableEnded;
  if (closed && peer.miss !== "several") return "gone";
  return peer.pid === undefined ? "waiting" : (peer.miss ?? "none");
}

/**
 * Wait, at most `waitMs`, for this request's caller to be found. Not on
 * loopback: at once.
 */
export async function peerSettled(
  req: http.IncomingMessage,
  waitMs: number,
  d: BindingDeps = {},
): Promise<void> {
  const sock = req.socket;
  if (!sock || !isLoopbackAddress(sock.remoteAddress)) return;
  watchPeer(sock, d);
  const peer = PEERS.get(sock);
  if (!peer || peer.pid !== undefined) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    peer.done,
    new Promise<void>((r) => {
      timer = setTimeout(r, Math.max(0, waitMs));
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}

/** The pid on the other end of this request's connection, once found. */
export function callerPid(
  req: http.IncomingMessage,
  d: BindingDeps = {},
): number | null {
  const sock = req.socket;
  if (!sock || !isLoopbackAddress(sock.remoteAddress)) return null;
  watchPeer(sock, d);
  return PEERS.get(sock)?.pid ?? null;
}

/**
 * Whether `req` comes from the session whose pid is `root`. Not on
 * loopback (the edge, another machine): elsewhere. A caller Den can't
 * find (yet), or no session pid: unknown (refused all the same).
 */
export function tokenCaller(
  req: http.IncomingMessage,
  root: number | null,
  d: BindingDeps = {},
): TokenCaller {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return "elsewhere";
  if (!root || root <= 0) return "unknown";
  const pid = callerPid(req, d);
  if (pid === null) return "unknown";
  const line = PEERS.get(req.socket)?.line;
  // Its parents as they were when it connected (it may be gone now).
  if (line && !d.descends && line.includes(root)) return "ok";
  return (d.descends ?? descendsFrom)(pid, root) ? "ok" : "elsewhere";
}

/**
 * Issue 242: how long this request waits for its caller to be found
 * (peerSettled): `waitMs` for an agent's token with binding on; null for
 * anything else, which goes on at once, as before.
 */
export function agentPeerWait(
  req: http.IncomingMessage,
  binding: { on: boolean; waitMs: number },
): number | null {
  const auth = req.headers?.authorization;
  if (!auth || !binding.on) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  return m && m[1].startsWith(ACTOR_TOKEN_PREFIX) ? binding.waitMs : null;
}

/** Issue 609: each reason as the audit says it. */
const MISS_WORDS: Record<PeerMiss, string> = {
  timeout: "the lookup timed out",
  failed: "the lookup failed",
  none: "no matching connection",
  several: "more than one matching connection",
  waiting: "the lookup was still running",
  gone: "the caller had gone",
};

/**
 * The audit detail of a refused agent token: both pids (issue 242), the
 * caller's and the agent's own (its session root), "?" for unknown; and,
 * for an unplaced caller, why (issue 609).
 */
export function refusalDetail(o: {
  actor: string;
  from: Exclude<TokenCaller, "ok">;
  caller: number | null;
  root: number | null;
  method: string;
  path: string;
  why?: PeerMiss | null;
}): string {
  const where =
    o.from === "unknown"
      ? "a process Den couldn't place"
      : "outside the agent's own processes";
  const why = o.from === "unknown" && o.why ? `${MISS_WORDS[o.why]}; ` : "";
  return `${o.actor}'s token from ${where} (${why}pid ${o.caller ?? "?"}, agent pid ${o.root ?? "?"}): ${o.method} ${o.path}`;
}

/**
 * Sign-in: this request's caller and its parents up to init, whole: as
 * found when it connected when that line reached init, else read now.
 * Null when the caller wasn't placed or a parent can't be read.
 */
export function callerLine(
  req: http.IncomingMessage,
  d: { line?: (pid: number) => number[] | null } = {},
): number[] | null {
  const pid = callerPid(req);
  if (pid === null) return null;
  const seen = PEERS.get(req.socket)?.line;
  if (!d.line && seen && seen[0] === pid && seen[seen.length - 1] === 1)
    return seen;
  return (d.line ?? ((p: number) => parentLine(p)))(pid);
}

/**
 * Sign-in: why the server won't register a sign-in link or let a browser
 * in for this caller (the CLI's bearer), or null when it may. It must be
 * on loopback, placed, with a whole line that holds no running session's
 * root. Anything it can't tell refuses.
 */
export function personCallerRefusal(o: {
  loopback: boolean;
  /** It came through the edge, or Den can't tell (forwardedRequest). */
  forwarded?: boolean;
  line: number[] | null;
  roots: number[] | null;
}): string | null {
  if (!o.loopback || o.forwarded) return NOT_LOOPBACK;
  if (!o.line || o.line.length === 0 || !o.roots) return NOT_CHECKED;
  return o.line.some((p) => o.roots!.includes(p)) ? IN_A_SESSION : null;
}

/** Headers a proxy in front of Den adds: any of them, and it was forwarded. */
const FORWARD_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  EDGE_PROOF_HEADER,
];

/**
 * Sign-in: whether this request came through the edge (or any proxy), or
 * Den can't tell: its Host isn't one of this server's loopback names, or it
 * carries a forwarding header. The loopback peer is then the proxy, never
 * the caller.
 */
export function forwardedRequest(
  req: http.IncomingMessage,
  ctx: Pick<GuardContext, "port" | "loopbackNames" | "edgeHosts" | "lanHosts">,
): boolean {
  const h = req.headers ?? {};
  const host = Array.isArray(h.host) ? h.host[0] : h.host;
  if (hostAllowed(host, ctx) !== "loopback") return true;
  return FORWARD_HEADERS.some((k) => h[k] !== undefined);
}
