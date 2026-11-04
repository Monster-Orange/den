/**
 * Environment Selector
 * Loads and validates environment configurations
 */

import { readFile } from "fs/promises";
import { resolve, join } from "path";
import type { Environment, EnvironmentConfig } from "../types/index.js";

export class EnvironmentSelector {
  private configDir: string;
  private cache: Map<string, EnvironmentConfig> = new Map();

  constructor(configDir: string = "./config/environments") {
    this.configDir = resolve(configDir);
  }

  /**
   * Load environment configuration
   */
  async loadEnvironment(env: Environment): Promise<EnvironmentConfig> {
    // Check cache first
    if (this.cache.has(env)) {
      return this.cache.get(env)!;
    }

    const configPath = join(this.configDir, `${env}.json`);

    try {
      const content = await readFile(configPath, "utf-8");
      const config: EnvironmentConfig = JSON.parse(content);

      // Validate config
      this.validateConfig(config, env);

      // Cache and return
      this.cache.set(env, config);
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Environment configuration not found: ${env}\n` +
            `Expected file: ${configPath}\n` +
            `Available environments: ${(await this.getAvailableEnvironments()).join(", ")}`,
        );
      }
      throw new Error(
        `Failed to load environment config for "${env}": ${(error as Error).message}`,
      );
    }
  }

  /**
   * Get list of available environments
   */
  async getAvailableEnvironments(): Promise<Environment[]> {
    const { readdir } = await import("fs/promises");
    const preferredOrder: Environment[] = [
      "local",
      "dev",
      "sandbox",
      "staging",
      "beta",
      "prod",
      "production",
    ];

    try {
      const files = await readdir(this.configDir);
      const available = files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", "") as Environment)
        .filter((e) => preferredOrder.includes(e));

      // Sort by preferred order
      return available.sort(
        (a, b) => preferredOrder.indexOf(a) - preferredOrder.indexOf(b),
      );
    } catch {
      return preferredOrder;
    }
  }

  /**
   * Check if environment exists
   */
  async environmentExists(env: Environment): Promise<boolean> {
    const { access } = await import("fs/promises");
    const configPath = join(this.configDir, `${env}.json`);
    try {
      await access(configPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate environment configuration
   */
  private validateConfig(config: EnvironmentConfig, env: Environment): void {
    if (!config.name) {
      throw new Error(`Invalid config for ${env}: missing "name" field`);
    }

    if (config.name !== env) {
      throw new Error(
        `Invalid config for ${env}: "name" field is "${config.name}" but should be "${env}"`,
      );
    }

    if (!config.baseUrls) {
      throw new Error(`Invalid config for ${env}: missing "baseUrls" field`);
    }

    if (!config.baseUrls.web || !config.baseUrls.api) {
      throw new Error(
        `Invalid config for ${env}: "baseUrls" must contain "web" and "api"`,
      );
    }

    const provider = config.auth?.provider ?? (config.auth0 ? "auth0" : "none");
    if (
      provider === "auth0" &&
      (!config.auth0 || !config.auth0.domain || !config.auth0.clientId)
    ) {
      throw new Error(
        `Invalid config for ${env}: missing or incomplete "auth0" field`,
      );
    }
    if (
      provider === "cognito" &&
      (!config.auth?.cognito?.region || !config.auth.cognito.clientId)
    ) {
      throw new Error(
        `Invalid config for ${env}: auth.provider "cognito" needs auth.cognito.region and auth.cognito.clientId`,
      );
    }
    if (provider === "local-jwt" && !config.auth?.localJwt?.secretKey) {
      throw new Error(
        `Invalid config for ${env}: auth.provider "local-jwt" needs auth.localJwt.secretKey`,
      );
    }

    if (!config.timeouts || typeof config.timeouts.api !== "number") {
      throw new Error(
        `Invalid config for ${env}: missing or invalid "timeouts" field`,
      );
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// Export singleton instance
export const envSelector = new EnvironmentSelector();
