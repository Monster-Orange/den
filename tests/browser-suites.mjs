// Testing policy 1: the test files that drive a real browser (Playwright,
// through tests/unit/helpers/browser.ts) but are not named *.browser.test.ts.
// A draft pull request skips the browser specs (DEN_TEST_BROWSER=skip in
// jest.config.js): these files too, since a draft run installs no browser.
//
// tests/unit/test-infra/ci-draft-fanout.test.ts fails when a test file
// launches a browser and is neither named *.browser.test.ts nor listed here.
export const BROWSER_SUITES = [
  "tests/unit/server/changelog-dialog.integration.test.ts",
  "tests/unit/server/scope-menus.integration.test.ts",
  "tests/unit/server/settings-page.integration.test.ts",
  "tests/unit/server/theme-favicon.integration.test.ts",
  "tests/unit/server/theme-switch-isolation.test.ts",
];

/** A regex for a path that is a browser spec: *.browser.test.ts or one of these files. */
export const browserSuiteRegex = () =>
  "(\\.browser\\.test\\.ts|/(" + BROWSER_SUITES.map((f) => f.replace(/[.]/g, "\\.")).join("|") + "))$";
