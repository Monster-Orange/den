/**
 * API JWT Token Manager
 *
 * Mints access tokens for direct API calls through the environment's token
 * provider (auth0 password grant, cognito, local-jwt — see
 * ./token-providers). Tokens are cached to disk and reused until 5 minutes
 * before expiry.
 *
 * Prerequisites when the provider is auth0 (one-time Auth0 Dashboard setup):
 *   1. Applications → [App] → Settings → Advanced Settings → Grant Types
 *      → enable "Password"
 *   2. Auth0 Dashboard → Settings → API Authorization Settings
 *      → Default Directory = "Username-Password-Authentication"
 *
 * Credential sources (same priority as headless browser login):
 *   1. ENV vars:  E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD  (CI only)
 *   2. Secrets backend (Doppler / 1Password / env — src/shared/secrets),
 *      at the accounts named by `test_accounts` in the org config
 *
 * Note: social-login (e.g. Google) accounts cannot be used — the password
 * grant requires email+password.
 *
 * Cache location: playwright/.auth/api-token-{role}-{env}.json  (gitignored)
 */

import * as fs from "fs";
import * as path from "path";
import { getCredentials } from "./headless-login.js";
import { mintAccessToken } from "./token-providers/index.js";
import type { Environment } from "../types/index.js";
import { getDistRoot } from "../paths.js";
import { envSelector } from "../environment/env-selector.js";

import { product } from "../product.js";
// Anchored to the den root, NOT process.cwd(): token caches are WRITTEN
// here, and `den test ...` can be invoked from any directory (bin/den
// never cds; spawned playwright children inherit the user's cwd).
const AUTH_DIR = path.resolve(getDistRoot(), "playwright/.auth");
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry

// Per-environment Auth0 client secrets (gitignored).
// Keys are environment names; values are client_secret strings.
// Created by: echo '{"staging":"<secret>"}' > config/local/auth0-client-secrets.json
const AUTH0_SECRETS_FILE = path.resolve(
  getDistRoot(),
  "config/local/auth0-client-secrets.json",
);

function loadAuth0ClientSecret(environment: string): string | undefined {
  try {
    if (!fs.existsSync(AUTH0_SECRETS_FILE)) return undefined;
    const secrets = JSON.parse(
      fs.readFileSync(AUTH0_SECRETS_FILE, "utf-8"),
    ) as Record<string, string>;
    return secrets[environment] ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse a .env / .env.local file and return key→value pairs.
 * Handles quoted values, inline comments, and blank/comment lines.
 */
function parseDotEnv(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const result: Record<string, string> = {};
    for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed
        .slice(eqIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, ""); // strip surrounding quotes
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

interface CachedToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number; // epoch ms
  role: string;
  email: string;
}

function cachePath(
  role: "admin" | "user" | "beta" | "root_admin",
  environment: string,
): string {
  return path.join(AUTH_DIR, `api-token-${role}-${environment}.json`);
}

function loadCache(filePath: string): CachedToken | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CachedToken;
    if (Date.now() >= data.expiresAt - EXPIRY_BUFFER_MS) return null; // expired / near-expiry
    return data;
  } catch {
    return null;
  }
}

function saveCache(filePath: string, token: CachedToken): void {
  // Cached JWTs are secrets — keep the dir and file owner-only (0700/0600).
  if (!fs.existsSync(AUTH_DIR))
    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(token, null, 2), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600); // mode arg is ignored if the file already exists
}

/**
 * The dotenv file named by the environment config's
 * `auth0.clientSecretEnvFile` (relative to the den root, e.g. an app
 * checkout's `.env.local`), or undefined when none is configured.
 */
