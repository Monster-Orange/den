/**
 * Jest setup file
 * Runs before each test suite
 */

import { afterAll, expect } from "@jest/globals";
import childProcess from "child_process";
import { guardSpawns, sentinelCalls, sentinelMark } from "./sentinel";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { scrubSecretEnv } from "./scrub-env";
import {
  armTripwire,
  configLocalChanges,
  configLocalSnapshot,
  tripwireCalls,
} from "./tripwire";

// No real credentials reach a test, or its failure output (scrub-env.ts).
scrubSecretEnv();

// No test reads the developer's own state dir: its web.secret would put a
// real person token on a test server's request (SEC-1a). A suite that needs
// a state dir sets DEN_HOME itself.
// Not created here: only a suite that writes state makes it.
if (!process.env.DEN_HOME)
  process.env.DEN_HOME = path.join(
    os.tmpdir(),
    `den-test-${process.pid}`,
    ".den",
  );

// Issue 144: no test takes or reads a turn in this machine's real gate-slot
// queue (a developer's own gate runs wait there). Not created here.
if (!process.env.DEN_GATE_DIR)
  process.env.DEN_GATE_DIR = path.join(
    os.tmpdir(),
    `den-test-${process.pid}`,
    "gate-slots",
  );

// No test asks this machine's login shell for its PATH (its startup files
// are the developer's), and no test finds a runtime CLI installed here
// (~/.local/bin/claude) by its install directories: AG-0.1's search is the
// env a test builds. A suite that tests the search sets its own (a fake
// shell script, temp dirs).
process.env.DEN_LOGIN_SHELL ??= "off";
// Issue 456: no test runs this machine's xattr to read a file's macOS
// quarantine; a suite that tests it injects its own reader
// (setQuarantineReader).
process.env.DEN_QUARANTINE_CHECK ??= "off";

// 0.4.48: no test opens a real browser (a person's browser filled with
// sign-in tabs from test runs). `web up` and every opener honour it; the
// opener refuses under JEST_WORKER_ID besides (browser-open.ts).
process.env.DEN_NO_OPEN = "1";

// 0.4.48 tripwires (tripwire.ts): no test reaches a person's browser or
// Terminal (open, osascript, xdg-open, x-www-browser are failing shims
// first on PATH), and none writes this checkout's config/local. A test
// file that does fails, naming what it did.
armTripwire();
const checkoutRoot = process.cwd();
const configLocalBefore = configLocalSnapshot(checkoutRoot);
afterAll(() => {
  const calls = tripwireCalls();
  const changes = configLocalChanges(checkoutRoot, configLocalBefore);
  if (calls.length || changes.length)
    throw new Error(
      [
        ...(calls.length
          ? [
              "This test file ran a program of the developer's machine that a test never runs (open, osascript, opctl…; stub it, or pass --no-open):",
              ...calls.map((c) => `  ${c}`),
            ]
          : []),
        ...(changes.length
          ? [
              "This test file wrote the checkout's config/local (use a temp DEN_ROOT):",
              ...changes.map((c) => `  ${c}`),
            ]
          : []),
      ].join("\n"),
    );
});
process.env.DEN_RUNTIME_DIRS ??= "";

// No test runs a vendor's CLI installed on this machine's PATH (AG-0.5's
// catalog: claude, codex, gemini, grok), not even its --version: inert
// stand-ins come first on the PATH every test and every server a test
// spawns inherits. They print nothing and exit 127. A suite that tests a
// runtime builds its own env with its own fakes.
const stubs = path.join(
  os.tmpdir(),
  `den-test-${process.pid}`,
  "no-vendor-cli",
);
if (!(process.env.PATH ?? "").split(path.delimiter).includes(stubs)) {
  fs.mkdirSync(stubs, { recursive: true });
  // D17: and gh (`web up` asks it who is signed in): never the real one.
  // And launchctl: no test may reach this machine's real launchd (a
  // bootout there stops real services); tests that need it shim their own.
  for (const bin of ["claude", "codex", "gemini", "grok", "gh", "launchctl"])
    fs.writeFileSync(path.join(stubs, bin), "#!/bin/sh\nexit 127\n", {
      mode: 0o755,
    });
  // Fakes go ahead of the real-CLI sentinel (issue 163, sentinel.ts).
  process.env.PATH = [stubs, process.env.PATH ?? "/usr/bin:/bin"].join(
    path.delimiter,
  );
}

// Issue 163: the real-CLI sentinel (sentinel.ts). A test file whose worker
// ran this machine's claude, op, doppler, security, launchctl, sudo, mkcert
// or gh (the stub logged it, exit 99) fails, naming the calls; the file is
// recorded for global teardown, which fails the run.
// Every spawn keeps it, even one whose env sets its own PATH.
guardSpawns(childProcess);
const sentinelBefore = sentinelMark();
afterAll(() => {
  const calls = sentinelCalls(sentinelBefore);
  if (!calls.length) return;
  const file = expect.getState().testPath ?? "an unnamed test file";
  const dir = process.env.DEN_TEST_SENTINEL;
  if (dir)
    try {
      fs.appendFileSync(
        path.join(path.dirname(dir), "sentinel-files.log"),
        `${path.relative(process.cwd(), file)}: ${calls.join(" | ")}\n`,
      );
    } catch {
      /* teardown still sees the calls */
    }
  throw new Error(
    [
      "This test file ran a program a test never runs (the real-CLI sentinel, tests/sentinel.ts): use a fake by full path, or a fake folder ahead of the sentinel:",
      ...calls.map((c) => `  ${c}`),
    ].join("\n"),
  );
});

// Set test environment
process.env.NODE_ENV = "test";

// Tests run as Den's own profile (den.yml at the checkout root).

// Increase test timeout for integration tests
jest.setTimeout(10000);

// Browser suites (*.browser.test.ts) drive remote browsers: their hooks
// (closing contexts, browsers and a test server) and tests get longer by
// default. A hook's default timeout is this one. A setting, never a number
// at the call: DEN_BROWSER_TEST_TIMEOUT_MS, 60 s when unset. A suite or test
// that names its own timeout keeps it.
{
  const file = expect.getState().testPath ?? "";
  if (/\.browser\.test\.ts$/.test(file)) {
    const raw = (process.env.DEN_BROWSER_TEST_TIMEOUT_MS ?? "").trim();
    const ms = /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : 60_000;
    jest.setTimeout(ms);
  }
}

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  // Keep log for debugging but silence in CI
  log: process.env.CI ? jest.fn() : console.log,
  debug: jest.fn(),
  // Keep error and warn for important messages
  error: console.error,
  warn: console.warn,
};

// Global test utilities
export {};
