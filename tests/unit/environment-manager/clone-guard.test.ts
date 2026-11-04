/**
 * assertSafeCloneDestination: the defense-in-depth preflight behind every
 * den clone (Jun 29 incident: cwd-derived destinations bulk-cloned 13
 * repos into an unrelated checkout).
 *
 * Uses REAL fs + git against a temp tree:
 *
 *   tmp/                     ← repos root (parent of the den root)
 *     den/                ← DEN_ROOT (git repo, like a real checkout)
 *     infra-stack/         ← a foreign git working tree
 */
import { describe, expect, it, beforeAll, afterAll } from "@jest/globals";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmp: string;
let distRoot: string;
let foreignRepo: string;
let savedDistRoot: string | undefined;
let assertSafe: (dest: string, repoName: string) => void;
let GuardError: new (msg: string) => Error;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gx-guard-"));
  distRoot = path.join(tmp, "den");
  foreignRepo = path.join(tmp, "infra-stack");

  fs.mkdirSync(distRoot);
  fs.writeFileSync(path.join(distRoot, "den.yml"), "product:\n  name: den\n");
  execSync("git init -q", { cwd: distRoot });

  fs.mkdirSync(foreignRepo);
  execSync("git init -q", { cwd: foreignRepo });

  // Anchor BEFORE importing: workspaces.ts / den-config.ts freeze their
  // roots at module load.
  savedDistRoot = process.env.DEN_ROOT;
  process.env.DEN_ROOT = distRoot;
  const mod =
    await import("../../../src/shared/environment-manager/clone-guard.js");
  assertSafe = mod.assertSafeCloneDestination;
  GuardError = mod.CloneDestinationError;
});

afterAll(() => {
  if (savedDistRoot === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = savedDistRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("assertSafeCloneDestination — allowed destinations", () => {
  it("allows a fresh clone directly under the repos root", () => {
    expect(() =>
      assertSafe(path.join(tmp, "notes-api"), "notes-api"),
    ).not.toThrow();
  });

  it("allows .den-services/<repo>/<branch> inside the den checkout", () => {
    expect(() =>
      assertSafe(
        path.join(distRoot, ".den-services", "notes-api", "main"),
        "notes-api",
      ),
    ).not.toThrow();
  });

  it("allows .smoke-clones/<repo>/<env> inside the den checkout", () => {
    expect(() =>
      assertSafe(
        path.join(distRoot, ".smoke-clones", "shop", "staging"),
        "shop",
      ),
    ).not.toThrow();
  });

  it("allows den-workspaces destinations whose parents don't exist yet", () => {
    expect(() =>
      assertSafe(
        path.join(tmp, "den-workspaces", "feat-x", "notes-api"),
        "notes-api",
      ),
    ).not.toThrow();
  });
});

describe("assertSafeCloneDestination — refusals", () => {
  it("refuses to clone into a foreign git working tree (the Jun 29 shape)", () => {
    const dest = path.join(foreignRepo, "notes-api");
    expect(() => assertSafe(dest, "notes-api")).toThrow(GuardError);
    expect(() => assertSafe(dest, "notes-api")).toThrow(
      /git working tree den does not own/,
    );
  });

  it("refuses to nest a repo inside a checkout of itself", () => {
    const dest = path.join(foreignRepo, "infra-stack");
    expect(() => assertSafe(dest, "infra-stack")).toThrow(
      /nest infra-stack inside a checkout of itself/,
    );
  });

  it("refuses destinations outside every den-owned location", () => {
    const elsewhere = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "gx-elsewhere-"),
    );
    try {
      expect(() =>
        assertSafe(path.join(elsewhere, "notes-api"), "notes-api"),
      ).toThrow(/outside every den-owned location/);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("names the destination, cwd, and den root in the refusal", () => {
    const dest = path.join(foreignRepo, "notes-api");
    let message = "";
    try {
      assertSafe(dest, "notes-api");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(dest);
    expect(message).toContain(process.cwd());
    expect(message).toContain(distRoot);
  });

  it("refuses even when the destination is nested deep inside the foreign tree", () => {
    expect(() =>
      assertSafe(
        path.join(foreignRepo, "vendor", "deep", "notes-api"),
        "notes-api",
      ),
    ).toThrow(GuardError);
  });
});
