/**
 * Custom Playwright Fixtures
 * Provides environment, credentials, and auth helpers to tests
 */

import { test as base, Page } from "@playwright/test";
import { envSelector } from "../../../shared/environment/env-selector.js";
import { getCredentials } from "../../../shared/auth/headless-login.js";
import { Auth0Helper } from "../../../shared/auth/auth0-helper.js";
import path from "path";
import { getDistRoot } from "../../../shared/paths.js";
import type {
  Environment,
  EnvironmentConfig,
} from "../../../shared/types/index.js";

// Extend base test with custom fixtures
type CustomFixtures = {
  environment: Environment;
  envConfig: EnvironmentConfig;
  credentials: {
    username: string;
    password: string;
    auth0ClientId?: string;
  };
  auth0Helper: Auth0Helper;
  authenticatedPage: Page; // Page with JWT auth injected
  adminPage: Page; // Page authenticated as admin (via JWT)
  userPage: Page; // Page authenticated as regular user (via JWT)
  betaPage: Page; // Page authenticated as the beta (restricted-access) user
};

export const test = base.extend<CustomFixtures>({
  // Environment fixture
  // eslint-disable-next-line no-empty-pattern
  environment: async ({}, use) => {
    // Get environment from env variable or default to 'local'
    const env = (process.env.E2E_ENVIRONMENT as Environment) || "local";
    await use(env);
  },

  // Environment config fixture
  envConfig: async ({ environment }, use) => {
    const config = await envSelector.loadEnvironment(environment);
    console.log(`[Fixture] Using environment: ${environment}`);
    console.log(`[Fixture] Web URL: ${config.baseUrls.web}`);
    await use(config);
  },

  // Credentials fixture (optional - for tests that need programmatic auth)
  credentials: async ({ environment }, use) => {
    const creds = await getCredentials("user", environment);
    if (creds) {
      await use({ username: creds.email, password: creds.password });
    } else {
      // No credentials available — tests will use saved auth state
      console.warn(
        "[Fixture] No credentials available - tests will use saved auth state",
      );
      await use({ username: "", password: "" });
    }
  },

  // Auth0 helper fixture
  auth0Helper: async ({ envConfig }, use) => {
    if (!envConfig.auth0) {
      throw new Error(
        `auth0Helper fixture needs an "auth0" block in config/environments/${envConfig.name}.json`,
      );
    }
    const helper = new Auth0Helper({
      domain: envConfig.auth0.domain,
      clientId: envConfig.auth0.clientId,
      audience: envConfig.auth0.audience,
    });
    await use(helper);
  },

  // Authenticated page fixture (DEPRECATED - uses old storageState approach)
  // Note: With saved auth states, the page is already authenticated
  // This fixture just navigates to the app and verifies auth
  authenticatedPage: async ({ page, envConfig }, use) => {
    // Navigate to the app - auth state is already loaded from storageState
    await page.goto(envConfig.baseUrls.web);

    // Give it a moment to load
    await page.waitForTimeout(1000);

    // Page should be authenticated via saved auth state
    // If not, test will fail (which is expected behavior)
    await use(page);
  },

  // Admin page fixture - Uses saved browser session
  // Creates a new context with admin storageState
  // Tests focus on functionality, not auth flow
  adminPage: async ({ browser }, use) => {
    const sessionEnv = process.env.E2E_ENVIRONMENT || "local";
    console.log(`[Auth] Using saved admin session (${sessionEnv})`);

    // Anchored: must read where global-setup.ts (den-root anchored) writes.
    const adminAuthPath = path.resolve(
      getDistRoot(),
      `playwright/.auth/admin-${sessionEnv}.json`,
    );

    // Create context with admin session
    const context = await browser.newContext({
      storageState: adminAuthPath,
    });
    const page = await context.newPage();

    // Auto-accept TOU so it doesn't block tests. TOU-specific tests
    // override this with their own page.route() to test the gate flow.
    await page.route("**/api/tou/status*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true }),
      });
    });

    // Auto-dismiss changelog modal by setting a high version in localStorage
    // before React boots. The changelog hook reads from localStorage first.
    await page.addInitScript(() => {
      try {
        localStorage.setItem(
          "pref:account:user:changelog.lastSeenVersion",
          JSON.stringify({ _default: "0.2.0" }),
        );
      } catch {
        // localStorage may not be available
      }
    });

    // Don't navigate here - let the test navigate to its target directly
    await use(page);
    await context.close();
  },

  // User page fixture - Uses saved browser session
  // Creates a new context with user storageState
  // Tests focus on functionality, not auth flow
  userPage: async ({ browser }, use) => {
    const sessionEnv = process.env.E2E_ENVIRONMENT || "local";
    console.log(`[Auth] Using saved user session (${sessionEnv})`);

    const userAuthPath = path.resolve(
      getDistRoot(),
      `playwright/.auth/user-${sessionEnv}.json`,
    );

    // Create context with user session
    const context = await browser.newContext({
      storageState: userAuthPath,
    });
    const page = await context.newPage();

    // Auto-accept TOU so it doesn't block tests. TOU-specific tests
    // override this with their own page.route() to test the gate flow.
    await page.route("**/api/tou/status*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true }),
      });
    });

    // Auto-dismiss changelog modal
    await page.addInitScript(() => {
      try {
        localStorage.setItem(
          "pref:account:user:changelog.lastSeenVersion",
          JSON.stringify({ _default: "0.2.0" }),
        );
      } catch {
        /* localStorage unavailable (e.g. about:blank before first nav) — harmless */
      }
    });

    // Don't navigate here - let the test navigate to its target directly
    await use(page);
    await context.close();
  },

  // Beta page fixture - Uses the saved browser session for the beta account
  // (a restricted-access role; what it can reach is up to the app)
  betaPage: async ({ browser }, use) => {
    const sessionEnv = process.env.E2E_ENVIRONMENT || "local";
    console.log(`[Auth] Using saved beta session (${sessionEnv})`);

    const betaAuthPath = path.resolve(
      getDistRoot(),
      `playwright/.auth/beta-${sessionEnv}.json`,
    );

    const context = await browser.newContext({
      storageState: betaAuthPath,
    });
    const page = await context.newPage();

    // Auto-accept TOU for beta users too
    await page.route("**/api/tou/status*", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true }),
      });
    });

    // Auto-dismiss changelog modal
    await page.addInitScript(() => {
      try {
        localStorage.setItem(
          "pref:account:user:changelog.lastSeenVersion",
          JSON.stringify({ _default: "0.2.0" }),
        );
      } catch {
        /* localStorage unavailable (e.g. about:blank before first nav) — harmless */
      }
    });

    await use(page);
    await context.close();
  },
});

export { expect } from "@playwright/test";

// Screenshots are captured automatically by playwright.config.ts (screenshot: "on").
// Tests using adminPage/userPage create their own browser contexts — a hook using the
// bare `page` fixture would capture a different, unauthenticated page. No hook needed.