async function clientSecretEnvFile(
  environment: Environment,
): Promise<string | undefined> {
  try {
    const cfg = await envSelector.loadEnvironment(environment);
    const file = cfg.auth0?.clientSecretEnvFile?.trim();
    return file ? path.resolve(getDistRoot(), file) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Auth0 client secret from the file-based local-dev fallbacks
 * (config/local/auth0-client-secrets.json keyed by environment, else
 * AUTH0_CLIENT_SECRET in the configured `auth0.clientSecretEnvFile`), with
 * a label naming where it came from. Pure read — never mutates process.env.
 */
async function resolveFileClientSecret(
  environment: Environment,
): Promise<{ secret: string; source: string } | undefined> {
  const fromJson = loadAuth0ClientSecret(environment);
  if (fromJson) {
    return {
      secret: fromJson,
      source: `config/local/auth0-client-secrets.json (${environment})`,
    };
  }
  const envFile = await clientSecretEnvFile(environment);
  const fromEnvFile = envFile
    ? parseDotEnv(envFile)["AUTH0_CLIENT_SECRET"]
    : undefined;
  return fromEnvFile && envFile
    ? { secret: fromEnvFile, source: envFile }
    : undefined;
}

/**
 * Wrap `mintAuth0JWT` with operator-friendly error hints for the well-known
 * Auth0 misconfigurations hit when first enabling the password grant.
 * Keeps the elaborate setup guidance attached to the shared test-user flow,
 * while the loadtest per-user flow uses the bare `mintAuth0JWT` (its operators
 * are already familiar with the setup).
 */
async function fetchRopcToken(
  environment: Environment,
  email: string,
  password: string,
  options: { clientSecret?: string } = {},
): Promise<{ access_token: string; token_type: string; expires_in: number }> {
  try {
    const minted = await mintAccessToken(environment, email, password, options);
    return {
      access_token: minted.accessToken,
      token_type: minted.tokenType,
      expires_in: minted.expiresIn,
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const isGrantError =
      msg.includes("grant type") ||
      msg.includes("Password grant") ||
      msg.includes("unauthorized_client");

    if (isGrantError) {
      throw new Error(
        `Auth0 ROPC not enabled: ${msg}\n\n` +
          `  To enable the Password grant:\n` +
          `    1. Auth0 Dashboard → Applications → [your app]\n` +
          `    2. Settings → Advanced Settings → Grant Types → check "Password"\n` +
          `    3. Auth0 Dashboard → Settings → API Authorization Settings\n` +
          `       → Default Directory = "Username-Password-Authentication"\n` +
          `    4. Save and retry.\n`,
      );
    }

    const isDefaultDirectoryMissing =
      msg.includes("access_denied") && msg.includes("Unauthorized");

    if (isDefaultDirectoryMissing) {
      throw new Error(
        `Auth0 ROPC failed: Password grant is enabled but "Default Directory" is not set.\n\n` +
          `  Fix (one-time Auth0 Dashboard change):\n` +
          `    Auth0 Dashboard → Settings → API Authorization Settings\n` +
          `    → Default Directory = "Username-Password-Authentication"\n` +
          `    → Save Changes\n\n` +
          `  Note: This is separate from the Grant Types setting on the Application.`,
      );
    }

    const isCredentialError =
      msg.includes("invalid_grant") ||
      msg.includes("Wrong email") ||
      msg.includes("Wrong password") ||
      msg.includes("user not found");

    if (isCredentialError) {
      throw new Error(
        `Auth0 login failed for "${email}": ${msg}\n` +
          `  Check the test-account secret in your secrets backend (make ${product().cli}-setup-secrets)`,
      );
    }

    throw err;
  }
}

/**
 * Get a JWT access token for the given role, suitable for
 * Authorization: Bearer <token> headers when calling the app's API directly.
 *
 * Checks disk cache first. Fetches a fresh token via ROPC only when the
 * cache is missing or within 5 minutes of expiry.
 *
 * @throws if credentials are unavailable or Auth0 ROPC fails
 */
export async function getApiToken(
  role: "admin" | "user" | "beta" | "root_admin",
  environment: Environment,
): Promise<string> {
  const cache = cachePath(role, environment);

  // Return cached token if still valid
  const cached = loadCache(cache);
  if (cached) {
    const minsLeft = Math.round((cached.expiresAt - Date.now()) / 60000);
    console.log(
      `  ✓ Using cached API token for ${role} (${minsLeft}m remaining)`,
    );
    return cached.accessToken;
  }

  console.log(`  Fetching API token for ${role}...`);

  // Load credentials (ENV vars or credentials file)
  const creds = await getCredentials(role, environment);
  if (!creds) {
    const hint =
      role === "admin" || role === "root_admin"
        ? `    • Local ${role}: set test_accounts.roles.${role} in the org config, or run make auth-configure for a personal account\n`
        : `    • Local ${role}: set test_accounts.roles.${role} in the org config and store its password in your secrets backend\n`;
    throw new Error(
      `No credentials available for ${role} API token.\n` +
        `  Options:\n` +
        `    • CI: set E2E_${role.toUpperCase()}_EMAIL / E2E_${role.toUpperCase()}_PASSWORD\n` +
        `    • Local: ensure the secrets backend is signed in (make ${product().cli}-setup-secrets)\n` +
        hint +
        `  Note: social-login accounts cannot be used for a password grant — email+password only.`,
    );
  }

  // Client secret priority (surfaced via E2E_AUTH0_CLIENT_SECRET env var):
  //   1. E2E_AUTH0_CLIENT_SECRET env var (CI) — passed through unchanged
  //   2. config/local/auth0-client-secrets.json keyed by environment (gitignored)
  //   3. AUTH0_CLIENT_SECRET in the environment's auth0.clientSecretEnvFile
  //
  // mintAuth0JWT reads E2E_AUTH0_CLIENT_SECRET, so we set it here from the
  // file-based fallbacks if not already in the env.
  if (!process.env.E2E_AUTH0_CLIENT_SECRET) {
    const fromFile = await resolveFileClientSecret(environment);
    if (fromFile) {
      console.log(`  Using client_secret from ${fromFile.source}`);
      process.env.E2E_AUTH0_CLIENT_SECRET = fromFile.secret;
    }
  } else {
    console.log(`  Using client_secret from E2E_AUTH0_CLIENT_SECRET`);
  }

  const data = await fetchRopcToken(environment, creds.email, creds.password);

  const expiresAt = Date.now() + data.expires_in * 1000;
  const token: CachedToken = {
    accessToken: data.access_token,
    tokenType: data.token_type,
    expiresAt,
    role,
    email: creds.email,
  };

  saveCache(cache, token);

  const minsValid = Math.round(data.expires_in / 60);
  console.log(
    `  ✓ API token fetched for ${role} (${creds.email}), valid for ${minsValid}m`,
  );

  return data.access_token;
}

/** Injectable collaborators for {@link mintFreshApiToken} (unit tests). */
export interface MintFreshApiTokenDeps {
  getCredentials?: typeof getCredentials;
  mintJwt?: typeof mintAccessToken;
}

/**
 * Mint a fresh JWT for the given role, MEMORY-ONLY: unlike
 * {@link getApiToken}, this path never reads or writes the disk cache
 * under playwright/.auth and never mutates process.env — the Auth0 client
 * secret (env var first, else the file-based local-dev fallbacks) is
 * passed explicitly into the mint. Built for the journeys runner, whose
 * captured secrets must not outlive the run in any persistent store.
 *
 * @throws if credentials are unavailable or Auth0 ROPC fails
 */
export async function mintFreshApiToken(
  role: "admin" | "user" | "beta" | "root_admin",
  environment: Environment,
  deps: MintFreshApiTokenDeps = {},
): Promise<string> {
  const resolveCredentials = deps.getCredentials ?? getCredentials;
  const creds = await resolveCredentials(role, environment);
  if (!creds) {
    throw new Error(
      `No credentials available for ${role} API token.\n` +
        `  Options:\n` +
        `    • CI: set E2E_${role.toUpperCase()}_EMAIL / E2E_${role.toUpperCase()}_PASSWORD\n` +
        `    • Local: ensure the secrets backend is signed in (make ${product().cli}-setup-secrets)\n` +
        `  Note: social-login accounts cannot be used for a password grant — email+password only.`,
    );
  }

  const clientSecret =
    process.env.E2E_AUTH0_CLIENT_SECRET ??
    (await resolveFileClientSecret(environment))?.secret;

  if (deps.mintJwt) {
    const minted = await deps.mintJwt(
      environment,
      creds.email,
      creds.password,
      {
        ...(clientSecret !== undefined ? { clientSecret } : {}),
      },
    );
    return minted.accessToken;
  }
  const data = await fetchRopcToken(
    environment,
    creds.email,
    creds.password,
    clientSecret !== undefined ? { clientSecret } : {},
  );
  return data.access_token;
}

/**
 * Delete the cached API token for a role/environment, forcing a fresh
 * ROPC fetch on the next call to getApiToken().
 */
export function clearApiTokenCache(
  role: "admin" | "user" | "beta" | "root_admin",
  environment: Environment,
): void {
  const file = cachePath(role, environment);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log(`  ✓ API token cache cleared: ${role}/${environment}`);
  } else {
    console.log(`  (no cached token for ${role}/${environment})`);
  }
}

/**
 * Return status info about the cached token for a role/environment.
 * Used by make int-jwt-status.
 */
export function getApiTokenCacheStatus(
  role: "admin" | "user" | "beta" | "root_admin",
  environment: string,
): {
  found: boolean;
  email?: string;
  expiresAt?: number;
  minsRemaining?: number;
} {
  const file = cachePath(role, environment as Environment);
  try {
    if (!fs.existsSync(file)) return { found: false };
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as CachedToken;
    const minsRemaining = Math.round((data.expiresAt - Date.now()) / 60000);
    return {
      found: true,
      email: data.email,
      expiresAt: data.expiresAt,
      minsRemaining,
    };
  } catch {
    return { found: false };
  }
}
