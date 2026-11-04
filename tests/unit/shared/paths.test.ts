/**
 * getDistRoot: the filesystem anchor every write path (clones, config)
 * derives from. A distribution root is a directory holding den.yml.
 *
 * Incident-driven invariant (Jun 29): when the walk fails, the root must
 * NEVER silently degrade to process.cwd() — that once bulk-cloned 13 repos
 * into an unrelated checkout. Failure must be loud and name the escape hatch.
 *
 * The suite runs as Den (tests/setup.ts), so DEN_ROOT is the
 * product root variable here.
 */
import { describe, expect, it, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getDistRoot,
  getEngineRoot,
  getStateDir,
  getDistRoot,
  getInvokeCwd,
} from "../../../src/shared/paths.js";
import { resetProfileCache } from "../../../src/shared/profile.js";

const SAVED = ["DEN_ROOT", "DEN_ROOT", "DEN_HOME", "DEN_PROFILE"];
let saved: Record<string, string | undefined>;
let savedArgv1: string | undefined;
let tmpDir: string;
const profile = (dir: string, name = "den"): void =>
  fs.writeFileSync(path.join(dir, "den.yml"), `product:\n  name: ${name}\n`);

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  savedArgv1 = process.argv[1];
  delete process.env.DEN_ROOT;
  delete process.env.DEN_ROOT;
  delete process.env.DEN_HOME;
  resetProfileCache();
  tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gx-paths-"));
});

afterEach(() => {
  for (const k of SAVED)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  process.argv[1] = savedArgv1 as string;
  resetProfileCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getDistRoot", () => {
  it("is still exported as getDistRoot", () => {
    expect(getDistRoot).toBe(getDistRoot);
  });

  it("honors the product's <PREFIX>_ROOT when it holds den.yml", () => {
    profile(tmpDir);
    process.env.DEN_ROOT = tmpDir;
    expect(getDistRoot()).toBe(path.resolve(tmpDir));
  });

  it("honors DEN_ROOT", () => {
    profile(tmpDir, "acme");
    process.env.DEN_ROOT = tmpDir;
    expect(getDistRoot()).toBe(path.resolve(tmpDir));
  });

  it("REJECTS a DEN_ROOT with no den.yml (stale/mistyped env)", () => {
    // A wrong root would anchor every write (and the clone-guard allowlist)
    // at an arbitrary directory.
    process.env.DEN_ROOT = tmpDir;
    process.argv[1] = path.join(tmpDir, "x.js");
    expect(() => getDistRoot()).toThrow(/DEN_ROOT is set to/);
  });

  it("REJECTS a DEN_ROOT with no den.yml", () => {
    process.env.DEN_ROOT = tmpDir;
    expect(() => getDistRoot()).toThrow(/DEN_ROOT is set to/);
  });

  it("walks up from argv[1] to the directory holding den.yml", () => {
    const root = path.join(tmpDir, "den-checkout");
    const deep = path.join(
      root,
      "node_modules",
      "@monster-orange",
      "den",
      "dist",
    );
    fs.mkdirSync(deep, { recursive: true });
    profile(root);
    process.argv[1] = path.join(deep, "index.js");
    expect(getDistRoot()).toBe(root);
  });

  it("refuses the walked root when the product's own root variable points elsewhere", () => {
    const root = path.join(tmpDir, "checkout");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    profile(root);
    process.argv[1] = path.join(root, "bin", "cli.js");
    process.env.DEN_ROOT = path.join(tmpDir, "elsewhere");
    expect(() => getDistRoot()).toThrow(/DEN_ROOT is set to/);
  });

  it("THROWS when the walk fails — never falls back to process.cwd()", () => {
    const stray = path.join(tmpDir, "some", "other", "place");
    fs.mkdirSync(stray, { recursive: true });
    process.argv[1] = path.join(stray, "tool.js");
    expect(() => getDistRoot()).toThrow(/cannot locate the distribution root/);
    expect(() => getDistRoot()).toThrow(/DEN_ROOT/);
  });

  it("does not treat a package.json, even one named like the product, as a root", () => {
    const foreign = path.join(tmpDir, "den");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(
      path.join(foreign, "package.json"),
      JSON.stringify({ name: "den" }),
    );
    process.argv[1] = path.join(foreign, "script.js");
    expect(() => getDistRoot()).toThrow(/cannot locate/);
  });
});

describe("getEngineRoot", () => {
  it("finds Den's own package (this checkout, in the test run)", () => {
    const root = getEngineRoot();
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf-8"),
    );
    expect(pkg.name).toBe("@monster-orange/den");
  });
});

describe("getStateDir", () => {
  it("is the profile's state dir, or <PREFIX>_HOME", () => {
    profile(tmpDir);
    process.env.DEN_ROOT = tmpDir;
    expect(getStateDir()).toBe(path.join(os.homedir(), ".den"));
    process.env.DEN_HOME = path.join(tmpDir, "state");
    expect(getStateDir()).toBe(path.join(tmpDir, "state"));
  });
});

describe("getInvokeCwd", () => {
  it("still reflects the caller's cwd (the one legitimate cwd consumer)", () => {
    const saved = process.env.DEN_INVOKE_CWD;
    delete process.env.DEN_INVOKE_CWD;
    try {
      expect(getInvokeCwd()).toBe(process.cwd());
    } finally {
      if (saved !== undefined) process.env.DEN_INVOKE_CWD = saved;
    }
  });
});
