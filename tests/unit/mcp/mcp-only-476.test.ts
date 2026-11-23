/**
 * Issue 476: `mcp --only <tool,…>` limits a scoped server to those tools.
 * A review leg's server has review_submit and nothing else, so text it
 * read in a PR can't reach issue_write, hub_put or a held-write ask.
 */
import { describe, expect, it } from "@jest/globals";
import { parseScopeFlags, ScopeUsageError } from "../../../src/ui/mcp/scope.js";
import { toolsFor } from "../../../src/ui/mcp/tools.js";

const cfg = {
  actions: [],
  runTestsEnvs: ["local" as const],
  logsRemote: false,
  approvals: true,
} as unknown as Parameters<typeof toolsFor>[0];

const base = ["--workspace", "north", "--actor", "agent:rev-leg-1"];

describe("mcp --only", () => {
  it("is part of the scope, and the server lists only those tools", () => {
    const { scope, rest } = parseScopeFlags([
      ...base,
      "--only",
      "review_submit",
    ]);
    expect(rest).toEqual([]);
    expect(scope?.only).toEqual(["review_submit"]);
    expect(toolsFor(cfg, scope!).map((t) => t.name)).toEqual(["review_submit"]);
  });

  it("without --only, a scoped server keeps every tool", () => {
    const { scope } = parseScopeFlags(base);
    expect(scope?.only).toBeUndefined();
    const names = toolsFor(cfg, scope!).map((t) => t.name);
    expect(names).toContain("issue_write");
    expect(names).toContain("review_submit");
  });

  it("refuses a name that isn't a tool's shape, and --only on an unscoped server", () => {
    expect(() =>
      parseScopeFlags([...base, "--only", "review_submit;rm"]),
    ).toThrow(ScopeUsageError);
    expect(() => parseScopeFlags(["--only", "review_submit"])).toThrow(
      ScopeUsageError,
    );
  });
});
