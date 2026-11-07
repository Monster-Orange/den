/**
 * Where the session host keeps its files, in the distribution's state dir
 * (getStateDir: the profile's ~/.<name>, or <PREFIX>_HOME):
 *
 *   sessions.sock         the host's unix socket (0600)
 *   sessions.lock         held only while a host starts
 *   sessions/<id>.json    a session's record (no argv, no env)
 *   sessions/<id>.log     its scrollback (0600)
 *
 * A unix socket's path has a small limit (sun_path: 104 bytes on macOS,
 * 108 on Linux). When `<stateDir>/sessions.sock` would be longer, the
 * socket goes in a short per-user dir instead, `/tmp/den-<uid>/` (0700),
 * named by a hash of the state dir: `<hash>.sock`. The host and every
 * client derive it the same way from the state dir, so nothing records it,
 * and it never depends on the environment ($TMPDIR differs between a
 * launchd service and a shell).
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface SessionPaths {
  socket: string;
  lock: string;
  dir: string;
}

/** A unix socket path's limit, in bytes (macOS's sun_path is 104, with NUL). */
export const MAX_SOCKET_PATH = 103;

/** The short per-user dir for a socket that won't fit in the state dir. */
export function shortSocketDir(
  uid: number | undefined = process.getuid?.(),
): string {
  return path.join("/tmp", `den-${uid ?? "user"}`);
}

/** The host's socket for `stateDir` (see the header). Pure. */
export function socketPathFor(
  stateDir: string,
  uid: number | undefined = process.getuid?.(),
): string {
  const inState = path.join(stateDir, "sessions.sock");
  if (Buffer.byteLength(inState) <= MAX_SOCKET_PATH) return inState;
  const hash = createHash("sha256")
    .update(path.resolve(stateDir))
    .digest("hex")
    .slice(0, 16);
  return path.join(shortSocketDir(uid), `${hash}.sock`);
}

export function sessionPaths(stateDir: string): SessionPaths {
  return {
    socket: socketPathFor(stateDir),
    lock: path.join(stateDir, "sessions.lock"),
    dir: path.join(stateDir, "sessions"),
  };
}

/**
 * Make the socket's dir when it is the short per-user one: 0700, and only
 * when it is a real directory this user owns that nobody else can enter
 * (another user could make /tmp/den-<uid> first). Throws with what is
 * wrong; a socket in the state dir needs nothing (the state dir is made
 * with the sessions dir).
 */
export function ensureSocketDir(
  socket: string,
  uid: number | undefined = process.getuid?.(),
): void {
  const dir = path.dirname(socket);
  if (dir !== shortSocketDir(uid)) return;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = fs.lstatSync(dir);
  const why = !st.isDirectory()
    ? "is not a directory"
    : uid !== undefined && st.uid !== uid
      ? `belongs to uid ${st.uid}, not ${uid}`
      : (st.mode & 0o077) !== 0
        ? `has mode ${(st.mode & 0o777).toString(8)}, not 700`
        : null;
  if (why)
    throw new Error(
      `the session socket's dir ${dir} ${why}: remove it, or use a shorter state dir`,
    );
}
