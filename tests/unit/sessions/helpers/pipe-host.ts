/**
 * A session host in its own process, with pipePtyFactory behind the PTY
 * seam (no native module): `node --import <tsx loader> pipe-host.ts <stateDir>`.
 */
import { runSessionHost } from "../../../../src/shared/sessions/host.js";
import { pipePtyFactory } from "./fake-pty.js";

const stateDir = process.argv[2];
if (!stateDir) {
  console.error("usage: pipe-host.ts <stateDir>");
  process.exit(2);
}
void runSessionHost({
  stateDir,
  pty: () => ({ available: true, factory: pipePtyFactory }),
}).then((code) => {
  if (code !== 0) process.exit(code);
});
