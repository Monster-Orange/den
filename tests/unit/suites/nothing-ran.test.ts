/**
 * 0.4.45: a test run where every suite was skipped ran nothing. That is
 * its own result, never a pass: the suites runner, the CLI, the page's
 * done event and MCP's run_tests all say "nothing ran" and none says passed.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";

const services: unknown[] = [];
jest.mock("../../../src/shared/manifest/workspace-manifests.js", () => ({
  ...jest.requireActual<object>(
    "../../../src/shared/manifest/workspace-manifests.js",
  ),
  listServicesWithManifests: jest.fn(() => services),
}));

import { main } from "../../../src/pillars/suites/run.js";
import { NOTHING_RAN_EXIT } from "../../../src/shared/run-outcome.js";
import { getRunDonePayload } from "../../../src/ui/server/perf-report.js";
import { TestRunner } from "../../../src/ui/cli/test-runner.js";
import { callTool } from "../../../src/ui/mcp/tools.js";

const repo = (name: string, tests: object) => ({
  address: `${name}/web`,
  repo: name,
  service: "web",
  repoPath: `/src/${name}`,
  org: "Acme",
  isEntrypoint: true,
  config: undefined,
  manifest: { name, entrypoint: "web", services: { web: {} }, tests },
});

const quiet = () => {
  const out: string[] = [];
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  });
  return out;
};

afterEach(() => {
  services.length = 0;
  jest.restoreAllMocks();
});

describe("the suites runner", () => {
  it("every suite skipped: nothing ran, a distinct non-zero exit", async () => {
    services.push(repo("shop", { test: { cmd: "make test" } }));
    const out = quiet();
    const code = await main(["--env", "beta"]);
    expect(code).toBe(NOTHING_RAN_EXIT);
    expect(code).not.toBe(0);
    expect(out.join("\n")).toMatch(/Nothing ran/);
  });

  it("no suite declared at all: nothing ran too", async () => {
    quiet();
    expect(await main(["--env", "local"])).toBe(NOTHING_RAN_EXIT);
  });

  it("a --suite that names nothing: nothing ran", async () => {
    services.push(repo("shop", { test: { cmd: "true" } }));
    quiet();
    expect(await main(["--env", "local", "--suite", "blog"])).toBe(
      NOTHING_RAN_EXIT,
    );
  });

  it("a suite that ran and passed is still a pass", async () => {
    services.push({
      ...repo("shop", { test: { cmd: "true" } }),
      repoPath: ".",
    });
    quiet();
    expect(await main(["--env", "local"])).toBe(0);
  });
});

describe("the page's done event", () => {
  it("says nothingRan for the suites pillar's nothing-ran exit", () => {
    const d = getRunDonePayload({
      pillar: "suites",
      exitCode: NOTHING_RAN_EXIT,
      duration: 5,
    });
    expect(d).toMatchObject({ type: "done", nothingRan: true });
    expect(d.exitCode).not.toBe(0);
  });

  it("no other pillar's exit code is read as nothing ran", () => {
    // ZAP exits 3 on its own errors: a security run's 3 is a failure.
    const d = getRunDonePayload({
      pillar: "security",
      exitCode: NOTHING_RAN_EXIT,
      duration: 5,
    });
    expect(d).not.toHaveProperty("nothingRan");
  });
});

describe("the CLI", () => {
  it("prints nothing ran, not success, and the result is not a success", async () => {
    const runner = new TestRunner();
    jest
      .spyOn(
        runner as unknown as { spawnProcess: () => Promise<unknown> },
        "spawnProcess",
      )
      .mockResolvedValue({ success: false, exitCode: NOTHING_RAN_EXIT });
    const out = quiet();
    const r = await runner.runTests({ pillar: "suites", environment: "beta" });
    expect(r).toMatchObject({
      success: false,
      nothingRan: true,
      exitCode: NOTHING_RAN_EXIT,
    });
    const text = out.join("\n");
    expect(text).toMatch(/Nothing ran/);
    expect(text).not.toMatch(/completed successfully|✅/);
  });
});

describe("MCP run_tests", () => {
  it("an all-skipped run is an error that says nothing ran", async () => {
    const api = {
      baseUrl: "http://den.test",
      get: async () => ({}),
      stream: async () => ({
        events: [
          { type: "done", exitCode: NOTHING_RAN_EXIT, nothingRan: true },
        ],
        lines: ["Nothing ran: every suite was skipped"],
        ended: "done" as const,
        exitCode: NOTHING_RAN_EXIT,
      }),
    };
    const r = await callTool("run_tests", { pillar: "suites", env: "local" }, {
      api,
      cfg: {
        actions: ["run_tests"],
        runTestsEnvs: ["local"],
        logsRemote: false,
        approvals: false,
      },
      cli: "acme",
    } as never);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"nothingRan": true/);
    expect(r.text).toMatch(/"outcome": "nothing ran"/);
  });
});
