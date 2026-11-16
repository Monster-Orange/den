/**
 * Issue 212 follow-up: "Open an issue with this range". The issue goes to
 * the failing check's own repo (from its origin remote), never Den's, and
 * carries the range: the last pass, the first failure, the commits in
 * between, the failing check, the commit and the environment.
 */
import { describe, expect, it } from "@jest/globals";
import { githubSlug } from "../../../src/shared/verify/changes.js";
import { rangeIssue } from "../../../src/shared/verify/range-issue.js";

const history = {
  module: "shop:api/orders",
  env: "staging",
  runs: [
    {
      runId: "r7",
      endedAt: "2026-11-14T10:00:00Z",
      commit: "c0ffee1",
      state: "passed" as const,
      ms: 1,
    },
    {
      runId: "r8",
      endedAt: "2026-11-14T11:00:00Z",
      commit: "a1b2c3d",
      state: "passed" as const,
      ms: 1,
      flaky: true as const,
    },
    {
      runId: "r9",
      endedAt: "2026-11-15T10:00:00Z",
      commit: "e4f5a6b",
      state: "failed" as const,
      ms: 1,
      message: "POST /orders returned 500\nstack…",
    },
  ],
  flaky: { mark: false, count: 1, window: 10, min: 2 },
  streak: { state: "failed" as const, runs: 1, passedBefore: 2 },
  range: {
    lastPassed: { runId: "r8", commit: "a1b2c3d" },
    firstFailed: { runId: "r9", commit: "e4f5a6b" },
  },
};
const commits = [
  { commit: "b7c8d9e", subject: "orders: add discount codes" },
  { commit: "e4f5a6b", subject: "api: update `database` driver" },
];

describe("the issue's title and body", () => {
  it("names the check, the environment and the first failing commit", () => {
    const i = rangeIssue({
      project: "north",
      module: {
        id: "shop:api/orders",
        name: "api/orders",
        kind: "integration",
      },
      history,
      commits,
    })!;
    expect(i.title).toBe("api/orders fails on staging since e4f5a6b");
    for (const s of [
      "`api/orders` (integration) fails on **staging** in project north.",
      "First failing run: `r9`, at commit `e4f5a6b`",
      "Last passing run: `r8`, at commit `a1b2c3d`",
      "> POST /orders returned 500",
      "### Commits in between",
      "- `b7c8d9e` orders: add discount codes",
      "### Last 3 runs on staging, oldest first",
      "✓ ↻ ✕",
    ])
      expect(i.body).toContain(s);
    // A commit subject's backticks can't break out of the list.
    expect(i.body).toContain("- `e4f5a6b` api: update 'database' driver");
    // Only the first line of the failure: no stack.
    expect(i.body).not.toContain("stack…");
  });

  it("no failing range: no issue", () => {
    expect(
      rangeIssue({
        project: "north",
        module: {
          id: "shop:api/orders",
          name: "api/orders",
          kind: "integration",
        },
        history: { ...history, range: undefined },
      }),
    ).toBeNull();
  });

  it("commits git couldn't list: the body says so instead of a list", () => {
    const i = rangeIssue({
      project: "north",
      module: {
        id: "shop:api/orders",
        name: "api/orders",
        kind: "integration",
      },
      history,
    })!;
    expect(i.body).not.toContain("### Commits in between");
    expect(i.body).toContain("Commits from `a1b2c3d` to `e4f5a6b`");
  });
});

describe("the target repo: the check's own, from its origin remote", () => {
  it("reads GitHub's SSH and HTTPS remotes", () => {
    expect(githubSlug("git@github.com:acme/shop.git")).toBe("acme/shop");
    expect(githubSlug("https://github.com/acme/shop")).toBe("acme/shop");
    expect(githubSlug("https://github.com/acme/shop.git\n")).toBe("acme/shop");
    expect(githubSlug("https://gitlab.com/acme/shop.git")).toBeNull();
    expect(githubSlug("git@github.com:acme/shop;rm -rf.git")).toBeNull();
  });
});
