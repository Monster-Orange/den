/**
 * Hardening (issue 362): the server log never holds a sign-in or pairing
 * request's id. Each id route is written with ":id" in its place; other
 * routes are written as they came.
 */
import { describe, expect, it } from "@jest/globals";
import { loggedPath } from "../../../src/ui/server/logged-path.js";

describe("hardening: the id routes the log masks", () => {
  it.each([
    ["/api/signin/code/abc123", "/api/signin/code/:id"],
    ["/api/signin/code/abc123/withdraw", "/api/signin/code/:id/withdraw"],
    ["/api/github/signin/abc123", "/api/github/signin/:id"],
    ["/api/web/owner/link/abc123", "/api/web/owner/link/:id"],
    ["/api/web/logins/abc123", "/api/web/logins/:id"],
  ])("%s is written as %s", (p, want) => {
    expect(loggedPath(p)).toBe(want);
  });

  it("other routes are written as they came", () => {
    expect(loggedPath("/api/approvals/a1")).toBe("/api/approvals/a1");
    expect(loggedPath("/api/web/logins")).toBe("/api/web/logins");
    expect(loggedPath("/agents")).toBe("/agents");
  });
});
