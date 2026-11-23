/**
 * Issue 1036: a run whose node_modules no longer matches package-lock.json
 * (a checkout installed weeks ago, or a worktree that borrows another's)
 * failed far from the cause: agent create answered 503 because the
 * optional @lydell/node-pty was missing, axe-core and @codemirror were
 * "not found", and the bell tests counted rows that were never there.
 * Jest's global setup now stops the run first and says which packages
 * drifted and to run `npm ci`.
 */
import { afterEach, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type M = typeof import("../../deps-check.js");
let checkDeps: M["checkDeps"];
let depsDrift: M["depsDrift"];
let skippedHere: M["skippedHere"];
beforeAll(async () => {
  ({ checkDeps, depsDrift, skippedHere } = await import("../../deps-check.js"));
});

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A repo with a package.json, its lock, and what is installed. */
function repo(o: {
  deps?: Record<string, string>;
  dev?: Record<string, string>;
  optional?: Record<string, string>;
  installed: Record<string, string>;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-deps-1036-"));
  tmps.push(root);
  const all = { ...o.deps, ...o.dev, ...o.optional };
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "x",
      dependencies: o.deps ?? {},
      devDependencies: o.dev ?? {},
      optionalDependencies: o.optional ?? {},
    }),
  );
  const packages: Record<string, unknown> = { "": { name: "x" } };
  for (const [n, v] of Object.entries(all))
    packages[`node_modules/${n}`] = {
      version: v,
      ...(o.optional?.[n] ? { optional: true } : {}),
    };
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  for (const [n, v] of Object.entries(o.installed)) {
    const d = path.join(root, "node_modules", n);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, "package.json"),
      JSON.stringify({ name: n, version: v }),
    );
  }
  return root;
}

describe("depsDrift (issue 1036)", () => {
  it("everything installed at the lock's version: no drift", () => {
    const root = repo({
      deps: { a: "1.0.0" },
      dev: { "@s/b": "2.0.0" },
      optional: { c: "3.0.0" },
      installed: { a: "1.0.0", "@s/b": "2.0.0", c: "3.0.0" },
    });
    expect(depsDrift(root)).toEqual([]);
  });

  it("a missing package, an optional one too, and an old version are named", () => {
    const root = repo({
      deps: { a: "1.0.0" },
      dev: { "@s/b": "2.0.0" },
      optional: { c: "3.0.0" },
      installed: { a: "0.9.0" },
    });
    expect(depsDrift(root)).toEqual([
      "a: 0.9.0 installed, the lock has 1.0.0",
      "@s/b: not installed (the lock has 2.0.0)",
      "c: not installed (the lock has 3.0.0)",
    ]);
  });

  it("a package the lock skips on this platform is not asked for", () => {
    const root = repo({ optional: { c: "3.0.0" }, installed: {} });
    const lock = path.join(root, "package-lock.json");
    const l = JSON.parse(fs.readFileSync(lock, "utf-8"));
    l.packages["node_modules/c"].os = ["no-such-os"];
    fs.writeFileSync(lock, JSON.stringify(l));
    expect(depsDrift(root)).toEqual([]);
  });

  it("os and cpu lists read as npm reads them, negations too", () => {
    expect(skippedHere({ os: ["darwin"] }, "darwin", "arm64")).toBe(false);
    expect(skippedHere({ os: ["darwin"] }, "linux", "x64")).toBe(true);
    expect(skippedHere({ os: ["!win32"] }, "win32", "x64")).toBe(true);
    expect(skippedHere({ os: ["!win32"] }, "linux", "x64")).toBe(false);
    expect(skippedHere({ cpu: ["arm64"] }, "darwin", "x64")).toBe(true);
    expect(skippedHere({ os: ["linux", "!android"] }, "android", "arm64")).toBe(
      true,
    );
    expect(skippedHere({}, "linux", "x64")).toBe(false);
  });

  it("no lock (an installed package, not a checkout): nothing to check", () => {
    const root = repo({ deps: { a: "1.0.0" }, installed: {} });
    fs.rmSync(path.join(root, "package-lock.json"));
    expect(depsDrift(root)).toEqual([]);
  });
});

describe("checkDeps: the run stops first (issue 1036)", () => {
  it("drift: it throws, naming the packages and npm ci", () => {
    const root = repo({ optional: { c: "3.0.0" }, installed: {} });
    expect(() => checkDeps(root, {})).toThrow(
      /node_modules does not match package-lock\.json[\s\S]*c: not installed[\s\S]*npm ci/,
    );
  });

  it("DEN_DEPS_CHECK=off lets a run go on", () => {
    const root = repo({ optional: { c: "3.0.0" }, installed: {} });
    expect(() => checkDeps(root, { DEN_DEPS_CHECK: "off" })).not.toThrow();
  });

  it("this checkout's own node_modules matches its lock", () => {
    expect(depsDrift(process.cwd())).toEqual([]);
  });

  it("Jest's global setup runs it before any worker starts", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "tests/global-setup.mjs"),
      "utf-8",
    );
    expect(src).toMatch(/import \{ checkDeps \} from "\.\/deps-check\.js"/);
    expect(src).toMatch(/globalSetup\(\) \{[^}]*?checkDeps\(/);
  });
});
