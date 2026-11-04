/**
 * Coverage for forceStopOpctlContainers — the docker fallback when
 * `opctl container down` can't elevate (sudo -E / missing SETENV).
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";

jest.mock("child_process");

import { execFileSync, execSync } from "child_process";
import { forceStopOpctlContainers } from "../../../src/shared/environment-manager/opctl.js";

const mockExec = execSync as jest.MockedFunction<typeof execSync>;
const mockExecFile = execFileSync as jest.MockedFunction<typeof execFileSync>;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("forceStopOpctlContainers", () => {
  it("returns empty when given no bases", () => {
    expect(forceStopOpctlContainers([])).toEqual({ stopped: [], failed: [] });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("marks bases failed when docker ps is unavailable", () => {
    mockExec.mockImplementation(() => {
      throw new Error("docker: not found");
    });
    expect(forceStopOpctlContainers(["files-api"])).toEqual({
      stopped: [],
      failed: ["files-api"],
    });
  });

  it("rm -f only matching opctl_<base>_<hash> containers", () => {
    mockExec.mockReturnValue(
      [
        "opctl_files-api_753930b8",
        "opctl_links-api_a7a8fbbb",
        "unrelated",
      ].join("\n") + "\n",
    );
    mockExecFile.mockReturnValue("" as never);

    expect(forceStopOpctlContainers(["files-api"])).toEqual({
      stopped: ["opctl_files-api_753930b8"],
      failed: [],
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["rm", "-f", "opctl_files-api_753930b8"],
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("never claims a container whose base merely STARTS WITH the requested one", () => {
    // `docker rm -f` on the wrong container is an unrecoverable failure mode:
    // base "api" must not sweep away "api_v2"'s container.
    mockExec.mockReturnValue(
      ["opctl_api_11111111", "opctl_api_v2_22222222"].join("\n") + "\n",
    );
    mockExecFile.mockReturnValue("" as never);

    expect(forceStopOpctlContainers(["api"])).toEqual({
      stopped: ["opctl_api_11111111"],
      failed: [],
    });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("records docker rm failures without aborting siblings", () => {
    mockExec.mockReturnValue(
      ["opctl_a_11111111", "opctl_b_22222222"].join("\n") + "\n",
    );
    mockExecFile
      .mockImplementationOnce(() => {
        throw new Error("permission denied");
      })
      .mockReturnValueOnce("" as never);

    expect(forceStopOpctlContainers(["a", "b"])).toEqual({
      stopped: ["opctl_b_22222222"],
      failed: ["opctl_a_11111111"],
    });
  });
});
