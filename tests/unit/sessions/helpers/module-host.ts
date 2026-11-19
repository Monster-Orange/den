/**
 * Issue 563: a session host in its own process that says it loaded the
 * native PTY module described by the env (DEN_TEST_PTY: JSON of
 * { path, version, id }) and runs Den DEN_TEST_DEN (unset: its engine's),
 * with pipePtyFactory behind the seam:
 * `node --import <tsx loader> module-host.ts <stateDir>`.
 */
import { runSessionHost } from "../../../../src/shared/sessions/host.js";
import { pipePtyFactory } from "./fake-pty.js";

const stateDir = process.argv[2];
if (!stateDir) {
  console.error("usage: module-host.ts <stateDir>");
  process.exit(2);
}
const pty = process.env.DEN_TEST_PTY
  ? (JSON.parse(process.env.DEN_TEST_PTY) as {
      path: string;
      version: string | null;
      id: string | null;
    })
  : null;
void runSessionHost({
  stateDir,
  pty: () => ({ available: true, factory: pipePtyFactory }),
  ptyModule: () => pty,
  ...(process.env.DEN_TEST_DEN !== undefined
    ? { denVersion: process.env.DEN_TEST_DEN }
    : {}),
  launchdSession: null,
  fullDiskAccess: () => null,
  stateDirCheckMs: 1000,
}).then((code) => {
  if (code !== 0) process.exit(code);
});
