import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  MANIFEST_DISPLAY_NAME,
  loadManifest,
  manifestLayers,
  manifestLayersLabel,
  overrideManifestPath,
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

describe("manifest overrides", () => {
  let held: string;
  beforeEach(() => {
    held = createTempRoot();
    process.env.DEN_MANIFESTS_DIR = held;
  });
  afterEach(() => {
    delete process.env.DEN_MANIFESTS_DIR;
  });
  /** A checkout whose origin is …/shop.git, in a folder named otherwise. */
  function shopCheckout(): string {
    const dir = path.join(createTempRoot(), "checkout");
    fs.mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", [
      "-C",
      dir,
      "remote",
      "add",
      "origin",
      "git@github.com:acme/shop.git",
    ]);
    return dir;
  }
  const OVERRIDE = [
    "services:",
    "  web:",
    "    commands:",
    "      local:",
    "        up: make up-fast",
    "",
  ].join("\n");
  const BASE = (name: string): string =>
    [
      `name: ${name}`,
      "services:",
      "  web:",
      "    commands:",
      "      local:",
      "        up: make up",
      "        down: make down",
      "",
    ].join("\n");

  it("merges manifests/<repo>.override.yml onto the repo's own manifest", async () => {
    const repo = shopCheckout();
    fs.writeFileSync(path.join(repo, ".den.yml"), BASE("shop-own"));
    fs.writeFileSync(path.join(held, "shop.override.yml"), OVERRIDE);
    const want = {
      name: "shop-own",
      services: {
        web: { commands: { local: { up: "make up-fast", down: "make down" } } },
      },
    };
    expect(readManifest(repo)).toEqual(want);
    await expect(readManifestAsync(repo)).resolves.toEqual(want);
    expect(manifestLayers(repo)).toEqual(["repo", "override"]);
    expect(overrideManifestPath(repo)).toBe(
      path.join(held, "shop.override.yml"),
    );
  });

  it("merges the override onto a held manifest", () => {
    const repo = shopCheckout();
    fs.writeFileSync(path.join(held, "shop.den.yml"), BASE("shop-held"));
    fs.writeFileSync(path.join(held, "shop.override.yml"), OVERRIDE);
    expect(readManifest(repo)?.services?.web?.commands?.local).toEqual({
      up: "make up-fast",
      down: "make down",
    });
    expect(manifestLayers(repo)).toEqual(["held", "override"]);
  });

  it("matches the repo name exactly", () => {
    const repo = shopCheckout();
    fs.writeFileSync(path.join(repo, ".den.yml"), BASE("shop-own"));
    fs.writeFileSync(path.join(held, "shop-web.override.yml"), OVERRIDE);
    expect(overrideManifestPath(repo)).toBeNull();
    expect(manifestLayers(repo)).toEqual(["repo"]);
    expect(readManifest(repo)?.services?.web?.commands?.local?.up).toBe(
      "make up",
    );
  });

  it("never treats an override with no base as a manifest", async () => {
    const repo = shopCheckout();
    fs.writeFileSync(path.join(held, "shop.override.yml"), "name: shop\n");
    const load = loadManifest(repo);
    expect(load.manifest).toBeNull();
    expect(load.error).toMatch(/no base manifest/);
    expect(readManifest(repo)).toBeNull();
    await expect(readManifestAsync(repo)).resolves.toBeNull();
    expect(manifestLayers(repo)).toEqual([]);
  });

  it("labels the layers that applied", () => {
    const repo = shopCheckout();
    expect(manifestLayers(repo)).toEqual([]);
    expect(manifestLayersLabel([])).toBe("none");
    fs.writeFileSync(path.join(held, "shop.den.yml"), BASE("shop-held"));
    expect(manifestLayers(repo)).toEqual(["held"]);
    expect(manifestLayersLabel(["held"])).toBe("held");
    expect(manifestLayersLabel(["repo", "override"])).toBe("repo + override");
  });
});
