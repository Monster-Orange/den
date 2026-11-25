/**
 * Jest global teardown: every test process of this run has finished, so a
 * child server still recorded for it was never stopped (a test killed by a
 * timeout, a failure before its afterAll, --forceExit): stop its group.
 * Then remove global setup's stand-ins (its own temp dir only). Then the
 * home folder (issue 1567, home-strays.cjs): a folder this run left there
 * fails the run, and is removed; ended runs' folders are listed.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import homeStraysModule from "./home-strays.cjs";

const { homeStrays } = homeStraysModule;
import { reap } from "./child-reaper.mjs";

export default function globalTeardown() {
  const run = String(process.pid);
  const killed = reap((r) => String(r.run) === run);
  if (killed.length)
    process.stderr.write(
      `[jest] stopped ${killed.length} test server group(s) a test left running\n`,
    );
  const stubs = process.env.DEN_TEST_GLOBAL_STUBS;
  const home = os.homedir();
  const strays = homeStrays({ home, run });
  if (strays.ended.length)
    process.stderr.write(
      [
        `[jest] ${strays.ended.length} test folder(s) in ${home} left by test runs that have ended (look, then remove them):`,
        ...strays.ended.map((p) => `  ${p}`),
        `  rm -rf ${strays.ended.map((p) => JSON.stringify(path.join(home, p))).join(" ")}`,
      ].join("\n") + "\n",
    );
  // Issue 163: the real-CLI sentinel (tests/sentinel.ts). Any logged call
  // fails the run, even one whose caller swallowed the exit 99. setup.ts
  // already failed the test file; the names it recorded are listed here.
  const calls = [];
  const files = [];
  if (stubs) {
    const base = path.dirname(stubs);
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      names = [];
    }
    for (const f of names) {
      const full = path.join(base, f);
      if (/^sentinel-calls-[\w-]+\.log$/.test(f))
        calls.push(
          ...fs
            .readFileSync(full, "utf-8")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        );
      if (f === "sentinel-files.log")
        files.push(
          ...fs
            .readFileSync(full, "utf-8")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        );
    }
  }
  if (stubs && /\/den-test-global-\d+\/no-vendor-cli$/.test(stubs))
    fs.rmSync(path.dirname(stubs), { recursive: true, force: true });
  if (calls.length || files.length) {
    const msg = [
      `[jest] real-CLI sentinel: ${calls.length || files.length} call(s) to a program a test never runs (tests/sentinel.ts):`,
      ...[...new Set(calls)].map((c) => `  ${c}`),
      ...(files.length
        ? ["from:", ...[...new Set(files)].map((f) => `  ${f}`)]
        : [
            "from: a test file not named (a server or a child with no JEST_WORKER_ID)",
          ]),
    ].join("\n");
    process.stderr.write(msg + "\n");
    throw new Error(msg);
  }
  if (strays.mine.length) {
    const msg = [
      `[jest] ${strays.mine.length} test folder(s) of this run left in the home folder (${home}): a suite skipped its cleanup, or never reached its afterAll. Removed now:`,
      ...strays.mine.map((p) => `  ${p}`),
    ].join("\n");
    process.stderr.write(msg + "\n");
    throw new Error(msg);
  }
}
