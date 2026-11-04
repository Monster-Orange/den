/**
 * Auth0 Helper
 * Auth0-specific authentication for Next.js frontend testing
 */

import { AuthenticationClient } from "auth0";
import type { Page } from "@playwright/test";
import type { TokenSet } from "../types/index.js";

export interface Auth0Config {
  domain: string;
  clientId: string;
  clientSecret?: string;
  audience?: string;
}

export class Auth0Helper {
  private auth0Client: AuthenticationClient;
  private config: Auth0Config;

  constructor(config: Auth0Config) {
    this.config = config;
    this.auth0Client = new AuthenticationClient({
      domain: config.domain,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
  }

  /**
   * Login with username and password (Resource Owner Password Grant)
   * For API testing and automated flows
   */
  async loginWithPassword(
    username: string,
    password: string,
  ): Promise<TokenSet> {
    try {
      const result = await this.auth0Client.oauth.passwordGrant({
        username,
        password,
        realm: "Username-Password-Authentication",
        scope: "openid profile email",
        audience: this.config.audience,
      });

      const data = result.data as unknown as Record<string, unknown>;
      return {
        access_token: data.access_token as string,
        refresh_token: data.refresh_token as string | undefined,
        id_token: data.id_token as string | undefined,
        expires_in: data.expires_in as number | undefined,
        token_type: data.token_type as string | undefined,
        scope: data.scope as string | undefined,
      };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(`Auth0 password login failed: ${msg}`);
    }
  }

  /**
   * Complete Auth0 Universal Login flow in browser (for Playwright tests)
   * Handles the Auth0 login page specifically
   * @istanbul ignore next - Browser automation tested via E2E tests
   */
  async completeAuth0LoginInBrowser(
    page: Page,
    username: string,
    password: string,
    options: {
      waitForUrl?: string | RegExp;
      timeout?: number;
    } = {},
  ): Promise<void> {
    const { waitForUrl = /.*\/dashboard.*/, timeout = 15000 } = options;

    try {
      // Wait for Auth0 Universal Login page to load
      // Auth0 typically shows email/username first
      await page.waitForSelector(
        'input[name="username"], input[type="email"]',
        {
          timeout,
        },
      );

      // Fill in email/username
      const usernameInput = page
        .locator('input[name="username"], input[type="email"]')
        .first();
      await usernameInput.fill(username);

      // Auth0 Universal Login may have a continue button before password
      const continueButton = page
        .locator('button[type="submit"], button[name="action"]')
        .first();
      if (
        await continueButton.isVisible({ timeout: 1000 }).catch(() => false)
      ) {
        await continueButton.click();

        // Wait for password field to appear
        await page.waitForSelector(
          'input[name="password"], input[type="password"]',
          {
            timeout: 5000,
          },
        );
      }

      // Fill in password
      const passwordInput = page
        .locator('input[name="password"], input[type="password"]')
        .first();
      await passwordInput.fill(password);

      // Submit the form
      const submitButton = page
        .locator('button[type="submit"], button[name="action"]')
        .first();
      await submitButton.click();

      // Wait for redirect back to application
      await page.waitForURL(waitForUrl, { timeout });
    } catch (error) {
      // Take screenshot for debugging
      const screenshot = await page
        .screenshot({ fullPage: true })
        .catch(() => null);
      if (screenshot) {
        console.error("Login failed, screenshot saved");
      }

      throw new Error(
        `Auth0 browser login failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(refreshToken: string): Promise<TokenSet> {
    try {
      const result = await this.auth0Client.oauth.refreshTokenGrant({
        refresh_token: refreshToken,
      });

      const data = result.data as unknown as Record<string, unknown>;
      return {
        access_token: data.access_token as string,
        refresh_token: data.refresh_token as string | undefined,
        id_token: data.id_token as string | undefined,
        expires_in: data.expires_in as number | undefined,
        token_type: data.token_type as string | undefined,
        scope: data.scope as string | undefined,
      };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(`Auth0 token refresh failed: ${msg}`);
    }
  }

  /**
   * Get user info from Auth0
   * Note: Uses the /userinfo endpoint directly
   */
  async getUserInfo(accessToken: string): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(`https://${this.config.domain}/userinfo`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get user info: ${response.status}`);
      }

      return (await response.json()) as Record<string, unknown>;
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(`Failed to get user info: ${msg}`);
    }
  }

  /**
   * Client credentials grant (for machine-to-machine authentication)
   */
  async clientCredentialsGrant(audience?: string): Promise<TokenSet> {
    if (!this.config.clientSecret) {
      throw new Error("Client secret is required for client credentials grant");
    }

    try {
      const result = await this.auth0Client.oauth.clientCredentialsGrant({
        audience:
          audience ||
          this.config.audience ||
          `https://${this.config.domain}/api/v2/`,
      });

      const data = result.data as unknown as Record<string, unknown>;
      return {
        access_token: data.access_token as string,
        expires_in: data.expires_in as number | undefined,
        token_type: data.token_type as string | undefined,
        scope: data.scope as string | undefined,
      };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(`Auth0 client credentials grant failed: ${msg}`);
    }
  }

  /**
   * Wait for Auth0 session in browser
   * Useful for checking if user is already logged in
   */
  async waitForAuth0Session(page: Page): Promise<boolean> {
    try {
      // Check for Auth0 session cookie or localStorage
      const hasSession = await page.evaluate(() => {
        // @ts-expect-error - window is available in browser context
        // Check localStorage for Auth0 session (Next.js with @auth0/nextjs-auth0)
        const auth0Keys = Object.keys(window.localStorage).filter(
          (key: string) =>
            key.includes("auth0") || key.includes("@@auth0spajs@@"),
        );

        if (auth0Keys.length > 0) {
          return true;
        }

        // @ts-expect-error - window is available in browser context
        // Check for session cookie
        const cookies = window.document.cookie.split(";");
        return cookies.some((cookie: string) =>
          cookie.trim().startsWith("appSession="),
        );
      });

      return hasSession;
    } catch {
      return false;
    }
  }

  /**
   * Clear Auth0 session from browser
   * Useful for test cleanup
   */
  async clearAuth0Session(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        // @ts-expect-error - window is available in browser context
        // Clear localStorage
        const auth0Keys = Object.keys(window.localStorage).filter(
          (key: string) =>
            key.includes("auth0") || key.includes("@@auth0spajs@@"),
        );
        // @ts-expect-error - window is available in browser context
        auth0Keys.forEach((key: string) => window.localStorage.removeItem(key));

        // @ts-expect-error - window is available in browser context
        // Clear cookies
        window.document.cookie.split(";").forEach((cookie: string) => {
          const [name] = cookie.split("=");
          // @ts-expect-error - window is available in browser context
          window.document.cookie = `${name.trim()}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
        });
      });
    } catch (error) {
      console.warn(
        `Failed to clear Auth0 session: ${(error as Error).message}`,
      );
    }
  }
}
