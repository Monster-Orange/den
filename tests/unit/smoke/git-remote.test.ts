import { execSync } from "child_process";
import {
  getGitHubCoords,
  getGitRemoteOrigin,
  parseGitHubOwnerRepo,
} from "../../../src/shared/smoke/git-remote.js";

jest.mock("child_process");
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

// ── parseGitHubOwnerRepo (pure — no mocking needed) ───────────────────────────

describe("parseGitHubOwnerRepo", () => {
  it.each([
    [
      "HTTPS with .git",
      "https://github.com/acme/app.git",
      { owner: "acme", repo: "app" },
    ],
    [
      "HTTPS without .git",
      "https://github.com/acme/app",
      { owner: "acme", repo: "app" },
    ],
    [
      "SSH with .git",
      "git@github.com:acme/app.git",
      { owner: "acme", repo: "app" },
    ],
    [
      "SSH without .git",
      "git@github.com:acme/app",
      { owner: "acme", repo: "app" },
    ],
  ])("parses %s", (_label, url, expected) => {
    expect(parseGitHubOwnerRepo(url)).toEqual(expected);
  });

  it.each([
    ["GitLab HTTPS", "https://gitlab.com/org/repo.git"],
    ["GitLab SSH", "git@gitlab.com:org/repo.git"],
    ["bare string", "not-a-url"],
    ["empty string", ""],
  ])("returns null for %s", (_label, url) => {
    expect(parseGitHubOwnerRepo(url)).toBeNull();
  });
});

// ── getGitRemoteOrigin ────────────────────────────────────────────────────────

describe("getGitRemoteOrigin", () => {
  beforeEach(() => jest.resetAllMocks());

  it("returns trimmed output when execSync succeeds", () => {
    mockExecSync.mockReturnValue(
      "https://github.com/acme/app.git\n" as unknown as Buffer,
    );
    expect(getGitRemoteOrigin("/some/path")).toBe(
      "https://github.com/acme/app.git",
    );
  });

  it("returns null when execSync throws (not a git repo)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(getGitRemoteOrigin("/not/a/repo")).toBeNull();
  });
});

// ── getGitHubCoords ───────────────────────────────────────────────────────────

describe("getGitHubCoords", () => {
  beforeEach(() => jest.resetAllMocks());

  it("returns coords for a valid GitHub SSH remote", () => {
    mockExecSync.mockReturnValue(
      "git@github.com:acme/app.git\n" as unknown as Buffer,
    );
    expect(getGitHubCoords("/some/path")).toEqual({
      owner: "acme",
      repo: "app",
    });
  });

  it("returns null when there is no remote", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("no remote");
    });
    expect(getGitHubCoords("/some/path")).toBeNull();
  });

  it("returns null for a non-GitHub remote", () => {
    mockExecSync.mockReturnValue(
      "https://gitlab.com/org/repo.git\n" as unknown as Buffer,
    );
    expect(getGitHubCoords("/some/path")).toBeNull();
  });
});
