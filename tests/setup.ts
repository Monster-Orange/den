/**
 * Jest setup file
 * Runs before each test suite
 */

import * as os from "os";
import * as path from "path";
import { scrubSecretEnv } from "./scrub-env";

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
process.env.DEN_RUNTIME_DIRS ??= "";

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
