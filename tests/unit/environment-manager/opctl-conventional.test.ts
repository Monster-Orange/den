/**
 * Branch coverage for findConventionalContainer — the name-affinity
 * resolution of a service's running opctl container (docker names them
 * `opctl_<base>_<hash>`).
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";

jest.mock("fs");
jest.mock("child_process");

import * as fs from "fs";
import { execSync } from "child_process";
import { findConventionalContainer } from "../../../src/shared/environment-manager/opctl.js";

const mockExec = execSync as jest.MockedFunction<typeof execSync>;
const mockExists = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockRead = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;

function dockerPs(names: string[]) {
  mockExec.mockImplementation(((cmd: string) => {
    if (String(cmd).startsWith("docker ps")) return names.join("\n") + "\n";
    throw new Error(`unexpected exec: ${cmd}`);
  }) as never);
}

/** Declare op-manifest container names for devOpContainerNames. */
function declareOpContainers(names: string[]) {
  mockExists.mockImplementation(((p: unknown) =>
    String(p).includes(".opspec")) as never);
  const doc = ["run:"]
    .concat(names.map((n) => `  - container:\n      name: ${n}`))
    .join("\n");
  mockRead.mockReturnValue(doc);
}

beforeEach(() => {
  jest.resetAllMocks();
  mockExists.mockReturnValue(false); // default: no op manifests declared
});

describe("findConventionalContainer", () => {
  it("returns null when docker is unavailable", () => {
    mockExec.mockImplementation(() => {
      throw new Error("docker: not found");
    });
    expect(findConventionalContainer("shop")).toBeNull();
  });

  it("matches the repo name against opctl_<repo>_<hash>", () => {
    dockerPs(["opctl_control-plane_4712926c", "unrelated"]);
    expect(findConventionalContainer("control-plane")).toBe(
      "opctl_control-plane_4712926c",
    );
  });

  it("prefers a declared container matching the subsystem exactly", () => {
    dockerPs(["opctl_shop-postgres_aa", "opctl_db_bb"]);
    declareOpContainers(["db", "shop-postgres"]);
    expect(findConventionalContainer("shop", "/repos/shop", "db")).toBe(
      "opctl_db_bb",
    );
  });

  it("matches subsystem by suffix affinity (api → shop-api)", () => {
    dockerPs(["opctl_shop-postgres_aa", "opctl_shop-api_cc"]);
    declareOpContainers(["shop-postgres", "pgadmin", "shop-api"]);
    expect(findConventionalContainer("shop", "/repos/shop", "api")).toBe(
      "opctl_shop-api_cc",
    );
  });

  it("does NOT hand a sidecar to a non-matching subsystem when several are declared", () => {
    dockerPs(["opctl_shop-postgres_aa"]);
    declareOpContainers(["shop-postgres", "pgadmin", "shop-api"]);
    // subsystem "api": shop-api not running, repo name no match, and the
    // ambiguous declared list must NOT be scanned blindly.
    expect(findConventionalContainer("shop", "/repos/shop", "api")).toBeNull();
  });

  it("trusts the declared list when it is unambiguous (single entry)", () => {
    dockerPs(["opctl_stack-thing_dd"]);
    declareOpContainers(["stack-thing"]);
    expect(findConventionalContainer("infra", "/repos/infra", "svc")).toBe(
      "opctl_stack-thing_dd",
    );
  });

  it("returns null when nothing is running that matches", () => {
    dockerPs(["opctl_other_ee"]);
    expect(findConventionalContainer("shop", undefined, "api")).toBeNull();
  });
});
