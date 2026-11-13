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
 * One lookup per connection: keep-alive requests reuse it.
 */
import type * as http from "http";
import type { Socket } from "net";
import { isLoopbackAddress } from "./request-guard.js";
import { descendsFrom, loopbackPeerPid } from "../../shared/peer-process.js";

/** ok: from the agent's own processes; elsewhere: proved not; unknown: couldn't tell. */
export type TokenCaller = "ok" | "elsewhere" | "unknown";

export interface BindingDeps {
  peer?: (port: number) => number | null;
  descends?: (pid: number, root: number) => boolean;
}

const PEERS = new WeakMap<Socket, number | null>();

/** The pid on the other end of this request's connection (cached per connection). */
export function callerPid(
  req: http.IncomingMessage,
  d: BindingDeps = {},
): number | null {
  const sock = req.socket;
  if (!sock || !isLoopbackAddress(sock.remoteAddress)) return null;
  if (PEERS.has(sock)) return PEERS.get(sock) ?? null;
  const pid = (d.peer ?? loopbackPeerPid)(sock.remotePort ?? 0);
  PEERS.set(sock, pid);
  return pid;
}

/**
 * Whether `req` comes from the session whose pid is `root`. Not on
 * loopback (the edge, another machine): elsewhere. A caller Den can't
 * find, or no session pid: unknown (refused all the same).
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
  return (d.descends ?? descendsFrom)(pid, root) ? "ok" : "elsewhere";
}
