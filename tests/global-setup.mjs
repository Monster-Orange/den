/**
 * Jest global setup: name this run for tests/child-servers.ts, and stop the
 * child servers an earlier run left behind (its jest process is gone: killed
 * before its global teardown ran). Another run still going is left alone.
 *
 * Also: inert stand-ins for this machine's launchctl, gh and the vendor CLIs
 * go first on the REAL PATH, which every worker (and every spawn in it, with
 * or without an `env`) inherits. setup.ts's PATH change alone lives in each
 * test file's sandboxed process.env, which a spawn without `env` never
 * sees. They print nothing and exit 127.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { alive, reap } from "./child-reaper.mjs";

const STUB_BINS = ["claude", "codex", "gemini", "grok", "gh", "launchctl"];

export default function globalSetup() {
  process.env.DEN_TEST_RUN = String(process.pid);
  const killed = reap((r) => !alive(Number(r.run)) && !alive(Number(r.owner)));
  if (killed.length)
    process.stderr.write(
      `[jest] stopped ${killed.length} test server group(s) an earlier run left behind\n`,
    );
  const stubs = path.join(
    os.tmpdir(),
    `den-test-global-${process.pid}`,
    "no-vendor-cli",
  );
  fs.mkdirSync(stubs, { recursive: true });
  for (const bin of STUB_BINS)
    fs.writeFileSync(path.join(stubs, bin), "#!/bin/sh\nexit 127\n", {
      mode: 0o755,
    });
  process.env.PATH = [stubs, process.env.PATH ?? "/usr/bin:/bin"].join(
    path.delimiter,
  );
  process.env.DEN_TEST_GLOBAL_STUBS = stubs;
}
