/**
 * Tests for opctl helpers — the pure parts (dev-op container-name parsing and
 * spawn-diff). The execSync-backed helpers (ls/availability) are exercised via
 * live integration, not unit tests.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  devOpContainerNames,
  diffSpawnedContainers,
  isOpctlContainerFor,
} from "../../../src/shared/environment-manager/opctl.js";

let tmp: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-opctl-"));

  // Standard repo: .opspec/dev/op.yml with a main + sidecar container.
  write(
    path.join(tmp, "svc", ".opspec", "dev", "op.yml"),
    [
      "name: dev",
      "run:",
      "  parallel:",
      "    - container:",
      "        name: my-service",
      "        image: { ref: x }",
      "    - container:",
      "        name: my-sidecar",
      "",
    ].join("\n"),
  );

  // Monorepo: only apps/backend/.opspec/up/op.yml exists.
  write(
    path.join(tmp, "mono", "apps", "backend", ".opspec", "up", "op.yml"),
    ["name: up", "run:", "  container:", "    name: mono-api", ""].join("\n"),
  );

  // Repo with no opspec op at all.
  write(path.join(tmp, "bare", "Makefile"), "up:\n");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("devOpContainerNames", () => {
  it("collects every container.name from the dev op (main + sidecars)", () => {
    const names = devOpContainerNames(path.join(tmp, "svc"));
    expect(new Set(names)).toEqual(new Set(["my-service", "my-sidecar"]));
  });

  it("falls back to the monorepo apps/backend/.opspec/up op", () => {
    expect(devOpContainerNames(path.join(tmp, "mono"))).toEqual(["mono-api"]);
  });

  it("returns [] when there is no dev/up op", () => {
    expect(devOpContainerNames(path.join(tmp, "bare"))).toEqual([]);
  });

  it("returns [] for a path that doesn't exist", () => {
    expect(devOpContainerNames(path.join(tmp, "nope"))).toEqual([]);
  });
});

describe("isOpctlContainerFor", () => {
  it("matches opctl's own name for the base", () => {
    expect(isOpctlContainerFor("opctl_files-api_753930b8", "files-api")).toBe(
      true,
    );
  });

  it("does not match a base that is only a PREFIX of the container's base", () => {
    // These names feed `docker rm -f`, so a prefix match would tear down a
    // different service's container.
    expect(isOpctlContainerFor("opctl_api_v2_22222222", "api")).toBe(false);
    expect(isOpctlContainerFor("opctl_api_v2_22222222", "api_v2")).toBe(true);
  });

  it("ignores containers that aren't opctl's", () => {
    expect(isOpctlContainerFor("my-postgres", "my-postgres")).toBe(false);
    expect(isOpctlContainerFor("opctl_api_", "api")).toBe(false);
  });
});

describe("diffSpawnedContainers", () => {
  it("returns the base names that newly appeared", () => {
    const before = [{ base: "stack-local-postgres" }];
    const after = [
      { base: "stack-local-postgres" },
      { base: "links-api" },
      { base: "billing-api" },
    ];
    expect(new Set(diffSpawnedContainers(before, after))).toEqual(
      new Set(["links-api", "billing-api"]),
    );
  });

  it("returns [] when nothing new appeared", () => {
    const snap = [{ base: "a" }, { base: "b" }];
    expect(diffSpawnedContainers(snap, snap)).toEqual([]);
  });
});
