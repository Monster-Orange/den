import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(process.cwd());

describe("version sync", () => {
  it("package.json version matches the latest CHANGELOG.md entry", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
    ) as { version: string };

    const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf-8");

    // First ## [X.Y.Z] heading is the latest release
    const heading = changelog.match(/^##\s+\[([^\]]+)\](.*)$/m);
    const changelogVersion = heading?.[1];

    expect(changelogVersion).toBeDefined();
    // Work toward an unreleased version carries a prerelease version
    // (0.1.0-dev.0 under "## [0.1.0] - unreleased"), which never publishes.
    const unreleased = /unreleased/i.test(heading?.[2] ?? "");
    const version = unreleased ? pkg.version.replace(/-.*$/, "") : pkg.version;
    expect(version).toBe(changelogVersion);
    if (!unreleased) expect(pkg.version).not.toMatch(/-/);
  });

  it("a released version is publishable (npm refuses a private package)", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
    ) as { version: string; private?: boolean };
    if (!/-/.test(pkg.version)) expect(pkg.private).not.toBe(true);
  });

  it("package-lock.json version matches package.json version", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
    ) as { version: string };

    const lock = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf-8"),
    ) as { version: string };

    expect(lock.version).toBe(pkg.version);
  });
});
