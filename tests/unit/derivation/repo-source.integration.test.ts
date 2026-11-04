/**
 * Tests for repo boot-location resolution (repoSource / resolveRepoPath) over a
 * temp workspace + catalog: managed (cloned and not-cloned), dev-managed,
 * and multi-service repos addressed only by "repo/subsystem".
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmp: string;
let repoSource: typeof import("../../../src/shared/environment-manager/derivation/derive-graph.js").repoSource;
let resolveRepoPath: typeof import("../../../src/shared/environment-manager/derivation/derive-graph.js").resolveRepoPath;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-reposrc-"));
  const distRoot = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");

  write(path.join(distRoot, "den.yml"), "product:\n  name: den\n");
  write(path.join(distRoot, "config", "den.yml"), "repos_root: ../repos\n");
  write(
    path.join(distRoot, "config", "local", "service-catalog.yml"),
    "alpha:\n  gh: x/alpha\nbeta:\n  gh: x/beta\nplatform:\n  gh: x/shop\n",
  );
  write(
    path.join(distRoot, "config", "local", "workspaces.yml"),
    [
      "active: default",
      "workspaces:",
      "  default:",
      "    services:",
      "      alpha:", // managed AND cloned
      "        mode: managed",
      "        branch: main",
      "      beta:", // managed but NOT cloned
      "        mode: managed",
      "        branch: main",
      "      shop/api:", // multi-service repo addressed only by subsystem
      "        mode: dev-managed",
      `        path: ${path.join(repos, "shop")}`,
      "",
    ].join("\n"),
  );

  // alpha managed clone present; beta clone absent; sibling repos for beta + shop.
  write(
    path.join(distRoot, ".den-services", "alpha", "main", ".den.yml"),
    "name: alpha\n",
  );
  write(path.join(repos, "beta", "Makefile"), "up:\n");
  write(path.join(repos, "shop", "Makefile"), "up:\n");

  process.env.DEN_ROOT = distRoot;
  delete process.env.DEN_INVOKE_CWD;
  ({ repoSource, resolveRepoPath } =
    await import("../../../src/shared/environment-manager/derivation/derive-graph.js"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.DEN_ROOT;
});

describe("repoSource", () => {
  it("reports a managed clone that exists", () => {
    const s = repoSource("alpha")!;
    expect(s.managed).toBe(true);
    expect(s.exists).toBe(true);
    expect(s.path).toMatch(/\.den-services\/alpha\/main$/);
  });

  it("reports a managed repo that is configured but not cloned", () => {
    const s = repoSource("beta")!;
    expect(s.managed).toBe(true);
    expect(s.exists).toBe(false); // clone dir absent
    // …but reading falls back to the sibling so discovery still works.
    expect(resolveRepoPath("beta")).toMatch(/repos\/beta$/);
  });

  it("resolves a multi-service repo via its 'repo/subsystem' entry", () => {
    const s = repoSource("shop")!;
    expect(s.managed).toBe(false); // dev-managed subsystem entry
    expect(s.exists).toBe(true);
    expect(s.path).toMatch(/repos\/shop$/);
    expect(resolveRepoPath("shop")).toMatch(/repos\/shop$/);
  });
});
