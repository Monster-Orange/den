/**
 * Jest global teardown: every test process of this run has finished, so a
 * child server still recorded for it was never stopped (a test killed by a
 * timeout, a failure before its afterAll, --forceExit): stop its group.
 * A session host this run started that is still alive fails the run,
 * naming its test file, and is stopped (issue 501, test-hosts-core.cjs).
 * Then remove global setup's stand-ins (its own temp dir only).
 */
import * as fs from "fs";
import * as path from "path";
import { reap } from "./child-reaper.mjs";
import testHosts from "./test-hosts-core.cjs";

/**
 * Issue 501: the session hosts this run started (tagged with its id,
 * tests/test-hosts-core.cjs) that are still running once every test file has
 * finished. A host a test is still stopping gets DEN_TEST_HOST_GRACE_MS to
 * end. Those left are stopped, and the run fails, naming the test file each
 * came from. Never a host without this run's tag.
 */
async function leftHosts(run) {
  const found = testHosts.taggedHosts({ run });
  if (!found.length) return null;
  const left = await testHosts.survivors(found, testHosts.graceMs());
  if (!left.length) return null;
  await testHosts.stopHosts(left, 2_000);
  return [
    `[jest] ${left.length} session host(s) a test started outlived its test file (issue 501). Start a host with tests/test-hosts.ts (startTestHost, ownHosts), or a Den server with tests/child-servers.ts, and it is stopped with its test. Stopped now:`,
    ...left.map(
      (h) =>
        `  pid ${h.pid}, from ${h.file ?? "a test file not named (its spawn passed no env)"}`,
    ),
  ].join("\n");
}

export default async function globalTeardown() {
  const run = String(process.pid);
  const killed = reap((r) => String(r.run) === run);
  if (killed.length)
    process.stderr.write(
      `[jest] stopped ${killed.length} test server group(s) a test left running\n`,
    );
  const hostsMsg = await leftHosts(run);
  if (hostsMsg) process.stderr.write(hostsMsg + "\n");
  const stubs = process.env.DEN_TEST_GLOBAL_STUBS;
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
    throw new Error(hostsMsg ? `${msg}\n${hostsMsg}` : msg);
  }
  if (hostsMsg) throw new Error(hostsMsg);
}
