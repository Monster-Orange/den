/**
 * Focused coverage for listRunningOpctlContainers — parsing the NAME column
 * of `opctl container ls` (trailing 8-hex `-<hash>` stripped) and unioning
 * docker `opctl_<base>_<hash>` names when opctl's own list is incomplete.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";

jest.mock("child_process");

import { execSync } from "child_process";
import {
  listRunningDockerOpctlContainers,
  listRunningOpctlContainers,
} from "../../../src/shared/environment-manager/opctl.js";

const mockExec = execSync as jest.MockedFunction<typeof execSync>;

/**
 * Mock `opctl container ls` (+ optional docker ps) output. Always satisfies
 * the `command -v opctl` availability probe (isOpctlAvailable caches per
 * process, so it must never throw here regardless of which test runs first).
 */
function opctlLs(out: string, dockerNames: string[] = []) {
  mockExec.mockImplementation(((cmd: string) => {
    if (String(cmd).startsWith("command -v opctl")) return "";
    if (String(cmd).startsWith("opctl container ls")) return out;
    if (String(cmd).includes("docker ps")) return dockerNames.join("\n") + "\n";
    throw new Error(`unexpected exec: ${cmd}`);
  }) as never);
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("listRunningOpctlContainers", () => {
  it("strips an exactly-8-hex suffix to the base name", () => {
    opctlLs(
      "NAME                       STATUS\n" +
        "control-plane-4712926c     Up 2 hours\n" +
        "jobs-runtime-8f033043   Up 2 hours\n",
    );
    expect(listRunningOpctlContainers()).toEqual([
      { name: "control-plane-4712926c", base: "control-plane" },
      { name: "jobs-runtime-8f033043", base: "jobs-runtime" },
    ]);
  });

  it("does NOT strip a 6-hex suffix (legitimate name kept whole)", () => {
    opctlLs("NAME      STATUS\nservice-abc123   Up\n");
    expect(listRunningOpctlContainers()).toEqual([
      { name: "service-abc123", base: "service-abc123" },
    ]);
  });

  it("does NOT strip a 10-hex suffix (legitimate name kept whole)", () => {
    opctlLs("NAME      STATUS\nservice-abc123abc1   Up\n");
    expect(listRunningOpctlContainers()).toEqual([
      { name: "service-abc123abc1", base: "service-abc123abc1" },
    ]);
  });

  it("parses headerless output without dropping the only row", () => {
    opctlLs("control-plane-4712926c   Up 2 hours\n");
    expect(listRunningOpctlContainers()).toEqual([
      { name: "control-plane-4712926c", base: "control-plane" },
    ]);
  });

  it("skips a NAME header row", () => {
    opctlLs("NAME   STATUS\ncontrol-plane-4712926c   Up\n");
    expect(listRunningOpctlContainers()).toEqual([
      { name: "control-plane-4712926c", base: "control-plane" },
    ]);
  });

  it("skips an ID header row", () => {
    opctlLs("ID   NAME\nabc123   Up\n");
    expect(listRunningOpctlContainers()).toEqual([
      { name: "abc123", base: "abc123" },
    ]);
  });

  it("returns [] on empty output", () => {
    opctlLs("");
    expect(listRunningOpctlContainers()).toEqual([]);
  });

  it("unions docker opctl_<base>_<hash> names when opctl ls is empty", () => {
    opctlLs("NAME  ID  STATUS  STARTED\n", [
      "opctl_links-api_a7a8fbbb",
      "opctl_notes-api_753930b8",
      "unrelated",
    ]);
    expect(listRunningOpctlContainers()).toEqual([
      { name: "opctl_links-api_a7a8fbbb", base: "links-api" },
      { name: "opctl_notes-api_753930b8", base: "notes-api" },
    ]);
  });

  it("does not duplicate a base already reported by opctl ls", () => {
    opctlLs("NAME  STATUS\nlinks-api-a7a8fbbb  Up\n", [
      "opctl_links-api_a7a8fbbb",
    ]);
    expect(listRunningOpctlContainers()).toEqual([
      { name: "links-api-a7a8fbbb", base: "links-api" },
    ]);
  });
});

describe("listRunningDockerOpctlContainers", () => {
  it("parses only opctl_<base>_<8-hex> docker names", () => {
    mockExec.mockReturnValue(
      [
        "opctl_files-api_753930b8",
        "opctl_stack-local-postgres_3f99ad94",
        "shop-local-redis",
      ].join("\n") + "\n",
    );
    expect(listRunningDockerOpctlContainers()).toEqual([
      { name: "opctl_files-api_753930b8", base: "files-api" },
      {
        name: "opctl_stack-local-postgres_3f99ad94",
        base: "stack-local-postgres",
      },
    ]);
  });
});
