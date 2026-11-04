/**
 * Journeys browser-session provisioning — mints a FRESH Playwright
 * storageState at every run start via the existing den machinery
 * (getCredentials → headlessLogin), exactly mirroring
 * src/pillars/browser/global-setup.ts, which re-mints every run. There is
 * deliberately NO staleness heuristic.
 *
 * Ordering note for the runner (jrn-runner packet): getCredentials reads
 * E2E_* env vars in CI, so this MUST run BEFORE sanitizeEnvironment().
 * The return value is ONLY the auth-file path — credential values never
 * leave this function, and downstream code (browser toolset) consumes the
 * path alone.
 */

import * as fs from "fs";
import * as path from "path";
import { getDistRoot } from "../../../shared/paths.js";
import {
  getCredentials,
  headlessLogin,
} from "../../../shared/auth/headless-login.js";
import { envSelector } from "../../../shared/environment/env-selector.js";
import {
  resolveAuthPath,
  type Role,
} from "../../../shared/environment/playwright-env.js";
import type { Environment } from "../../../shared/types/index.js";
import type { JourneysSessionTokenConfig } from "../app-config.js";

import { product } from "../../../shared/product.js";
/**
 * Mint a fresh authenticated browser session for `role` against `env`'s
 * web surface and return the storageState auth-file path (and nothing
 * else). Throws a loud, actionable error when credentials cannot be
 * sourced — naming both the 1Password path (local) and the E2E_* env-var
 * path (CI), mirroring browser/global-setup.ts.
 */
export async function provisionBrowserSession(
  role: Role,
  env: Environment,
): Promise<string> {
  const envConfig = await envSelector.loadEnvironment(env);
  const webBaseUrl = envConfig.baseUrls.web;
  const authFile = resolveAuthPath(role, env, getDistRoot());

  const credentials = await getCredentials(role, env);
  if (!credentials) {
    const localHint =
      role === "admin"
        ? `  Local: make auth-configure env=${env}  (handles 1Password sign-in automatically)\n`
        : `  Local: sign in to the secrets backend (make ${product().cli}-setup-secrets); the ${role} account comes from test_accounts in the org config\n`;
    throw new Error(
      `No credentials for ${role}.\n` +
        localHint +
        `  CI: set E2E_${role.toUpperCase()}_EMAIL / E2E_${role.toUpperCase()}_PASSWORD`,
    );
  }

  fs.mkdirSync(path.dirname(authFile), { recursive: true });

  try {
    await headlessLogin(
      role,
      webBaseUrl,
      credentials.email,
      credentials.password,
      authFile,
      envConfig.auth?.browser,
    );
  } catch (error) {
    // Re-throw with a credential-free message: headlessLogin failures can
    // carry page/URL context but must never leak email or password values
    // into transcripts or reports.
    const raw = error instanceof Error ? error.message : String(error);
    const scrubbed = raw
      .split(credentials.password)
      .join("[REDACTED]")
      .split(credentials.email)
      .join("[REDACTED]");
    throw new Error(
      `Browser session mint failed for ${role} against ${webBaseUrl}: ${scrubbed}`,
    );
  }

  return authFile;
}

/** Bearer + extra headers for API-assertion probes, from a browser session. */
export interface SessionApiToken {
  /** Bearer token for the app's API. */
  apiToken: string;
  /**
   * Extra headers every API call carries (`session_token.headers`: header
   * name -> response field), e.g. the org or workspace the session resolves
   * to. Not secrets; empty when none are declared.
   */
  headers: Record<string, string>;
}

/** Injectable HTTP layer for {@link deriveApiTokenFromSession} (unit tests). */
export interface DeriveApiTokenDeps {
  /**
   * GET `tokenPath` on the web origin with the saved session cookies. The
   * default drives a short-lived Playwright request context seeded from the
   * storageState auth file, so HttpOnly session cookies are replayed exactly
   * as a browser would.
   */
  fetchAccessToken?: (
    webBaseUrl: string,
    authFilePath: string,
    tokenPath: string,
  ) => Promise<{ status: number; body: unknown }>;
}

/* istanbul ignore next - Playwright request context tested via E2E */
async function defaultFetchAccessToken(
  webBaseUrl: string,
  authFilePath: string,
  tokenPath: string,
): Promise<{ status: number; body: unknown }> {
  const { request } = await import("playwright");
  const context = await request.newContext({
    baseURL: webBaseUrl,
    storageState: authFilePath,
  });
  try {
    const response = await context.get(tokenPath, {
      timeout: 15000,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    return { status: response.status(), body };
  } finally {
    await context.dispose();
  }
}

/**
 * Derive an API Bearer token (and any declared scoping headers) from a
 * minted browser session — no password grant. Calls the app's own
 * session-token route (`journeys.app.session_token.path` in the manifest)
 * on the web origin with the session cookies from `authFilePath`: the token
 * comes from the same real-user session the agent navigates with.
 *
 * Fails loudly (never returns a partial/absent token) so a missing token can
 * never silently degrade a deterministic API assertion into a false pass.
 */
export async function deriveApiTokenFromSession(
  authFilePath: string,
  env: Environment,
  sessionToken: JourneysSessionTokenConfig | undefined,
  deps: DeriveApiTokenDeps = {},
): Promise<SessionApiToken> {
  if (sessionToken === undefined) {
    throw new Error(
      "No journeys.app.session_token in the spec-hosting repo's manifest: " +
        "the journeys pillar needs the app's route that returns an API " +
        "token for a browser session (path, token_field, headers) to run " +
        "deterministic API assertions.",
    );
  }
  const fetchAccessToken = deps.fetchAccessToken ?? defaultFetchAccessToken;
  const envConfig = await envSelector.loadEnvironment(env);
  const webBaseUrl = envConfig.baseUrls.web;
  const tokenPath = sessionToken.path;
  const tokenField = sessionToken.token_field ?? "access_token";

  const { status, body } = await fetchAccessToken(
    webBaseUrl,
    authFilePath,
    tokenPath,
  );

  if (status !== 200) {
    const detail =
      status === 401
        ? "session not authenticated (storageState has no valid session cookie)"
        : status === 403
          ? "session is authenticated but has no API access"
          : `unexpected status ${status}`;
    throw new Error(
      `Failed to derive an API token from the browser session against ` +
        `${webBaseUrl}${tokenPath}: ${detail}. Deterministic API ` +
        `assertions require a real-user token minted from the session.`,
    );
  }

  const parsed =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const field = (name: string): string => {
    const v = parsed[name];
    return typeof v === "string" ? v.trim() : "";
  };

  const apiToken = field(tokenField);
  const headers: Record<string, string> = {};
  const missing: string[] = apiToken.length === 0 ? [tokenField] : [];
  for (const [header, name] of Object.entries(sessionToken.headers ?? {})) {
    const value = field(name);
    if (value.length === 0) missing.push(name);
    else headers[header] = value;
  }

  if (missing.length > 0) {
    throw new Error(
      `The browser session's ${tokenPath} response was missing ` +
        `${missing.join(", ")}. Cannot run deterministic API assertions ` +
        `without a real-user token.`,
    );
  }

  return { apiToken, headers };
}
