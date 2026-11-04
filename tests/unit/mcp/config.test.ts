/**
 * `mcp:` in the org config: actions are opt-in, run_tests envs default to
 * [local], remote logs default off. fs is mocked; no real config is read.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("fs");

import * as fs from "fs";
import { readMcpConfig } from "../../../src/shared/den-config.js";

const mockReadFileSync = fs.readFileSync as jest.MockedFunction<
  typeof fs.readFileSync
>;

function mockOrgConfig(contents: string | null) {
  mockReadFileSync.mockImplementation((filePath: unknown): unknown => {
    const p = String(filePath);
    if (contents !== null && p.endsWith("config/den.yml")) return contents;
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
}

afterEach(() => {
  jest.resetAllMocks();
});

describe("readMcpConfig", () => {
  it("with no mcp: block: no actions, run_tests on local only, local logs only", () => {
    mockOrgConfig("environments: [local, dev]\n");
    expect(readMcpConfig()).toEqual({
      actions: [],
      runTestsEnvs: ["local"],
      logsRemote: false,
    });
  });

  it("reads the named actions, run_tests envs and logs.remote", () => {
    mockOrgConfig(
      [
        "environments: [local, dev]",
        "mcp:",
        "  actions: [service_up, run_tests]",
        "  run_tests:",
        "    envs: [local, dev]",
        "  logs:",
        "    remote: true",
      ].join("\n"),
    );
    expect(readMcpConfig()).toEqual({
      actions: ["service_up", "run_tests"],
      runTestsEnvs: ["local", "dev"],
      logsRemote: true,
    });
  });

  it("refuses an unknown action name loudly", () => {
    mockOrgConfig("mcp:\n  actions: [service_up, deploy]\n");
    expect(() => readMcpConfig()).toThrow(/unknown action "deploy"/);
  });

  it("refuses an unknown run_tests env", () => {
    mockOrgConfig("mcp:\n  run_tests:\n    envs: [local, moon]\n");
    expect(() => readMcpConfig()).toThrow(/unknown environment "moon"/);
  });

  it("only an explicit true turns remote logs on", () => {
    mockOrgConfig("mcp:\n  logs:\n    remote: 'yes'\n");
    expect(readMcpConfig().logsRemote).toBe(false);
  });
});
