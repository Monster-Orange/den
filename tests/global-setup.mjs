/**
 * Jest global setup: name this run for tests/child-servers.ts, and stop the
 * child servers an earlier run left behind (its jest process is gone: killed
 * before its global teardown ran). Another run still going is left alone.
 */
import { alive, reap } from "./child-reaper.mjs";

export default function globalSetup() {
  process.env.DEN_TEST_RUN = String(process.pid);
  const killed = reap((r) => !alive(Number(r.run)) && !alive(Number(r.owner)));
  if (killed.length)
    process.stderr.write(
      `[jest] stopped ${killed.length} test server group(s) an earlier run left behind\n`,
    );
}
