/**
 * Custom Playwright Fixtures for Integration (API) Tests
 *
 * Auth model: Authorization: Bearer <jwt>
 * Tokens are minted by the environment's token provider (auth0, cognito,
 * local-jwt) and cached to disk. See shared/auth/api-token.ts for details.
 *
 * Prerequisites:
 *   - Credentials available: the secrets backend (test_accounts in the org
 *     config) or CI ENV vars
 *   - For auth0: the "Password" grant type enabled for the app
 *   - Social-login accounts cannot be used for API token tests
 */

import { test as base, request } from "@playwright/test";
import { envSelector } from "../../../shared/environment/env-selector.js";
import { getApiToken } from "../../../shared/auth/api-token.js";
import { openApiValidator } from "./openapi-validator.js";
import type {
  Environment,
  EnvironmentConfig,
} from "../../../shared/types/index.js";
import type { APIRequestContext } from "@playwright/test";

type CustomFixtures = {
  environment: Environment;
  envConfig: EnvironmentConfig;
  /** Unauthenticated API context — for testing public endpoints or 401 behavior */
  apiContext: APIRequestContext;
  /** Admin JWT bearer token */
  adminToken: string;
  /** User JWT bearer token */
  userToken: string;
  /** Authenticated API context using admin token (Bearer) */
  adminContext: APIRequestContext;
  /** Authenticated API context using user token (Bearer) */
  userContext: APIRequestContext;
  /** Alias for adminContext — backward compatibility */
  authenticatedContext: APIRequestContext;
  /** Alias for adminToken — backward compatibility */
  accessToken: string;
  validator: typeof openApiValidator;
};

export const test = base.extend<CustomFixtures>({
  // eslint-disable-next-line no-empty-pattern
  environment: async ({}, use) => {
    const env = (process.env.E2E_ENVIRONMENT as Environment) || "local";
    await use(env);
  },

  envConfig: async ({ environment }, use) => {
    const config = await envSelector.loadEnvironment(environment);
    await use(config);
  },

  // ── JWT token fixtures ────────────────────────────────────────────────────

  adminToken: async ({ environment }, use) => {
    const token = await getApiToken("admin", environment);
    await use(token);
  },

  userToken: async ({ environment }, use) => {
    const token = await getApiToken("user", environment);
    await use(token);
  },

  // Backward-compat alias
  accessToken: async ({ adminToken }, use) => {
    await use(adminToken);
  },

  // ── Request context fixtures ──────────────────────────────────────────────

  /** Unauthenticated — use for testing 401 responses or public endpoints */
  apiContext: async ({ envConfig }, use) => {
    const context = await request.newContext({
      baseURL: envConfig.baseUrls.api,
      extraHTTPHeaders: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    await use(context);
    await context.dispose();
  },

  /** Admin-authenticated API context — use for admin-only endpoints */
  adminContext: async ({ envConfig, adminToken }, use) => {
    const context = await request.newContext({
      baseURL: envConfig.baseUrls.api,
      extraHTTPHeaders: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
    });
    await use(context);
    await context.dispose();
  },

  /** User-authenticated API context — use for user-scoped endpoints */
  userContext: async ({ envConfig, userToken }, use) => {
    const context = await request.newContext({
      baseURL: envConfig.baseUrls.api,
      extraHTTPHeaders: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
    });
    await use(context);
    await context.dispose();
  },

  // Backward-compat alias
  authenticatedContext: async ({ adminContext }, use) => {
    await use(adminContext);
  },

  // eslint-disable-next-line no-empty-pattern
  validator: async ({}, use) => {
    await use(openApiValidator);
  },
});

export { expect } from "@playwright/test";
