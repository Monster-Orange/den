import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  MANIFEST_DISPLAY_NAME,
  readManifest,
  readManifestAsync,
  resolveManifestPath,
} from "../../../src/shared/manifest/read-manifest.js";

const tmpDirs: string[] = [];

function createTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-manifest-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("read-manifest", () => {
  it("prefers .den.yml over .den.json and parses yaml manifests", () => {
    const rootDir = createTempRoot();
    fs.writeFileSync(
      path.join(rootDir, ".den.yml"),
      [
        "name: sample-service",
        "smoke:",
        "  api:",
        "    testDir: tests/smoke",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(rootDir, ".den.json"),
      JSON.stringify({ name: "from-json" }),
      "utf-8",
    );

    expect(resolveManifestPath(rootDir)).toBe(path.join(rootDir, ".den.yml"));
    expect(readManifest(rootDir)).toEqual(
      expect.objectContaining({
        name: "sample-service",
      }),
    );
  });

  it("parses json manifests when yaml is absent", () => {
    const rootDir = createTempRoot();
    fs.writeFileSync(
      path.join(rootDir, ".den.json"),
      JSON.stringify({ name: "json-manifest" }),
      "utf-8",
    );

    expect(resolveManifestPath(rootDir)).toBe(path.join(rootDir, ".den.json"));
    expect(readManifest(rootDir)).toEqual(
      expect.objectContaining({
        name: "json-manifest",
      }),
    );
  });

  it("returns null when no manifest exists or parsing fails", async () => {
    const missingRoot = createTempRoot();
    const invalidRoot = createTempRoot();
    fs.writeFileSync(path.join(invalidRoot, ".den.json"), "{invalid", "utf-8");

    expect(resolveManifestPath(missingRoot)).toBeNull();
    expect(readManifest(missingRoot)).toBeNull();
    expect(readManifest(invalidRoot)).toBeNull();
    await expect(readManifestAsync(missingRoot)).resolves.toBeNull();
    await expect(readManifestAsync(invalidRoot)).resolves.toBeNull();
  });

  it("reads manifests asynchronously", async () => {
    const rootDir = createTempRoot();
    fs.writeFileSync(
      path.join(rootDir, ".den.yml"),
      "name: async-manifest\n",
      "utf-8",
    );

    await expect(readManifestAsync(rootDir)).resolves.toEqual(
      expect.objectContaining({
        name: "async-manifest",
      }),
    );
    expect(MANIFEST_DISPLAY_NAME).toBe(".den.yml");
  });
});

describe("Den-side manifests", () => {
  function checkout(remote: string): string {
    const dir = createTempRoot();
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
    return dir;
  }
  function denManifests(files: Record<string, string>): void {
    const dir = createTempRoot();
    for (const [name, body] of Object.entries(files))
      fs.writeFileSync(path.join(dir, name), body);
    process.env.DEN_MANIFESTS_DIR = dir;
  }
  afterEach(() => {
    delete process.env.DEN_MANIFESTS_DIR;
  });

  it("uses manifests/<origin repo>.den.yml when the checkout has none", () => {
    denManifests({
      "widget.den.yml": "name: widget-from-den\n",
    });
    const repo = checkout("git@github.com:Acme/widget.git");
    expect(readManifest(repo)?.name).toBe("widget-from-den");
  });

  it("lets the repo's own manifest win", () => {
    denManifests({
      "widget.den.yml": "name: widget-from-den\n",
    });
    const repo = checkout("https://github.com/Acme/widget.git");
    fs.writeFileSync(path.join(repo, ".den.yml"), "name: widget-own\n");
    expect(readManifest(repo)?.name).toBe("widget-own");
  });

  it("finds nothing for a folder that is not a checkout", () => {
    denManifests({
      "widget.den.yml": "name: widget-from-den\n",
    });
    expect(resolveManifestPath(createTempRoot())).toBeNull();
  });
});
