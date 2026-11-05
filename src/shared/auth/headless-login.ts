/**
 * Headless browser login
 *
 * Two exported functions:
 *   getCredentials()  — resolves email+password from ENV vars or the secrets backend
 *   headlessLogin()   — performs a full browser-based login and saves the session
 *
 * Credential priority:
 *   1. ENV vars  — E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD  (CI only)
 *                  E2E_USER_EMAIL  / E2E_USER_PASSWORD
 *                  E2E_BETA_EMAIL  / E2E_BETA_PASSWORD
 *                  E2E_ROOT_ADMIN_EMAIL / E2E_ROOT_ADMIN_PASSWORD
 *   2. Shared account — `test_accounts.roles.<role>` in the org config
 *                  (email + secrets-backend item; see ./test-accounts.ts)
 *   3. admin / root_admin only — the per-engineer account written by
 *                  `make auth-configure [env=<env>]` (email + secret ref)
 */

import { chromium } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import type { BrowserLoginConfig, Environment } from "../types/index.js";
import { getDistRoot } from "../paths.js";
import { getSecretsProvider } from "../secrets/index.js";
import { sharedTestAccount } from "./test-accounts.js";

import { product } from "../product.js";
// Anchored to the den checkout, NEVER process.cwd(): AUTH_DIR below is
// WRITTEN (saved browser sessions are secrets), and the "scripts always run
// from the repo root" assumption is false — bin/den never cds and
// test-runner-spawned playwright children inherit the user's cwd.
const PROJECT_ROOT = getDistRoot();

const AUTH_DIR = path.resolve(PROJECT_ROOT, "playwright/.auth");

// Per-engineer admin config — stores email + secret reference (no password)
// Created by: make auth-configure [env=<env>] (secrets.provider: 1password)
// Lookup order: config/local/admin-auth-{env}.json → config/local/admin-auth.json
const LOCAL_CONFIG_DIR = path.resolve(PROJECT_ROOT, "config/local");

interface AdminAuthConfig {
  email: string;
  opRef: string;
  // Saved by auth-configure for robust lookup by ID (avoids op:// URI parsing
  // issues with special characters in vault/item names)
  itemId?: string;
  vaultId?: string;
  fieldLabel?: string;
}

