import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { validateManifestLayers } from "../../../src/shared/manifest/validate-manifest.js";
import { readManifest } from "../../../src/shared/manifest/read-manifest.js";

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-layers-"));
  tmpDirs.push(dir);
  return dir;
}

let held: string;
let repo: string;
let overridePath: string;

beforeEach(() => {
  held = tempDir();
  process.env.DEN_MANIFESTS_DIR = held;
  // Not a git checkout: the held lookup falls back to the folder name.
  repo = path.join(tempDir(), "shop");
  fs.mkdirSync(repo);
  overridePath = path.join(held, "shop.override.yml");
  fs.writeFileSync(
    path.join(repo, ".den.yml"),
    [
      "name: shop",
      "services:",
      "  web:",
      "    urls:",
      "      local: https://shop.example.com",
      "  api:",
      "    commands:",
      "      local:",
      "        up: make up",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  delete process.env.DEN_MANIFESTS_DIR;
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function errorsOf(v: ReturnType<typeof validateManifestLayers>) {
  return v.layers.flatMap((l) => l.result.errors);
}

describe("validateManifestLayers", () => {
  it("validates the base, the override and the merged result", () => {
    fs.writeFileSync(
      overridePath,
      "services:\n  api:\n    commands:\n      local:\n        up: make up-fast\n",
    );
    const v = validateManifestLayers(repo);
    expect(v.valid).toBe(true);
    expect(v.layers.map((l) => l.layer)).toEqual([
      "repo",
      "override",
      "merged",
    ]);
    expect(v.layers[1].file).toBe(overridePath);
  });

  it("validates a lone base as before", () => {
    const v = validateManifestLayers(repo);
    expect(v.valid).toBe(true);
    expect(v.layers.map((l) => l.layer)).toEqual(["repo"]);
  });

  it("rejects an override that names a service the base lacks", () => {
    fs.writeFileSync(overridePath, "services:\n  worker:\n    urls: {}\n");
    const v = validateManifestLayers(repo);
    expect(v.valid).toBe(false);
    expect(errorsOf(v)).toEqual([
      expect.objectContaining({
        path: "services.worker",
        file: overridePath,
        message: expect.stringMatching(/unknown service "worker"/),
      }),
    ]);
  });

  it("rejects an override that names a key the base lacks", () => {
    fs.writeFileSync(
      overridePath,
      "services:\n  api:\n    commands:\n      local:\n        down: make down\n",
    );
    const v = validateManifestLayers(repo);
    expect(v.valid).toBe(false);
    expect(errorsOf(v)).toEqual([
      expect.objectContaining({
        path: "services.api.commands.local.down",
        file: overridePath,
        message: expect.stringMatching(/unknown key "down"/),
      }),
    ]);
  });

  it("names the override file for a schema error inside it", () => {
    fs.writeFileSync(
      overridePath,
      "services:\n  web:\n    urls:\n      local: ftp://shop.example.com\n",
    );
    const v = validateManifestLayers(repo);
    expect(v.valid).toBe(false);
    const override = v.layers.find((l) => l.layer === "override");
    expect(override?.result.errors).toEqual([
      expect.objectContaining({
        path: "services.web.urls.local",
        file: overridePath,
        message: "must be an http(s) URL",
      }),
    ]);
    expect(v.layers.find((l) => l.layer === "repo")?.result.valid).toBe(true);
  });

  it("validates the merged result", () => {
    fs.writeFileSync(overridePath, "name: null\n");
    const v = validateManifestLayers(repo);
    expect(v.valid).toBe(false);
    const merged = v.layers.find((l) => l.layer === "merged");
    expect(merged?.result.errors).toEqual([
      expect.objectContaining({ path: "name" }),
    ]);
  });

  it("reports an override with no base as an error", () => {
    fs.rmSync(path.join(repo, ".den.yml"));
    fs.writeFileSync(overridePath, "name: shop\n");
    const v = validateManifestLayers(repo);
    expect(v.valid).toBe(false);
    expect(errorsOf(v)).toEqual([
      expect.objectContaining({
        file: overridePath,
        message: expect.stringMatching(/no base manifest/),
      }),
    ]);
  });

  // R13: placement is what a distribution most often needs to differ, so an
  // override may add `runs` and `target` to a service the base has.
  it("lets an override place a service remote (runs + target)", () => {
    fs.writeFileSync(
      overridePath,
      [
        "services:",
        "  api:",
        "    runs: { local: remote }",
        "    target: { env: dev, account: AWS, url: https://api.dev.acme.example/health, expect: 401 }",
        "",
      ].join("\n"),
    );
    const v = validateManifestLayers(repo);
    expect(errorsOf(v)).toEqual([]);
    expect(v.valid).toBe(true);
    expect(readManifest(repo)?.services?.api).toEqual(
      expect.objectContaining({
        runs: { local: "remote" },
        target: expect.objectContaining({ env: "dev", expect: 401 }),
      }),
    );
  });

  it("still rejects a placement key on a service the base lacks", () => {
    fs.writeFileSync(
      overridePath,
      "services:\n  worker:\n    runs: { local: remote }\n",
    );
    const v = validateManifestLayers(repo);
    expect(v.valid).toBe(false);
    expect(errorsOf(v)).toEqual([
      expect.objectContaining({ path: "services.worker" }),
    ]);
  });

  it("checks an override's placement values and env names", () => {
    fs.writeFileSync(
      overridePath,
      "services:\n  api:\n    runs: { local: cloud }\n",
    );
    const bad = validateManifestLayers(repo);
    expect(bad.valid).toBe(false);
    expect(
      bad.layers.find((l) => l.layer === "override")?.result.errors,
    ).toEqual([expect.objectContaining({ path: "services.api.runs.local" })]);

    fs.writeFileSync(
      overridePath,
      "services:\n  api:\n    runs: { local: remote, qa: remote }\n    target: { env: dev }\n",
    );
    const env = validateManifestLayers(repo);
    expect(env.valid).toBe(false);
    expect(env.layers.find((l) => l.layer === "merged")?.result.errors).toEqual(
      [
        expect.objectContaining({
          path: "services.api.runs.qa",
          message: expect.stringMatching(/unknown environment "qa"/),
        }),
      ],
    );
  });
});
