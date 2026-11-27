/**
 * Jest global teardown: every test process of this run has finished, so a
 * child server still recorded for it was never stopped (a test killed by a
 * timeout, a failure before its afterAll, --forceExit): stop its group.
 * Then remove global setup's stand-ins (its own temp dir only). Then the
 * home folder (home-strays.cjs): a folder this run left there
 * fails the run, and is removed; ended runs' folders are listed.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import homeStraysModule from "./home-strays.cjs";
import tmpLeaksModule from "./tmp-leaks.cjs";

const { homeStrays } = homeStraysModule;
const { leaksIn, judge } = tmpLeaksModule;
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
  const tmp = stubs ? leaksIn(path.dirname(stubs)) : { leaks: [], own: [] };
  for (const d of [...tmp.own, ...tmp.leaks.flatMap((l) => l.dirs)])
    fs.rmSync(d, { recursive: true, force: true });
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
  const { over, under } = judge(tmp.leaks, tmpLeakBaseline());
  if (under.length)
    process.stderr.write(
      [
        `[jest] ${under.length} test file(s) left fewer den-* folders than tests/fixtures/tmp-leak-baseline.json allows: lower their counts (0 removes the line).`,
        ...under.map((u) => `  ${u.file}: ${u.allowed} -> ${u.now}`),
      ].join("\n") + "\n",
    );
  if (over.length) {
    const msg = [
      `[jest] ${over.length} test file(s) left den-* folders in the temp folder (issue 1830): remove what a test makes in its afterAll, or make it in beforeAll. Removed now:`,
      ...over.flatMap((l) => [
        `  ${l.file} (${l.dirs.length}; the baseline allows ${l.allowed})`,
        ...l.dirs.map((d) => `    ${d}`),
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

function tmpLeakBaseline() {
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "tmp-leak-baseline.json",
  );
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}
