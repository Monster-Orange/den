/**
 * Jest setup file
 * Runs before each test suite
 */

import { afterAll } from "@jest/globals";
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

// No test asks this machine's login shell for its PATH (its startup files
// are the developer's), and no test finds a runtime CLI installed here
// (~/.local/bin/claude) by its install directories: AG-0.1's search is the
// env a test builds. A suite that tests the search sets its own (a fake
// shell script, temp dirs).
process.env.DEN_LOGIN_SHELL ??= "off";

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
  process.env.PATH = [stubs, process.env.PATH ?? "/usr/bin:/bin"].join(
    path.delimiter,
  );
}

// Set test environment
process.env.NODE_ENV = "test";

// Tests run as Den's own profile (den.yml at the checkout root).

// Increase test timeout for integration tests
jest.setTimeout(10000);

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
