/**
 * "Register a managed repo" lists the repos of one GitHub org. It comes from
 * the org config's github_org, else the distribution's OWN checkout's
 * remote, and never from the engine's checkout: with a linked or installed
 * engine, the engine's remote names the engine's owner, not this project's
 * (0.3.0-dev.23).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  distributionGitHubOwner,
  managedReposOrg,
} from "../../../src/shared/smoke/git-remote.js";

let tmp: string;
let engine: string;
let nestedDist: string;
let ownDist: string;

function gitRepo(dir: string, owner?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  if (owner)
    execFileSync("git", [
      "-C",
      dir,
      "remote",
      "add",
      "origin",
      `git@github.com:${owner}/repo.git`,
    ]);
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-org-")));
  // An engine checkout whose remote names its own owner...
  engine = path.join(tmp, "engine");
  gitRepo(engine, "engine-owner");
  // ...a distribution inside it with no repo of its own...
  nestedDist = path.join(engine, "examples", "dist");
  fs.mkdirSync(nestedDist, { recursive: true });
  // ...and a distribution with its own remote.
  ownDist = path.join(tmp, "dist");
  gitRepo(ownDist, "dist-owner");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the org whose repos Den lists", () => {
  it("is github_org when the config sets it", () => {
    expect(managedReposOrg("config-org", nestedDist)).toBe("config-org");
    expect(managedReposOrg("config-org", ownDist)).toBe("config-org");
  });

  it("else the distribution's own remote", () => {
    expect(managedReposOrg(undefined, ownDist)).toBe("dist-owner");
  });

  it("never the remote of a checkout the distribution sits in (the engine's)", () => {
    expect(distributionGitHubOwner(nestedDist)).toBeNull();
    expect(managedReposOrg(undefined, nestedDist)).toBeNull();
    expect(managedReposOrg("", nestedDist)).toBeNull();
  });

  it("the CLI no longer derives a root from its own file to find the org", () => {
    const src = fs.readFileSync(path.resolve("src/ui/cli/index.ts"), "utf-8");
    const body = src.slice(
      src.indexOf("private async registerManaged("),
      src.indexOf("gh repo list"),
    );
    expect(body).toContain("managedReposOrg(");
    expect(body).not.toContain("import.meta.url");
  });
});