function loadAdminConfig(environment: Environment): AdminAuthConfig | null {
  const candidates = [
    path.join(LOCAL_CONFIG_DIR, `admin-auth-${environment}.json`),
    path.join(LOCAL_CONFIG_DIR, "admin-auth.json"),
  ];
  for (const configPath of candidates) {
    try {
      if (!fs.existsSync(configPath)) continue;
      return JSON.parse(
        fs.readFileSync(configPath, "utf-8"),
      ) as AdminAuthConfig;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Read a secret through the configured secrets strategy (Doppler, 1Password,
 * or env — see src/shared/secrets). Name kept for call-site stability.
 */
async function opGetField(opts: {
  item: string; // item ID or name
  vault?: string; // vault ID or name
  field: string; // field label (e.g. "password")
}): Promise<string> {
  return getSecretsProvider().get({
    vault: opts.vault ?? "",
    item: opts.item,
    field: opts.field,
  });
}

const ENV_PREFIX: Record<"admin" | "user" | "beta" | "root_admin", string> = {
  admin: "E2E_ADMIN",
  user: "E2E_USER",
  beta: "E2E_BETA",
  root_admin: "E2E_ROOT_ADMIN",
};

/**
 * Retrieve credentials for a role.
 *
 * Priority:
 *   1. ENV vars  — CI-friendly, never used on local dev
 *   2. The shared account from `test_accounts` in the org config
 *   3. admin / root_admin: config/local/admin-auth[-<env>].json
 *      (email + secret ref, set via make auth-configure)
 *
 * Returns null if no credentials are available.
 */
export async function getCredentials(
  role: "admin" | "user" | "beta" | "root_admin",
  environment: Environment,
): Promise<{ email: string; password: string } | null> {
  // 1. ENV vars — CI only
  const prefix = ENV_PREFIX[role];
  const envEmail = process.env[`${prefix}_EMAIL`];
  const envPassword = process.env[`${prefix}_PASSWORD`];
  if (envEmail && envPassword) {
    console.log(`  Using ENV var credentials for ${role}`);
    return { email: envEmail, password: envPassword };
  }

  // 2/3. Secrets backend — local dev (dynamic, nothing written to disk)
  try {
    const shared = sharedTestAccount(role, environment);
    if (shared) {
      const password = await opGetField({
        item: shared.ref.item,
        vault: shared.ref.vault,
        field: shared.ref.field,
      });
      console.log(
        `  Using secrets-backend credentials for ${role} (${shared.email})`,
      );
      return { email: shared.email, password };
    }

    if (role === "admin" || role === "root_admin") {
      // No shared account here: use the per-engineer personal account
      // (personal accounts serve both admin and root_admin).
      const adminConfig = loadAdminConfig(environment);
      if (adminConfig?.email && adminConfig?.opRef) {
        const password = await opGetField({
          item: adminConfig.itemId ?? adminConfig.opRef,
          vault: adminConfig.vaultId,
          field: adminConfig.fieldLabel ?? "password",
        });
        console.log(
          `  Using secrets-backend credentials for ${role} (${adminConfig.email})`,
        );
        return { email: adminConfig.email, password };
      }
      console.log(
        `  No admin config for ${environment} — run: make auth-configure env=${environment}`,
      );
    } else {
      console.log(
        `  No shared ${role} account for ${environment} — set test_accounts.roles.${role} in the org config`,
      );
    }
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (
      msg.includes("not signed in") ||
      msg.includes("sign in") ||
      msg.includes("ENOENT") ||
      msg.includes("not found") ||
      msg.includes("command not found")
    ) {
      console.log(
        `  Secrets backend unavailable — sign in (make ${product().cli}-setup-secrets)`,
      );
    } else {
      console.log(`  Secrets backend error: ${msg.split("\n")[0]}`);
    }
  }

  return null;
}

/**
 * Perform a fully headless browser login using email+password credentials.
 *
 * Navigates to the app's login path → follows the redirect to the IdP →
 * fills email/password → waits for the redirect back to the app origin →
 * saves context.storageState() to authFile.
 *
 * `login.loginPath` (environment config `auth.browser.loginPath`, default
 * "/") is where the app starts its login redirect. Success is "back on the
 * app origin", which holds for any IdP host (hosted domain or vanity CNAME).
 *
 * Sessions are ephemeral — written fresh on each test run by global-setup.
 *
 * @istanbul ignore next - Browser automation tested via E2E tests
 */
/* istanbul ignore next */
export async function headlessLogin(
  role: "admin" | "user" | "beta",
  baseUrl: string,
  email: string,
  password: string,
  outputPath?: string,
  login: BrowserLoginConfig = {},
): Promise<void> {
  const env = process.env.E2E_ENVIRONMENT || "local";
  const authFile = outputPath ?? path.join(AUTH_DIR, `${role}-${env}.json`);

  console.log(`  Logging in: ${role} (${email})`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const loginPath = login.loginPath ?? "/";
    const loginUrl = `${baseUrl.replace(/\/$/, "")}${loginPath.startsWith("/") ? "" : "/"}${loginPath}`;
    const appOrigin = new URL(baseUrl).origin;
    await page.goto(loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for the IdP redirect: "navigated away from the app origin",
    // never a hard-coded IdP host, so hosted and vanity domains both work.
    await page.waitForURL((url) => url.origin !== appOrigin, {
      timeout: 15000,
    });

    // Fill email
    await page.fill('input[name="username"], input[type="email"]', email, {
      timeout: 10000,
    });

    // Some IdPs show a "Continue" step before the password
    const continueBtn = page.locator(
      'button:has-text("Continue"), button[name="action"][value="default"]',
    );
    if ((await continueBtn.count()) > 0) {
      await continueBtn.first().click();
      await page.waitForTimeout(500);
    }

    // Fill password
    await page.fill(
      'input[name="password"], input[type="password"]',
      password,
      { timeout: 10000 },
    );

    // Submit
    await page.click('button[type="submit"], button[name="action"]', {
      timeout: 10000,
    });

    // Wait for the redirect back to the app: "back on the app origin" is
    // the IdP-agnostic signal.
    await page.waitForURL((url) => url.origin === appOrigin, {
      timeout: 30000,
    });

    console.log(`  ✓ ${role} authenticated → ${page.url()}`);

    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
    }
    await context.storageState({ path: authFile });
    // The saved session is a secret — Playwright writes it 0644, so restrict it.
    fs.chmodSync(authFile, 0o600);
  } finally {
    await browser.close();
  }
}
