/**
 * Token Injection Helper
 * Inject JWT tokens directly into browser storage to bypass Auth0 OAuth flow
 * This allows fast, headless testing without waiting for redirects
 */

import type { Page, BrowserContext } from "@playwright/test";
import type { TokenSet } from "../types/index.js";
import type { Auth0Helper } from "./auth0-helper.js";

/**
 * Inject Auth0 tokens into browser localStorage
 * This simulates a logged-in session without going through the OAuth flow
 *
 * @param page - Playwright page object
 * @param tokens - JWT tokens from Auth0 password grant
 * @param baseUrl - Base URL of the app (needed for localStorage scope)
 */
export async function injectAuth0Tokens(
  page: Page,
  tokens: TokenSet,
  baseUrl: string,
): Promise<void> {
  // First, navigate to the base URL so localStorage is scoped correctly
  await page.goto(baseUrl);

  // Inject tokens into localStorage in the format Auth0 SPA SDK expects
  await page.evaluate(
    ({ accessToken, idToken, refreshToken, expiresIn }) => {
      // Auth0 SPA SDK storage format
      const auth0Key = `@@auth0spajs@@::${window.location.origin}`;

      const expiresAt = Date.now() + (expiresIn || 3600) * 1000;

      const auth0Data = {
        body: {
          access_token: accessToken,
          id_token: idToken,
          refresh_token: refreshToken,
          expires_in: expiresIn || 3600,
          token_type: "Bearer",
          scope: "openid profile email",
        },
        expiresAt,
      };

      // Store in localStorage
      localStorage.setItem(auth0Key, JSON.stringify(auth0Data));

      // Also store id_token separately (some apps check this)
      localStorage.setItem("id_token", idToken || "");
      localStorage.setItem("access_token", accessToken);

      console.log("✓ Auth0 tokens injected into localStorage");
    },
    {
      accessToken: tokens.access_token,
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
    },
  );
}

/**
 * Inject Auth0 session via API callback (for Next.js with @auth0/nextjs-auth0)
 * This approach calls the Next.js auth callback endpoint to establish a session
 *
 * @param context - Playwright browser context
 * @param tokens - JWT tokens from Auth0 password grant
 * @param baseUrl - Base URL of the app
 */
export async function injectAuth0Session(
  context: BrowserContext,
  tokens: TokenSet,
  baseUrl: string,
): Promise<void> {
  // Create a new page for API call
  const page = await context.newPage();

  try {
    // Call the Next.js auth callback endpoint with the code
    // This establishes the session and sets HTTP-only cookies
    const response = await page.request.post(`${baseUrl}/api/auth/callback`, {
      data: {
        code: tokens.access_token, // Some implementations use the access token
        state: "test-state",
      },
      failOnStatusCode: false,
    });

    if (response.ok()) {
      console.log("✓ Auth0 session established via API callback");
    } else {
      console.warn(
        `⚠️  Auth callback returned status ${response.status()}, falling back to localStorage`,
      );
      // Fallback to localStorage injection
      await injectAuth0Tokens(page, tokens, baseUrl);
    }
  } catch (error) {
    console.warn(
      `⚠️  Auth callback failed: ${(error as Error).message}, falling back to localStorage`,
    );
    // Fallback to localStorage injection
    await injectAuth0Tokens(page, tokens, baseUrl);
  } finally {
    await page.close();
  }
}

/**
 * Setup authenticated browser context with JWT tokens
 * This is the main entry point for tests - gets tokens and injects them
 *
 * @param page - Playwright page object
 * @param username - User email
 * @param password - User password
 * @param auth0Helper - Auth0 helper instance
 * @param baseUrl - Base URL of the app
 */
export async function setupAuthenticatedPage(
  page: Page,
  username: string,
  password: string,
  auth0Helper: Auth0Helper,
  baseUrl: string,
): Promise<TokenSet> {
  // Get JWT tokens programmatically (no browser flow)
  console.log(`🔐 Getting JWT tokens for ${username}...`);
  const tokens = await auth0Helper.loginWithPassword(username, password);
  console.log("✓ JWT tokens received");

  // Inject tokens into browser
  await injectAuth0Tokens(page, tokens, baseUrl);

  return tokens;
}

/**
 * Check if page has valid auth tokens in storage
 */
export async function hasValidAuthTokens(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    // Check for Auth0 SPA SDK storage
    const auth0Keys = Object.keys(localStorage).filter((key) =>
      key.includes("@@auth0spajs@@"),
    );

    if (auth0Keys.length === 0) {
      return false;
    }

    // Check if tokens are expired
    try {
      const auth0Data = JSON.parse(localStorage.getItem(auth0Keys[0]) || "{}");
      const expiresAt = auth0Data.expiresAt || 0;
      const now = Date.now();

      return now < expiresAt;
    } catch {
      return false;
    }
  });
}

/**
 * Clear all auth tokens from browser storage
 */
export async function clearAuthTokens(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Clear Auth0 SPA SDK storage
    const auth0Keys = Object.keys(localStorage).filter(
      (key) => key.includes("auth0") || key.includes("@@auth0spajs@@"),
    );
    auth0Keys.forEach((key) => localStorage.removeItem(key));

    // Clear other auth-related items
    localStorage.removeItem("id_token");
    localStorage.removeItem("access_token");

    console.log("✓ Auth tokens cleared from localStorage");
  });
}
