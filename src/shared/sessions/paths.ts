/**
 * Where the session host keeps its files, in the distribution's state dir
 * (getStateDir: the profile's ~/.<name>, or <PREFIX>_HOME):
 *
 *   sessions.sock         the host's unix socket (0600)
 *   sessions.lock         held only while a host starts
 *   sessions/<id>.json    a session's record (no argv, no env)
 *   sessions/<id>.log     its scrollback (0600)
 */
import * as path from "path";

export interface SessionPaths {
  socket: string;
  lock: string;
  dir: string;
}

export function sessionPaths(stateDir: string): SessionPaths {
  return {
    socket: path.join(stateDir, "sessions.sock"),
    lock: path.join(stateDir, "sessions.lock"),
    dir: path.join(stateDir, "sessions"),
  };
}

/** A unix socket path's limit, in bytes (macOS's sun_path is 104, with NUL). */
export const MAX_SOCKET_PATH = 103;
