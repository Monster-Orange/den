/**
 * Issue 503: a session host in its own process with the real PTY module
 * behind the seam: `node --import <tsx loader> real-host.ts <stateDir>`.
 * Its open PTY masters are counted from outside (lsof, /proc).
 */
import { runSessionHost } from "../../../../src/shared/sessions/host.js";
import { loadPty } from "../../../../src/shared/sessions/pty.js";

const stateDir = process.argv[2];
if (!stateDir) {
  console.error("usage: real-host.ts <stateDir>");
  process.exit(2);
}
void runSessionHost({
  stateDir,
  pty: () => loadPty(),
  launchdSession: null,
  fullDiskAccess: () => null,
  stateDirCheckMs: 1000,
}).then((code) => {
  if (code !== 0) process.exit(code);
});
