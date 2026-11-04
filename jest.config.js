export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    // Stub ESM-only packages so UI modules can be unit-tested under Jest/CJS
    "^chalk$": "<rootDir>/tests/__mocks__/chalk.cjs",
    "^inquirer$": "<rootDir>/tests/__mocks__/inquirer.cjs",
    // k6 runtime modules — only resolvable inside the k6 (Goja) runtime.
    // Stub so pure helpers of k6 scripts can be unit-tested under Jest.
    "^k6/http$": "<rootDir>/tests/__mocks__/k6-http.cjs",
    "^(\\.{1,2}/.*)\\.js$": "$1",
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
  // On 2-vCPU CI runners jest runs ONE worker (availableParallelism − 1), so
  // every suite's ts-jest transform state accumulates in a single heap —
  // measured >1 GB and still climbing by suite ~68 of this repo's schedule.
  // Recycle the worker before that growth ever meets a runner's memory
  // ceiling; dev machines with many workers stay far below the limit. (This
  // is hardening, NOT the fix for the 2026-07/08 CI hangs — those were an
  // infinite mkdirSync loop on a /proc fixture; see dev-metrics.emit.test.ts.)
  workerIdleMemoryLimit: "1GB",
};
