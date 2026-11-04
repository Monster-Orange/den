/**
 * Auth0 Resource Owner Password grant — the `auth0` token provider's mint.
 *
 * Reads the Auth0 domain, clientId and audience from the environment's
 * `auth0` block in config/environments/<env>.json. No caching here — callers
 * decide whether to persist the token.
 */

import { envSelector } from "../../environment/env-selector.js";
import type { Environment } from "../../types/index.js";

interface RopcResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

/** Mint a fresh Auth0 access token via Resource Owner Password Credentials. */
export async function mintAuth0JWT(
  env: Environment,
  username: string,
  password: string,
  options: { clientSecret?: string } = {},
): Promise<{ accessToken: string; expiresIn: number; tokenType: string }> {
  const envConfig = await envSelector.loadEnvironment(env);
  if (!envConfig.auth0) {
    throw new Error(
      `auth0 block is not set in config/environments/${env}.json`,
    );
  }
  const { domain, clientId, audience } = envConfig.auth0;

  if (!audience) {
    throw new Error(
      `auth0.audience is not set in config/environments/${env}.json`,
    );
  }

  const body: Record<string, string> = {
    grant_type: "password",
    username,
    password,
    audience,
    scope: "openid profile email",
    client_id: clientId,
    realm: process.env.E2E_AUTH0_REALM ?? "Username-Password-Authentication",
  };

  // client_secret is optional for public SPA clients; required for
  // confidential ones. Callers may pass it explicitly (memory-only paths
  // that must not mutate process.env); the env var remains the default.
  const clientSecret =
    options.clientSecret ?? process.env.E2E_AUTH0_CLIENT_SECRET;
  if (clientSecret) body.client_secret = clientSecret;

  const response = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const data = (await response.json()) as RopcResponse;

  if (!response.ok || data.error) {
    const desc =
      data.error_description ?? data.error ?? `HTTP ${response.status}`;
    throw new Error(
      `Auth0 ROPC failed for "${username}" (${env}): ${data.error ?? response.status} — ${desc}`,
    );
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
  };
}
