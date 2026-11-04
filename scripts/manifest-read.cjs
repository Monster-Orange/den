#!/usr/bin/env node
/**
 * Makefile helper — reads a .den.yml or .den.json manifest and
 * outputs a value to stdout.
 *
 * Usage:
 *   node scripts/manifest-read.cjs <repo-path> <operation>
 *
 * Operations:
 *   smoke-keys          — space-separated smoke service names
 *   smoke-testdir <svc> — testDir for a specific smoke service
 *   synth-testdir       — synthetics.testDir
 *
 * Returns empty string (exit 0) if the file/key doesn't exist.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

const [, , repoPath, operation, ...rest] = process.argv;

if (!repoPath || !operation) {
  console.error("Usage: manifest-read.cjs <repo-path> <operation> [arg]");
  process.exit(1);
}

/**
 * The manifest file names, from the distribution's den.yml (`product.manifest`,
 * else `.<product.name>.yml`), found by walking up from the cwd.
 */
function manifestNames() {
  let dir = process.cwd();
  for (;;) {
    const f = path.join(dir, "den.yml");
    if (fs.existsSync(f)) {
      const p = (yaml.parse(fs.readFileSync(f, "utf-8")) || {}).product || {};
      const name = (typeof p.name === "string" && p.name.trim()) || "den";
      const yml =
        (typeof p.manifest === "string" && p.manifest.trim()) || `.${name}.yml`;
      return [yml, yml.replace(/\.ya?ml$/, "") + ".json"];
    }
    const up = path.dirname(dir);
    if (up === dir) return [".den.yml", ".den.json"];
    dir = up;
  }
}

function readManifest(dir) {
  for (const name of manifestNames()) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, "utf-8");
      return name.endsWith(".yml") ? yaml.parse(raw) : JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

const manifest = readManifest(repoPath);
if (!manifest) {
  process.stdout.write("");
  process.exit(0);
}

switch (operation) {
  case "smoke-keys": {
    const keys = Object.keys(manifest.smoke || {});
    process.stdout.write(keys.join(" "));
    break;
  }
  case "smoke-testdir": {
    const svc = rest[0];
    const dir = manifest.smoke?.[svc]?.testDir ?? "";
    process.stdout.write(dir);
    break;
  }
  case "synth-testdir": {
    const dir = manifest.synthetics?.testDir ?? "(no synthetics key)";
    process.stdout.write(dir);
    break;
  }
  default:
    console.error(`Unknown operation: ${operation}`);
    process.exit(1);
}
