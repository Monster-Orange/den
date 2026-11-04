import * as path from "path";
import { getDistRoot } from "../paths.js";

/**
 * Where a distribution keeps its own k6 suites, relative to the distribution
 * root: `<dist root>/tests/pillars/perf/<module>/test.js`. The engine ships
 * none; repo-owned suites are declared in each repo's manifest instead.
 */
export const PERF_DIST_TESTS_DIR = path.join("tests", "pillars", "perf");

/** The k6 entry file every distribution perf module provides. */
export const PERF_TEST_ENTRY = "test.js";

/** Absolute path of the distribution's perf suites directory. */
export function getPerfTestsRoot(root: string = getDistRoot()): string {
  return path.resolve(root, PERF_DIST_TESTS_DIR);
}

/** Absolute path of a distribution perf module's k6 entry file. */
export function getPerfTestFile(
  moduleName: string,
  root: string = getDistRoot(),
): string {
  return path.join(getPerfTestsRoot(root), moduleName, PERF_TEST_ENTRY);
}
