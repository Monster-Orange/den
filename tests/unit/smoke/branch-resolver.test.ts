import { execSync } from "child_process";
import { resolveDeployedRef } from "../../../src/shared/smoke/branch-resolver.js";

jest.mock("child_process");
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

const DEPLOYMENT = {
  id: 123,
  sha: "abc123def456abc123def456abc123def456abc1",
  ref: "main",
  environment: "staging",
  created_at: "2024-01-15T10:00:00Z",
  statuses_url:
    "https://api.github.com/repos/acme/app/deployments/123/statuses",
};

/** Wire up execSync to return specific JSON for known gh sub-commands. */
function mockGh(responses: Array<[pattern: string, json: string]>) {
  mockExecSync.mockImplementation((cmd: string) => {
    const s = String(cmd);
    for (const [pattern, json] of responses) {
      if (s.includes(pattern)) return json as unknown as Buffer;
    }
    throw new Error(`Unexpected gh call: ${s}`);
  });
}

describe("resolveDeployedRef", () => {
  beforeEach(() => jest.resetAllMocks());

  it("returns the first successful deployment", async () => {
    mockGh([
      ["auth status", ""],
      ["deployments?environment=staging", JSON.stringify([DEPLOYMENT])],
      ["deployments/123/statuses", JSON.stringify([{ state: "success" }])],
    ]);

    const result = await resolveDeployedRef("acme", "app", "staging");
    expect(result).toEqual({
      sha: DEPLOYMENT.sha,
      ref: "main",
      environment: "staging",
      deployedAt: DEPLOYMENT.created_at,
      deploymentId: 123,
    });
  });

  it("skips non-successful deployments and returns the next successful one", async () => {
    const failed = { ...DEPLOYMENT, id: 200, sha: "fail000" };
    mockGh([
      ["auth status", ""],
      ["deployments?environment=staging", JSON.stringify([failed, DEPLOYMENT])],
      ["deployments/200/statuses", JSON.stringify([{ state: "failure" }])],
      ["deployments/123/statuses", JSON.stringify([{ state: "success" }])],
    ]);

    const result = await resolveDeployedRef("acme", "app", "staging");
    expect(result.sha).toBe(DEPLOYMENT.sha);
    expect(result.deploymentId).toBe(123);
  });

  it("falls back to the most recent deployment when none are successful", async () => {
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mockGh([
      ["auth status", ""],
      ["deployments?environment=staging", JSON.stringify([DEPLOYMENT])],
      ["deployments/123/statuses", JSON.stringify([{ state: "failure" }])],
    ]);

    const result = await resolveDeployedRef("acme", "app", "staging");
    expect(result.sha).toBe(DEPLOYMENT.sha);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No successful deployment found"),
    );
    warnSpy.mockRestore();
  });

  it("treats a deployment with no statuses as non-successful and falls back", async () => {
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    mockGh([
      ["auth status", ""],
      ["deployments?environment=staging", JSON.stringify([DEPLOYMENT])],
      // empty statuses array → getLatestDeploymentState returns null
      ["deployments/123/statuses", JSON.stringify([])],
    ]);

    const result = await resolveDeployedRef("acme", "app", "staging");
    expect(result.sha).toBe(DEPLOYMENT.sha);
    warnSpy.mockRestore();
  });

  it("throws when no deployments exist for the environment", async () => {
    mockGh([
      ["auth status", ""],
      ["deployments?environment=staging", JSON.stringify([])],
    ]);

    await expect(resolveDeployedRef("acme", "app", "staging")).rejects.toThrow(
      "No deployments found",
    );
  });

  it("throws when gh is not authenticated", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("You are not logged into any GitHub hosts");
    });

    await expect(resolveDeployedRef("acme", "app", "staging")).rejects.toThrow(
      "GitHub CLI is not authenticated",
    );
  });

  it("respects the limit parameter", async () => {
    const deploys = Array.from({ length: 5 }, (_, i) => ({
      ...DEPLOYMENT,
      id: i + 1,
      sha: `sha${i}`,
    }));
    mockGh([
      ["auth status", ""],
      // limit=3 should be in the URL
      ["deployments?environment=staging&per_page=3", JSON.stringify(deploys)],
      // all fail → falls back
      ...deploys.map(
        (d) =>
          [
            `deployments/${d.id}/statuses`,
            JSON.stringify([{ state: "failure" }]),
          ] as [string, string],
      ),
    ]);
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    await resolveDeployedRef("acme", "app", "staging", 3);

    const calls = mockExecSync.mock.calls.map(([c]) => String(c));
    expect(calls.some((c) => c.includes("per_page=3"))).toBe(true);
    warnSpy.mockRestore();
  });
});
