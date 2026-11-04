import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  resolveInvocationTarget,
  resolveCwdRepo,
} from "../../../src/ui/cli/invocation-target.js";
import type {
  ServiceCatalog,
  WorkspaceConfig,
} from "../../../src/shared/types/index.js";
import type { AliasResolver } from "../../../src/shared/environment-manager/derivation/alias.js";

const tmpRoots: string[] = [];

function makeRepo(manifest: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-invoke-"));
  tmpRoots.push(dir);
  fs.writeFileSync(path.join(dir, ".den.yml"), manifest, "utf-8");
  return dir;
}

function catalogFor(repoName: string): ServiceCatalog {
  return { [repoName]: { gh: `Globex-Corp/${repoName}` } };
}

function workspaceFor(repoName: string, repoPath: string): WorkspaceConfig {
  return {
    services: {
      [repoName]: { mode: "dev-managed", path: repoPath },
    },
  };
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveInvocationTarget", () => {
  it("uses the bare repo address for a single-service repo", () => {
    const repoPath = makeRepo("name: api-repo\nservices:\n  api:\n    {}\n");

    const result = resolveInvocationTarget(
      "default",
      workspaceFor("api-repo", repoPath),
      catalogFor("api-repo"),
      repoPath,
    );

    expect(result?.addresses).toEqual(["api-repo"]);
  });

  it("uses the declared entrypoint for a multi-service repo", () => {
    const repoPath = makeRepo(
      "name: multi\nentrypoint: api\nservices:\n  api:\n    {}\n  worker:\n    {}\n",
    );

    const result = resolveInvocationTarget(
      "default",
      workspaceFor("multi", repoPath),
      catalogFor("multi"),
      repoPath,
    );

    expect(result?.addresses).toEqual(["multi/api"]);
  });

  it("returns all workspace services for a multi-service repo without entrypoint", () => {
    const repoPath = makeRepo(
      "name: multi\nservices:\n  api:\n    {}\n  worker:\n    {}\n",
    );

    const result = resolveInvocationTarget(
      "default",
      workspaceFor("multi", repoPath),
      catalogFor("multi"),
      path.join(repoPath, "nested"),
    );

    expect(result?.addresses).toEqual(["multi/api", "multi/worker"]);
  });

  it("returns null when the invocation repo is not in the workspace", () => {
    const repoPath = makeRepo("name: other\nservices:\n  api:\n    {}\n");
    const workspace = workspaceFor("known", makeRepo("name: known\n"));

    const result = resolveInvocationTarget(
      "default",
      workspace,
      catalogFor("known"),
      repoPath,
    );

    expect(result).toBeNull();
  });
});

describe("resolveCwdRepo", () => {
  const orig = process.env.DEN_INVOKE_CWD;
  afterEach(() => {
    if (orig === undefined) delete process.env.DEN_INVOKE_CWD;
    else process.env.DEN_INVOKE_CWD = orig;
  });

  const alias = (
    known: string[],
    map: Record<string, string> = {},
  ): AliasResolver => ({
    knownRepos: new Set(known),
    resolve: (t: string) => map[t] ?? (known.includes(t) ? t : null),
    eventSinks: new Set(),
  });

  it("resolves the repo from its .den.yml name (alias token)", () => {
    const repo = makeRepo("name: links-api\nservices:\n  api:\n    {}\n");
    process.env.DEN_INVOKE_CWD = repo;
    const r = resolveCwdRepo(
      alias(["links-api"], { connections: "links-api" }),
    );
    expect(r?.repo).toBe("links-api");
    expect(r?.root).toBe(path.resolve(repo));
  });

  it("falls back to the folder name when there's no manifest name", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "den-cwd-"));
    tmpRoots.push(base);
    const repo = path.join(base, "tokens");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, ".git"), ""); // repo marker, no .den.yml
    process.env.DEN_INVOKE_CWD = repo;
    expect(resolveCwdRepo(alias(["tokens"]))?.repo).toBe("tokens");
  });

  it("returns null when the cwd isn't a known repo", () => {
    const repo = makeRepo("name: mystery\n");
    process.env.DEN_INVOKE_CWD = repo;
    expect(resolveCwdRepo(alias(["links-api"]))).toBeNull();
  });
});
