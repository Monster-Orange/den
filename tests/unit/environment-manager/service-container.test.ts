/**
 * findServiceContainer: a compose-stack service's container comes from the
 * stacks naming helpers (`<stack>-<workspace>-<service>-1`); everything else
 * falls through to opctl's convention. Also checks `<cli> logs` (resolveTailSources)
 * streams that container.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";

jest.mock("../../../src/shared/environment-manager/opctl.js", () => ({
  findConventionalContainer: jest.fn(),
  runningDockerNames: jest.fn(),
}));
jest.mock("../../../src/shared/manifest/read-manifest.js", () => ({
  readManifest: jest.fn(),
}));
jest.mock("../../../src/shared/environment-manager/workspaces.js", () => ({
  getFocusedWorkspaceName: jest.fn(() => null),
  getWorkspaceByName: jest.fn(),
  getActiveWorkspace: jest.fn(),
  listWorkspaceServices: jest.fn(() => []),
  readManifestAnyBranch: jest.fn(),
}));

import {
  findConventionalContainer,
  runningDockerNames,
} from "../../../src/shared/environment-manager/opctl.js";
import { readManifest } from "../../../src/shared/manifest/read-manifest.js";
import { getFocusedWorkspaceName } from "../../../src/shared/environment-manager/workspaces.js";
import { findServiceContainer } from "../../../src/shared/environment-manager/service-container.js";
import { resolveTailSources } from "../../../src/shared/environment-manager/log-tail.js";

const mockFind = findConventionalContainer as jest.MockedFunction<
  typeof findConventionalContainer
>;
const mockNames = runningDockerNames as jest.MockedFunction<
  typeof runningDockerNames
>;
const mockManifest = readManifest as jest.MockedFunction<typeof readManifest>;
const mockFocused = getFocusedWorkspaceName as jest.MockedFunction<
  typeof getFocusedWorkspaceName
>;

const stackManifest = {
  name: "shop",
  entrypoint: "shop",
  services: { shop: {}, backend: {} },
  compose: { routes: { app: "frontend:80" } },
};

beforeEach(() => {
  jest.resetAllMocks();
  mockFind.mockReturnValue(null);
  mockFocused.mockReturnValue(null);
  mockNames.mockReturnValue([
    "shop-main-frontend-1",
    "shop-main-backend-1",
    "shop-dev-backend-1",
  ]);
});

describe("findServiceContainer", () => {
  it("names a stack service's container by its stack and workspace", () => {
    mockManifest.mockReturnValue(stackManifest as never);
    expect(findServiceContainer("shop", "/repos/shop", "backend")).toBe(
      "shop-main-backend-1",
    );
    mockFocused.mockReturnValue("dev");
    expect(findServiceContainer("shop", "/repos/shop", "backend")).toBe(
      "shop-dev-backend-1",
    );
  });

  it("uses compose.name for the stack name", () => {
    mockManifest.mockReturnValue({
      ...stackManifest,
      name: "shop-repo",
      compose: { name: "shop", routes: {} },
    } as never);
    expect(findServiceContainer("shop-repo", "/repos/shop", "backend")).toBe(
      "shop-main-backend-1",
    );
  });

  it("maps the primary service to its routes' target service", () => {
    mockManifest.mockReturnValue(stackManifest as never);
    expect(findServiceContainer("shop", "/repos/shop", "shop")).toBe(
      "shop-main-frontend-1",
    );
  });

  it("falls back to opctl's convention when the stack container is not running", () => {
    mockManifest.mockReturnValue(stackManifest as never);
    mockNames.mockReturnValue([]);
    mockFind.mockReturnValue("opctl_shop_abc");
    expect(findServiceContainer("shop", "/repos/shop", "backend")).toBe(
      "opctl_shop_abc",
    );
  });

  it("is opctl's convention for a repo with no compose section", () => {
    mockManifest.mockReturnValue({ name: "shop", services: {} } as never);
    mockFind.mockReturnValue("opctl_shop_abc");
    expect(findServiceContainer("shop", "/repos/shop", "api")).toBe(
      "opctl_shop_abc",
    );
    expect(mockNames).not.toHaveBeenCalled();
  });

  it("returns null when docker is unavailable", () => {
    mockManifest.mockReturnValue(stackManifest as never);
    mockNames.mockImplementation(() => {
      throw new Error("docker: not found");
    });
    expect(findServiceContainer("shop", "/repos/shop", "backend")).toBeNull();
  });
});

describe("resolveTailSources for a stack service", () => {
  it("streams the stack's container", () => {
    mockManifest.mockReturnValue(stackManifest as never);
    const sources = resolveTailSources({
      repoName: "shop",
      subsystem: "backend",
      repoPath: "/repos/shop",
    } as never);
    expect(sources.find((s) => s.kind === "docker")?.args).toContain(
      "shop-main-backend-1",
    );
  });
});
