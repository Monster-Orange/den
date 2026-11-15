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
 *
 * 0.4.48 tripwire (tripwire.ts): `open`, `osascript`, `xdg-open` and
 * `x-www-browser` are shims there too. Test runs opened sign-in tabs in a
 * person's browser. A shim logs the call (its program and first argument,
 * a link's query cut) for its worker, and fails; setup.ts fails the test
 * file that made one.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { alive, reap } from "./child-reaper.mjs";

const STUB_BINS = ["claude", "codex", "gemini", "grok", "gh", "launchctl"];
const OPENERS = ["open", "osascript", "xdg-open", "x-www-browser"];
const OPENER_SHIM = `#!/bin/sh
# A test tripwire (tests/tripwire.ts): this program never runs in a test.
a="\${1%%\\?*}"
printf '%s %s\\n' "$(basename "$0")" "$(printf '%s' "$a" | head -c 120 | tr '\\n' ' ')" >> "$(dirname "$0")/../opener-calls-\${JEST_WORKER_ID:-0}.log"
exit 1
`;

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
  for (const bin of OPENERS)
    fs.writeFileSync(path.join(stubs, bin), OPENER_SHIM, { mode: 0o755 });
  process.env.PATH = [stubs, process.env.PATH ?? "/usr/bin:/bin"].join(
    path.delimiter,
  );
  process.env.DEN_TEST_GLOBAL_STUBS = stubs;
}
