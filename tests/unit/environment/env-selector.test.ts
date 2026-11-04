/**
 * Tests for EnvironmentSelector
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { EnvironmentSelector } from "../../../src/shared/environment/env-selector.js";
import type { EnvironmentConfig } from "../../../src/shared/types/index.js";

describe("EnvironmentSelector", () => {
  const testConfigDir = join(process.cwd(), "test-config-env");
  let envSelector: EnvironmentSelector;

  const validDevConfig: EnvironmentConfig = {
    name: "dev",
    baseUrls: {
      web: "https://dev.example.app",
      api: "https://api-dev.example.app",
      services: {
        service1: "https://service1-dev.example.app",
      },
    },
    auth0: {
      domain: "shop-dev.us.auth0.com",
      clientId: "test-client-id",
      audience: "https://api-dev.example.app",
    },
    timeouts: {
      api: 30000,
      pageLoad: 60000,
    },
  };

  beforeEach(async () => {
    // Create test config directory
    await mkdir(testConfigDir, { recursive: true });
    envSelector = new EnvironmentSelector(testConfigDir);
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testConfigDir, { recursive: true, force: true });
  });

  describe("loadEnvironment", () => {
    it("should load valid environment configuration", async () => {
      // Write test config
      await writeFile(
        join(testConfigDir, "dev.json"),
        JSON.stringify(validDevConfig),
      );

      const config = await envSelector.loadEnvironment("dev");

      expect(config.name).toBe("dev");
      expect(config.baseUrls.web).toBe("https://dev.example.app");
      expect(config.auth0.domain).toBe("shop-dev.us.auth0.com");
    });

    it("should cache loaded configurations", async () => {
      await writeFile(
        join(testConfigDir, "dev.json"),
        JSON.stringify(validDevConfig),
      );

      const config1 = await envSelector.loadEnvironment("dev");
      const config2 = await envSelector.loadEnvironment("dev");

      expect(config1).toBe(config2); // Same object reference (cached)
    });

    it("should throw error for non-existent environment", async () => {
      await expect(envSelector.loadEnvironment("dev")).rejects.toThrow(
        /Environment configuration not found: dev/,
      );
    });

    it("should throw error for invalid JSON", async () => {
      await writeFile(join(testConfigDir, "dev.json"), "invalid json");

      await expect(envSelector.loadEnvironment("dev")).rejects.toThrow(
        /Failed to load environment config/,
      );
    });

    it("should validate required fields", async () => {
      const invalidConfig = { ...validDevConfig };
      delete (invalidConfig as Record<string, unknown>).baseUrls;

      await writeFile(
        join(testConfigDir, "dev.json"),
        JSON.stringify(invalidConfig),
      );

      await expect(envSelector.loadEnvironment("dev")).rejects.toThrow(
        /missing "baseUrls" field/,
      );
    });

    it("should validate name field matches environment", async () => {
      const wrongNameConfig = { ...validDevConfig, name: "staging" };

      await writeFile(
        join(testConfigDir, "dev.json"),
        JSON.stringify(wrongNameConfig),
      );

      await expect(envSelector.loadEnvironment("dev")).rejects.toThrow(
        /name" field is "staging" but should be "dev"/,
      );
    });

    it("should validate auth0 configuration when auth.provider is auth0", async () => {
      const noAuth0Config = { ...validDevConfig, auth: { provider: "auth0" } };
      delete (noAuth0Config as Record<string, unknown>).auth0;

      await writeFile(
        join(testConfigDir, "dev.json"),
        JSON.stringify(noAuth0Config),
      );

      await expect(envSelector.loadEnvironment("dev")).rejects.toThrow(
        /missing or incomplete "auth0" field/,
      );
    });

    it("accepts an environment with no auth (provider defaults to none)", async () => {
      const noAuth = { ...validDevConfig };
      delete (noAuth as Record<string, unknown>).auth0;
      await writeFile(join(testConfigDir, "dev.json"), JSON.stringify(noAuth));
      await expect(envSelector.loadEnvironment("dev")).resolves.toMatchObject({
        name: "dev",
      });
    });

    it("requires region + clientId for the cognito strategy", async () => {
      const cfg = {
        ...validDevConfig,
        auth: { provider: "cognito", cognito: { region: "us-east-1" } },
      };
      await writeFile(join(testConfigDir, "dev.json"), JSON.stringify(cfg));
      await expect(envSelector.loadEnvironment("dev")).rejects.toThrow(
        /auth\.cognito\.region and auth\.cognito\.clientId/,
      );
    });
  });

  describe("environmentExists", () => {
    it("should return true for existing environment", async () => {
      await writeFile(
        join(testConfigDir, "dev.json"),
        JSON.stringify(validDevConfig),
      );

      const exists = await envSelector.environmentExists("dev");
      expect(exists).toBe(true);
    });

    it("should return false for non-existing environment", async () => {
      const exists = await envSelector.environmentExists("dev");
      expect(exists).toBe(false);
    });
  });

  describe("getAvailableEnvironments", () => {
    it("should return list of available environments", async () => {
      await writeFile(
        join(testConfigDir, "dev.json"),
        JSON.stringify(validDevConfig),
      );
      await writeFile(
        join(testConfigDir, "local.json"),
        JSON.stringify({ ...validDevConfig, name: "local" }),
      );

      const envs = await envSelector.getAvailableEnvironments();

      expect(envs).toContain("dev");
      expect(envs).toContain("local");
    });

    it("should filter out non-json files", async () => {
      await writeFile(
        join(testConfigDir, "dev.json"),
        JSON.stringify(validDevConfig),
      );
      await writeFile(join(testConfigDir, "README.md"), "# Readme");

      const envs = await envSelector.getAvailableEnvironments();

      expect(envs).toContain("dev");
      expect(envs).not.toContain("README");
    });

    it("lists beta and prod after local, in that order", async () => {
      for (const name of ["prod", "local", "beta"])
        await writeFile(
          join(testConfigDir, `${name}.json`),
          JSON.stringify({ ...validDevConfig, name }),
        );
      expect(await envSelector.getAvailableEnvironments()).toEqual([
        "local",
        "beta",
        "prod",
      ]);
    });

    it("should return default environments if directory does not exist", async () => {
      const nonExistentSelector = new EnvironmentSelector("./non-existent-dir");
      const envs = await nonExistentSelector.getAvailableEnvironments();

      expect(envs).toContain("local");
      expect(envs).toContain("dev");
      expect(envs).toContain("sandbox");
      expect(envs).toContain("staging");
    });
  });

  describe("clearCache", () => {
    it("should clear cached configurations", async () => {
      await writeFile(
        join(testConfigDir, "dev.json"),
        JSON.stringify(validDevConfig),
      );

      const config1 = await envSelector.loadEnvironment("dev");
      envSelector.clearCache();

      // Modify the file
      const modifiedConfig = { ...validDevConfig, name: "dev" };
      modifiedConfig.baseUrls.web = "https://modified.example.app";
      await writeFile(
        join(testConfigDir, "dev.json"),
        JSON.stringify(modifiedConfig),
      );

      const config2 = await envSelector.loadEnvironment("dev");

      expect(config1).not.toBe(config2);
      expect(config2.baseUrls.web).toBe("https://modified.example.app");
    });
  });
});
