/**
 * Issue 476: the reviewer's ties to the rest of Den. The PR's author is an
 * agent on this install when a running agent's folder is on the PR's head
 * branch (the hand-back goes to its session); otherwise it is the person.
 * A watched repo's local clone is the catalog entry whose GitHub slug is
 * that repo.
 */
import { describe, expect, it } from "@jest/globals";
import {
  authorAgentFor,
  catalogRepoFor,
} from "../../../src/shared/review/mesh/wiring.js";

describe("the PR's author agent", () => {
  const agents = [
    { id: "builder-1", cwd: "/w/den-1", running: true },
    { id: "builder-2", cwd: "/w/den-2", running: false },
    { id: "rev-leg-1", cwd: "/w/legs/1", running: true, leg: true },
  ];
  const branch: Record<string, string> = {
    "/w/den-1": "feat/12-thing",
    "/w/den-2": "feat/99-other",
    "/w/legs/1": "feat/12-thing",
  };
  const branchOf = (cwd: string) => branch[cwd] ?? null;

  it("is the running agent whose folder is on the head branch", () => {
    expect(authorAgentFor("feat/12-thing", agents, branchOf)).toBe("builder-1");
  });

  it("a stopped agent, a review leg, or no match is no author agent", () => {
    expect(authorAgentFor("feat/99-other", agents, branchOf)).toBeNull();
    expect(authorAgentFor("feat/none", agents, branchOf)).toBeNull();
    expect(authorAgentFor("", agents, branchOf)).toBeNull();
  });

  it("two agents on one branch: nobody (the person is told instead)", () => {
    const two = [
      ...agents,
      { id: "builder-3", cwd: "/w/den-3", running: true },
    ];
    expect(
      authorAgentFor("feat/12-thing", two, (c) =>
        c === "/w/den-3" ? "feat/12-thing" : branchOf(c),
      ),
    ).toBeNull();
  });
});

describe("a watched repo's local clone", () => {
  const catalog = {
    app: { gh: "octo/app" },
    site: { remote: "git@github.com:octo/site.git" },
    other: {},
  };
  it("is the catalog entry with that slug", () => {
    expect(catalogRepoFor(catalog, "octo/app")).toBe("app");
    expect(catalogRepoFor(catalog, "octo/site")).toBe("site");
    expect(catalogRepoFor(catalog, "octo/none")).toBeNull();
  });
});
