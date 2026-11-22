import { browserSuiteRegex } from "./tests/browser-suites.mjs";
import { dockerSuiteRegex } from "./tests/docker-suites.mjs";
import quarantineList from "./tests/quarantine.cjs";

const { loadQuarantine, quarantinedFiles, quarantineMode } = quarantineList;

// den#143: on a busy machine fewer workers means fewer load flakes. A
// setting, never a number here: DEN_TEST_WORKERS (8, or 50%); unset or
// blank, jest's own default. CI's test shards set 2; `npm run preflight` asks for 8.
const workers = (process.env.DEN_TEST_WORKERS ?? "").trim();

// Issue 296: DEN_TEST_DOCKER=skip leaves out the files that start Docker
// containers, =only runs just them (tests/docker-suites.mjs says why).
// Unset or blank, every file.
const docker = (process.env.DEN_TEST_DOCKER ?? "").trim();
if (docker && docker !== "skip" && docker !== "only")
  throw new Error(`DEN_TEST_DOCKER is skip or only (got "${docker}")`);
const dockerIgnored = {
  skip: [dockerSuiteRegex()],
  only: [`^(?!.*${dockerSuiteRegex()})`],
}[docker];

// Testing policy 1: DEN_TEST_BROWSER=skip leaves out the browser specs
// (*.browser.test.ts, and the files tests/browser-suites.mjs lists). CI sets
// it on a draft pull request: static checks and unit tests only. Unset or
// blank, every file.
const browser = (process.env.DEN_TEST_BROWSER ?? "").trim();
if (browser && browser !== "skip")
  throw new Error(`DEN_TEST_BROWSER is skip or blank (got "${browser}")`);
const browserIgnored = browser === "skip" ? [browserSuiteRegex()] : [];

// Issue 397: DEN_TEST_QUARANTINE (tests/quarantine.cjs). Off unless set:
// only CI's pull request runs set it. "exclude" skips the quarantined
// tests, "only" runs just them (only their files). Both use the
// quarantine test environment and add the quarantine reporter's table.
const quarantine = quarantineMode();
const quarantineIgnored =
  quarantine === "only"
    ? (() => {
        const files = quarantinedFiles(loadQuarantine().entries);
        return files.length
          ? [
              `^(?!.*/(?:${files.map((f) => f.replace(/[.]/g, "\\.")).join("|")})$)`,
            ]
          : [".*"];
      })()
    : [];
const ignored =
  dockerIgnored || quarantineIgnored.length || browserIgnored.length
    ? [...(dockerIgnored ?? []), ...quarantineIgnored, ...browserIgnored]
    : undefined;

export default {
  ...(workers
    ? { maxWorkers: /^\d+$/.test(workers) ? Number(workers) : workers }
    : {}),
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  ...(ignored
    ? { testPathIgnorePatterns: ["/node_modules/", ...ignored] }
    : {}),
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    // Stub ESM-only packages so UI modules can be unit-tested under Jest/CJS
    "^chalk$": "<rootDir>/tests/__mocks__/chalk.cjs",
    "^inquirer$": "<rootDir>/tests/__mocks__/inquirer.cjs",
    // k6 runtime modules — only resolvable inside the k6 (Goja) runtime.
    // Stub so pure helpers of k6 scripts can be unit-tested under Jest.
    "^k6/http$": "<rootDir>/tests/__mocks__/k6-http.cjs",
    "^(\\.{1,2}/.*)\\.js$": "$1",
    // The pages' modules import each other by the URL the server serves
    // them at ("/term-pane.js"): under Jest, the file in public/.
    "^/([A-Za-z0-9_-]+)\\.js$": "<rootDir>/src/ui/server/public/$1.js",
    // …and the kit's at /kit/<file>: the file in packages/den-ui/src.
    "^/kit/([A-Za-z0-9_-]+)\\.js$": "<rootDir>/packages/den-ui/src/$1.js",
  },
  transform: {
    "^.+\\.[jt]sx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "./tsconfig.jest.json",
        // Type-checking is a separate step (`tsc --noEmit -p
        // tsconfig.typecheck.json` in `make preflight`);
        // disabling it here keeps Jest fast and avoids transitive TS errors
        // in files not directly under test.
        diagnostics: false,
      },
    ],
  },
  collectCoverageFrom: [
    "src/shared/**/*.ts",
    "src/ui/**/*.ts",
    "!src/shared/**/*.d.ts",
    "!src/shared/**/index.ts",
    "!**/*.test.ts",
    // Exclude files that are inherently hard to unit test:
    "!src/shared/auth/auth0-helper.ts", // Browser automation — tested via E2E
    "!src/shared/auth/token-refresh.ts", // Browser automation — tested via E2E
    "!src/shared/auth/api-token.ts", // Auth0 ROPC via `op`/HTTP — tested via integration/E2E
    "!src/shared/auth/token-providers/auth0.ts", // Auth0 ROPC over HTTP — tested via integration/E2E
    "!src/shared/environment-manager/service-runner.ts", // Process orchestration — focused unit tests + CLI smoke checks
    "!src/shared/terminal/tabs.ts", // Terminal automation — helper behavior has focused unit tests
    "!src/ui/cli/test-runner.ts", // Interactive CLI + process-spawning — tested via E2E
    "!src/ui/cli/web-command.ts", // Browser/server orchestration — helper behavior has focused unit tests
    "!src/ui/cli/index.ts", // Interactive CLI entry point — tested via E2E
    "!src/ui/cli/prompts.ts", // Interactive inquirer prompts — tested via E2E
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  coverageDirectory: "<rootDir>/coverage",
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  // A test's child servers never outlive the run (tests/child-servers.ts),
  // and no spawn reaches this machine's launchctl, gh or vendor CLIs.
  globalSetup: "<rootDir>/tests/global-setup.mjs",
  globalTeardown: "<rootDir>/tests/global-teardown.mjs",
  // On 2-vCPU CI runners jest runs ONE worker (availableParallelism − 1), so
  // every suite's ts-jest transform state accumulates in a single heap —
  // measured >1 GB and still climbing by suite ~68 of this repo's schedule.
  // Recycle the worker before that growth ever meets a runner's memory
  // ceiling; dev machines with many workers stay far below the limit. (This
  // is hardening, NOT the fix for the 2026-07/08 CI hangs — those were an
  // infinite mkdirSync loop on a /proc fixture; see dev-metrics.emit.test.ts.)
  workerIdleMemoryLimit: "1GB",
  // Last, so it wins over testEnvironment above (issue 397).
  ...(quarantine
    ? {
        testEnvironment: "<rootDir>/tests/quarantine-env.cjs",
        reporters: ["default", "<rootDir>/tests/quarantine-reporter.cjs"],
      }
    : {}),
};
