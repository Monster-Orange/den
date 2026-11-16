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
 */
import type * as http from "http";
import type { Socket } from "net";
import { isLoopbackAddress } from "./request-guard.js";
import { descendsFrom, loopbackPeerLine } from "../../shared/peer-process.js";
import { ACTOR_TOKEN_PREFIX } from "../../shared/actor-token.js";

/** ok: from the agent's own processes; elsewhere: proved not; unknown: couldn't tell. */
export type TokenCaller = "ok" | "elsewhere" | "unknown";

export interface BindingDeps {
  /**
   * The caller's pid from its port and the server's own (issue 196), now
   * or later. Given, the session check is `descends`.
   */
  peer?: (port: number, to: number) => number | null | Promise<number | null>;
  descends?: (pid: number, root: number) => boolean;
}

interface Peer {
  /** undefined: still looking. */
  pid?: number | null;
  /** The caller and its parents when it was found (the real lookup). */
  line?: number[];
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
  const settle = (pid: number | null, line?: number[]) => {
    peer.pid = pid;
    if (line) peer.line = line;
  };
  if (d.peer) {
    let v: number | null | Promise<number | null>;
    try {
      v = d.peer(from, to);
    } catch {
      v = null;
    }
    if (v instanceof Promise) peer.done = v.then(settle, () => settle(null));
    else settle(v);
    return;
  }
  peer.done = loopbackPeerLine(from, to).then(
    (line) => (line ? settle(line[0], line) : settle(null)),
    () => settle(null),
  );
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

/**
 * The audit detail of a refused agent token: both pids (issue 242), the
 * caller's and the agent's own (its session root), "?" for unknown.
 */
export function refusalDetail(o: {
  actor: string;
  from: Exclude<TokenCaller, "ok">;
  caller: number | null;
  root: number | null;
  method: string;
  path: string;
}): string {
  const where =
    o.from === "unknown"
      ? "a process Den couldn't place"
      : "outside the agent's own processes";
  return `${o.actor}'s token from ${where} (pid ${o.caller ?? "?"}, agent pid ${o.root ?? "?"}): ${o.method} ${o.path}`;
}
