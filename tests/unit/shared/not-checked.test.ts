/**
 * MCP-2.4: a service with no health verdict says why, in one rule for the
 * web health row and the MCP `status` tool.
 */
import { describe, expect, it } from "@jest/globals";
import { notCheckedReason } from "../../../src/shared/health/not-checked.js";

describe("notCheckedReason", () => {
  it("not deployed in this env: no commands and no check there", () => {
    expect(notCheckedReason({ env: "beta", runs: "none" })).toBe(
      "not checked: not deployed in beta (the manifest has no commands and no health check for beta)",
    );
  });

  it("remote: names where it runs", () => {
    expect(
      notCheckedReason({
        env: "local",
        runs: "remote",
        target: { env: "dev" },
      }),
    ).toBe(
      "not checked: remote (runs in dev), and the manifest declares no health check or target.url for dev",
    );
  });

  it("local with no check; the conventional probe tried", () => {
    expect(notCheckedReason({ env: "local", runs: "local" })).toBe(
      "not checked: no health check in the manifest for local",
    );
    expect(
      notCheckedReason({
        env: "local",
        runs: "local",
        conventional: "http://jobs/healthz",
      }),
    ).toBe(
      "not checked: no health check in the manifest for local, and http://jobs/healthz did not answer 2xx",
    );
  });

  it("no manifest at all", () => {
    expect(
      notCheckedReason({ env: "local", runs: "none", manifest: false }),
    ).toMatch(/^not checked: the repo has no \.\S+\.yml$/);
  });
});
