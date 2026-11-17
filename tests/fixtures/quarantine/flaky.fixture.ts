/**
 * Issue 397: a stand-in flaky test for tests/unit/test-infra/quarantine.test.ts,
 * which runs it in a child jest. Not a *.test.ts: the suite never runs it
 * on its own. DEN_QUARANTINE_FIXTURE_FAIL=1 makes the flaky one fail.
 */
import { describe, expect, it } from "@jest/globals";

describe("quarantine fixture", () => {
  it("the flaky one", () => {
    expect(
      process.env.DEN_QUARANTINE_FIXTURE_FAIL === "1" ? "red" : "green",
    ).toBe("green");
  });

  it("the flaky one's neighbour", () => {
    expect(1 + 1).toBe(2);
  });
});
