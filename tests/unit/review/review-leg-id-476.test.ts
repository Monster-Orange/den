/**
 * Issue 476: a review leg is narrowed by its id. Every launch Den builds
 * (the first start, a resume after a restart, a rotation) goes through
 * agent-ops launchInput, which adds the leg's narrowing for an id with the
 * leg prefix. Fail-safe: taking that name only narrows an agent.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  isReviewLegId,
  reviewLegId,
  reviewLegLaunch,
} from "../../../src/shared/agents/review-leg.js";
import { AGENT_ID_RE } from "../../../src/shared/agents/records.js";

describe("a review leg's id", () => {
  it("is a valid agent id with the leg prefix, made from the leg id", () => {
    const id = reviewLegId("0123456789abcdef0123456789abcdef");
    expect(AGENT_ID_RE.test(id)).toBe(true);
    expect(isReviewLegId(id)).toBe(true);
    expect(isReviewLegId("builder-1")).toBe(false);
    expect(() => reviewLegId("not hex")).toThrow();
  });

  it("narrows the launch to review_submit; any other id launches as before", () => {
    expect(reviewLegLaunch(reviewLegId("0".repeat(32)))).toEqual({
      review: { tools: ["review_submit"] },
    });
    expect(reviewLegLaunch("builder-1")).toEqual({});
  });

  it("every launch Den builds carries it (agent-ops launchInput)", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "ui", "cli", "agent-ops.ts"),
      "utf-8",
    );
    const start = src.indexOf("function launchInput(");
    const end = src.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(0);
    expect(src.slice(start, end)).toContain("...reviewLegLaunch(id)");
  });
});
