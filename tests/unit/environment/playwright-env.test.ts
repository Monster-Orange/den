/**
 * Unit tests for the sync Playwright-config env helpers
 * (src/shared/environment/playwright-env.ts).
 *
 * These helpers were previously untested; the journeys browser-session
 * module now consumes resolveAuthPath, pulling the file into coverage
 * scope, so its contract is pinned here.
 */

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  resolveEnv,
  resolveAuthPath,
  resolveBrowserBaseUrl,
} from "../../../src/shared/environment/playwright-env.js";

describe("resolveEnv", () => {
  const original = process.env.E2E_ENVIRONMENT;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.E2E_ENVIRONMENT;
    } else {
      process.env.E2E_ENVIRONMENT = original;
    }
  });

  it("prefers E2E_ENVIRONMENT when set", () => {
    process.env.E2E_ENVIRONMENT = "staging";
    expect(resolveEnv()).toBe("staging");
  });

  it("falls back to the default when unset", () => {
    delete process.env.E2E_ENVIRONMENT;
    expect(resolveEnv()).toBe("local");
    expect(resolveEnv("staging")).toBe("staging");
  });

  it("treats an empty E2E_ENVIRONMENT as unset", () => {
    process.env.E2E_ENVIRONMENT = "";
    expect(resolveEnv("dev")).toBe("dev");
  });
});

describe("resolveAuthPath", () => {
  it("builds <repoRoot>/playwright/.auth/<role>-<env>.json", () => {
    expect(resolveAuthPath("user", "local", "/repo")).toBe(
      path.resolve("/repo", "playwright/.auth/user-local.json"),
    );
    expect(resolveAuthPath("admin", "staging", "/repo")).toBe(
      path.resolve("/repo", "playwright/.auth/admin-staging.json"),
    );
  });
});

describe("resolveBrowserBaseUrl", () => {
  let tmpDir: string;
  let savedDistRoot: string | undefined;

  beforeEach(() => {
    savedDistRoot = process.env.DEN_ROOT;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-env-"));
    fs.mkdirSync(path.join(tmpDir, "config/environments"), {
      recursive: true,
    });
    // resolveBrowserBaseUrl reads config/environments/<env>.json anchored at
    // the den root (never cwd) — getDistRoot() validates DEN_ROOT
    // points at a package.json named "den".
    fs.writeFileSync(path.join(tmpDir, "den.yml"), "product:\n  name: den\n");
    process.env.DEN_ROOT = tmpDir;
  });

  afterEach(() => {
    if (savedDistRoot === undefined) delete process.env.DEN_ROOT;
    else process.env.DEN_ROOT = savedDistRoot;
  });

  function writeEnvConfig(env: string, contents: string): void {
    fs.writeFileSync(
      path.join(tmpDir, `config/environments/${env}.json`),
      contents,
    );
  }

  it("returns baseUrls.web from the env config", () => {
    writeEnvConfig(
      "local",
      JSON.stringify({ baseUrls: { web: "http://localhost:3000" } }),
    );
    expect(resolveBrowserBaseUrl("local")).toBe("http://localhost:3000");
  });

  it("throws when the env config file is missing", () => {
    expect(() => resolveBrowserBaseUrl("dev")).toThrow(
      /Cannot read environment config/,
    );
  });

  it("throws on invalid JSON", () => {
    writeEnvConfig("local", "{not json");
    expect(() => resolveBrowserBaseUrl("local")).toThrow(/Invalid JSON/);
  });

  it("throws when baseUrls.web is missing", () => {
    writeEnvConfig("local", JSON.stringify({ baseUrls: {} }));
    expect(() => resolveBrowserBaseUrl("local")).toThrow(
      /missing baseUrls\.web/,
    );
  });
});
