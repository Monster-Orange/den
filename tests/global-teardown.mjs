/**
 * Jest global teardown: every test process of this run has finished, so a
 * child server still recorded for it was never stopped (a test killed by a
 * timeout, a failure before its afterAll, --forceExit): stop its group.
 * Then remove global setup's stand-ins (its own temp dir only).
 */
import * as fs from "fs";
import * as path from "path";
import { reap } from "./child-reaper.mjs";

export default function globalTeardown() {
  const run = String(process.pid);
  const killed = reap((r) => String(r.run) === run);
  if (killed.length)
    process.stderr.write(
      `[jest] stopped ${killed.length} test server group(s) a test left running\n`,
    );
  const stubs = process.env.DEN_TEST_GLOBAL_STUBS;
  if (stubs && /\/den-test-global-\d+\/no-vendor-cli$/.test(stubs))
    fs.rmSync(path.dirname(stubs), { recursive: true, force: true });
}
