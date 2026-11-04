import { describe, expect, it } from "@jest/globals";
import * as path from "path";
import {
  PERF_DIST_TESTS_DIR,
  getPerfTestFile,
  getPerfTestsRoot,
} from "../../../src/shared/perf/test-paths.js";

describe("perf test paths", () => {
  const root = path.resolve("/srv/dist");

  it("keeps distribution suites under tests/pillars/perf", () => {
    expect(PERF_DIST_TESTS_DIR).toBe(path.join("tests", "pillars", "perf"));
    expect(getPerfTestsRoot(root)).toBe(
      path.join(root, "tests", "pillars", "perf"),
    );
  });

  it("resolves a module's k6 entry file under the distribution root", () => {
    expect(getPerfTestFile("api-health", root)).toBe(
      path.join(root, "tests", "pillars", "perf", "api-health", "test.js"),
    );
  });
});
