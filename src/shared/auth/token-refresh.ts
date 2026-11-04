/**
 * Token Refresh Utility
 * Check a saved browser session before running tests, and refresh it by
 * letting the app's own auth SDK renew it when it has gone stale.
 *
 * "Signed in" means: opening `signedInPath` (environment config
 * `auth.browser.signedInPath`, default "/") ends on the app origin under
 * that path, rather than at the IdP or a login page.
 */

import * as fs from "fs/promises";
import { chromium } from "@playwright/test";
import type { BrowserLoginConfig } from "../types/index.js";

interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    // Playwright's storageState cookie type requires the literal union.
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{
      name: string;
      value: string;
    }>;
  }>;
}

/**
 * Check if auth tokens are expired and refresh if needed
 */
export async function refreshAuthIfNeeded(
  authFilePath: string,
  baseUrl: string,
  login: BrowserLoginConfig = {},
): Promise<boolean> {
  const signedInPath = normalisePath(login.signedInPath ?? "/");
  try {
    // Check if auth file exists
    const fileExists = await fs
      .access(authFilePath)
      .then(() => true)
      .catch(() => false);
    if (!fileExists) {
      console.log(`⚠️  No auth session found at: ${authFilePath}`);
      return false;
    }

    // Read storage state
    const storageStateContent = await fs.readFile(authFilePath, "utf-8");
    const storageState: StorageState = JSON.parse(storageStateContent);

    // Check if tokens are still valid
    const isValid = await checkTokenValidity(
      storageState,
      baseUrl,
      signedInPath,
    );

    if (isValid) {
      console.log("✓ Auth session is still valid");
      return true;
    }

    console.log("⚠️  Auth session expired, attempting to refresh...");

    // Try to refresh using the saved session
    const refreshed = await attemptRefresh(
      authFilePath,
      baseUrl,
      storageState,
      signedInPath,
    );

    if (refreshed) {
      console.log("✓ Auth session refreshed successfully");
      return true;
    } else {
      console.log(
        "❌ Could not refresh auth session - manual re-authentication required",
      );
      return false;
    }
  } catch (error) {
    console.warn(`Token refresh check failed: ${(error as Error).message}`);
    return false;
  }
}

function normalisePath(p: string): string {
  return p.startsWith("/") ? p : `/${p}`;
}

/** True when `href` is on the app origin under `signedInPath`. */
export function isSignedInUrl(
  href: string,
  baseUrl: string,
  signedInPath: string,
): boolean {
  try {
    const url = new URL(href);
    if (url.origin !== new URL(baseUrl).origin) return false;
    const prefix = signedInPath.replace(/\/+$/, "");
    return (
      prefix === "" ||
      url.pathname === prefix ||
      url.pathname.startsWith(`${prefix}/`)
    );
  } catch {
    return false;
  }
}

/** Wait (briefly) for any IdP redirect to land back on the app origin. */
async function settleOnApp(
  page: { waitForURL(fn: (url: URL) => boolean, o: object): Promise<void> },
  baseUrl: string,
): Promise<void> {
  const appOrigin = new URL(baseUrl).origin;
  try {
    await page.waitForURL((url) => url.origin === appOrigin, {
      timeout: 5000,
    });
  } catch {
    // Timeout is OK - the check below decides
  }
}

/**
 * Check if the current session is still valid
 */
async function checkTokenValidity(
  storageState: StorageState,
  baseUrl: string,
  signedInPath: string,
): Promise<boolean> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // Launch headless browser with saved state
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    // Try to navigate to a protected route
    await page.goto(baseUrl.replace(/\/$/, "") + signedInPath, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });
    await settleOnApp(page, baseUrl);

    // Still on the protected route (not redirected to a login) = signed in
    return isSignedInUrl(page.url(), baseUrl, signedInPath);
  } catch (error) {
    const errorMsg = (error as Error).message;
    // If the app isn't running, we can't validate - assume tokens might be valid
    if (
      errorMsg.includes("ERR_NAME_NOT_RESOLVED") ||
      errorMsg.includes("ERR_CONNECTION_REFUSED")
    ) {
      console.log("  ℹ️  Cannot reach app - skipping validation");
      return true; // Assume valid, let tests fail naturally if they're not
    }
    console.warn(`  Token validity check failed: ${errorMsg}`);
    return false;
  } finally {
    // Close on every path — a thrown goto previously leaked the Chromium process.
    await browser?.close();
  }
}

/**
 * Attempt to refresh the session
 */
async function attemptRefresh(
  authFilePath: string,
  baseUrl: string,
  oldStorageState: StorageState,
  signedInPath: string,
): Promise<boolean> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // Refresh tokens usually live in HTTP-only cookies we can't touch
    // directly. The best approach is to:
    // 1. Load the page with the old session
    // 2. Let the app's auth SDK handle the refresh automatically
    // 3. Save the new session

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: oldStorageState });
    const page = await context.newPage();

    // Navigate to the app - its auth SDK might auto-refresh
    await page.goto(baseUrl, {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    await settleOnApp(page, baseUrl);

    // Try to access a protected route
    await page.goto(baseUrl.replace(/\/$/, "") + signedInPath, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await settleOnApp(page, baseUrl);

    // Check if we made it to the protected route
    const isAuthenticated = isSignedInUrl(page.url(), baseUrl, signedInPath);

    if (isAuthenticated) {
      // Save the refreshed session
      await context.storageState({ path: authFilePath });
      return true;
    }

    return false;
  } catch (error) {
    const errorMsg = (error as Error).message;
    // If the app isn't running, we can't refresh - but this is OK
    if (
      errorMsg.includes("ERR_NAME_NOT_RESOLVED") ||
      errorMsg.includes("ERR_CONNECTION_REFUSED")
    ) {
      console.log("  ℹ️  Cannot reach app - skipping refresh");
      return true; // Assume OK, let tests handle the connection error
    }
    console.warn(`  Token refresh attempt failed: ${errorMsg}`);
    return false;
  } finally {
    // Close on every path — a thrown goto previously leaked the Chromium process.
    await browser?.close();
  }
}

/**
 * Get token expiry time in seconds (for manual token inspection)
 */
function getTokenExpiry(token: string): number | null {
  try {
    // JWT tokens are base64 encoded
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    // Decode payload
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
    return payload.exp || null;
  } catch {
    return null;
  }
}

/**
 * Check if token is expired
 */
export function isTokenExpired(token: string): boolean {
  const expiry = getTokenExpiry(token);
  if (!expiry) {
    return true; // Assume expired if we can't parse
  }

  const now = Math.floor(Date.now() / 1000);
  const bufferSeconds = 300; // 5 minute buffer

  return now >= expiry - bufferSeconds;
}
