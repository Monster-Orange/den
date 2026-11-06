/**
 * Jest global teardown: every test process of this run has finished, so a
 * child server still recorded for it was never stopped (a test killed by a
 * timeout, a failure before its afterAll, --forceExit): stop its group.
 */
import { reap } from "./child-reaper.mjs";

export default function globalTeardown() {
  const run = String(process.pid);
  const killed = reap((r) => String(r.run) === run);
  if (killed.length)
    process.stderr.write(
      `[jest] stopped ${killed.length} test server group(s) a test left running\n`,
    );
}
