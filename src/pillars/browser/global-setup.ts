/**
 * Global Setup for Staged Synthetic Tests
 *
 * 1. Verify web host is reachable (fail fast if app is down)
 * 2. Log in as admin + user in parallel via headless browser login
 *    — credentials from the secrets backend (local) or ENV vars (CI)
 *    — sessions are ephemeral: written fresh each run, never manually managed
 */

import { type FullConfig } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";
import {
  getCredentials,
  headlessLogin,
} from "../../shared/auth/headless-login.js";
import { envSelector } from "../../shared/environment/env-selector.js";
import type {
  BrowserLoginConfig,
  Environment,
} from "../../shared/types/index.js";
import { getDistRoot } from "../../shared/paths.js";

import { product } from "../../shared/product.js";
// Den-root anchored, NOT process.cwd(): auth sessions are WRITTEN here and
// the consuming configs read storageState from the anchored resolveAuthPath.
const AUTH_DIR = path.resolve(getDistRoot(), "playwright/.auth");

async function login(
  role: "admin" | "user" | "beta",
  baseUrl: string,
  environment: Environment,
  browserLogin?: BrowserLoginConfig,
): Promise<void> {
  const authFile = path.join(AUTH_DIR, `${role}-${environment}.json`);
  const creds = await getCredentials(role, environment);
  if (!creds) {
    const localHint =
      role === "admin"
        ? `  Local: make auth-configure env=${environment}  (sets up your admin account)\n`
        : `  Local: sign in to the secrets backend; the ${role} account comes from test_accounts in the org config\n`;
    throw new Error(
      `No credentials for ${role}.\n` +
        localHint +
        `  CI: set E2E_${role.toUpperCase()}_EMAIL / E2E_${role.toUpperCase()}_PASSWORD`,
    );
  }
  await headlessLogin(
    role,
    baseUrl,
    creds.email,
    creds.password,
    authFile,
    browserLogin,
  );
}

async function globalSetup(_config: FullConfig) {
  const environment = (process.env.E2E_ENVIRONMENT as Environment) || "local";
  const envConfig = await envSelector.loadEnvironment(environment);
  const baseUrl = envConfig.baseUrls.web;
  const browserLogin = envConfig.auth?.browser;

  // ─── Health Check ──────────────────────────────────────────────────────────
  console.log(`\n🏥 Health check: ${baseUrl}\n`);
  try {
    const response = await fetch(baseUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok && response.status !== 401 && response.status !== 403) {
      console.error(`❌ Host returned error status: ${response.status}`);
      console.error(`   URL: ${baseUrl}`);
      console.error(
        `\n💡 Make sure the app is running before running tests.\n`,
      );
      process.exit(1);
    }

    console.log(`✅ Host is reachable (status: ${response.status})\n`);
  } catch (error: unknown) {
    const isLocalUrl = baseUrl.startsWith("http://");

    console.error(`❌ Cannot reach host: ${baseUrl}`);
    console.error(`   Error: ${(error as Error).message}`);
    if (isLocalUrl) {
      console.error(`\n💡 The app does not appear to be running.`);
      console.error(
        `   Start it first (for example: ${product().cli} up, or the app repo's own make up).\n`,
      );
    } else {
      console.error(`\n💡 Cannot reach ${baseUrl}. Check your network.\n`);
    }
    process.exit(1);
  }

  // ─── Auth: parallel headless login ─────────────────────────────────────────
  console.log("🔐 Authenticating (admin + user + beta in parallel)...\n");

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  // admin + user are required — any failure aborts the run.
  // beta is optional — account may not be seeded in all envs yet;
  // a failure here warns and skips, letting beta tests fail on their own.
  try {
    await Promise.all([
      login("admin", baseUrl, environment, browserLogin),
      login("user", baseUrl, environment, browserLogin),
    ]);
  } catch (err: unknown) {
    console.error(`\n❌ Authentication failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  try {
    await login("beta", baseUrl, environment, browserLogin);
  } catch (err: unknown) {
    console.warn(`\n⚠️  Beta login skipped: ${(err as Error).message}`);
    console.warn(
      `   Ensure the beta test account exists for ${environment}.\n`,
    );
  }

  // Create bare symlinks (admin.json, user.json, beta.json) pointing to the
  // current env's auth files. Some spec files in linked repos hardcode the
  // non-suffixed path; these symlinks keep them working without code changes.
  for (const role of ["admin", "user", "beta"]) {
    const bare = path.join(AUTH_DIR, `${role}.json`);
    const target = `${role}-${environment}.json`;
    if (fs.existsSync(bare)) fs.unlinkSync(bare);
    fs.symlinkSync(target, bare);
  }

  console.log("\n✅ Pre-flight checks complete\n");
}

export default globalSetup;
