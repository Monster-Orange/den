/**
 * SEC-2a: the MO "Den" GitHub App, as Den uses it (SEC-2 spec, "The MO Den
 * GitHub App"). Den uses only its public client id, through the device flow,
 * acting as the person: no client secret and no private key, ever. With the
 * app's "Expire user authorization tokens" off, no refresh (which would need
 * the secret) is ever needed, so Den never asks for `offline_access`.
 *
 * `web.github_client_id` (config/den.yml, or config/local/user.yml) replaces
 * the default below; it is the one place the MO app's id lives.
 */

/**
 * The MO "Den" GitHub App's client id (public; it ships in Den). Empty until
 * the app exists: the GitHub buttons then say no client id is configured.
 */
export const MO_DEN_GITHUB_CLIENT_ID = "";

/** Where a person enters the device code. */
export const GITHUB_DEVICE_PAGE = "https://github.com/login/device";

/**
 * Tests only: a fake GitHub on loopback (`http://localhost:<port>`), for the
 * device-flow endpoints and `GET /user` alike. Ignored unless it is plain
 * http on localhost or 127.0.0.1, so it can never point Den at another host.
 */
export const GITHUB_TEST_BASE_ENV = "DEN_TEST_GITHUB_URL";

export interface GithubEndpoints {
  deviceCode: string;
  accessToken: string;
  user: string;
  /** A test's fake GitHub is in use (GITHUB_TEST_BASE_ENV). */
  fake: boolean;
}

/** A loopback http base URL, without a trailing slash, or null. */
function loopbackBase(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:") return null;
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** GitHub's device-flow and user endpoints (or a test's fake GitHub). */
export function githubEndpoints(
  env: NodeJS.ProcessEnv = process.env,
): GithubEndpoints {
  const fake = loopbackBase(env[GITHUB_TEST_BASE_ENV]);
  if (fake)
    return {
      deviceCode: `${fake}/login/device/code`,
      accessToken: `${fake}/login/oauth/access_token`,
      user: `${fake}/user`,
      fake: true,
    };
  return {
    deviceCode: "https://github.com/login/device/code",
    accessToken: "https://github.com/login/oauth/access_token",
    user: "https://api.github.com/user",
    fake: false,
  };
}

/** The client id in use: `web.github_client_id`, else the MO app's. */
export function githubClientId(configured: string | undefined): string {
  return (configured ?? MO_DEN_GITHUB_CLIENT_ID).trim();
}

/** What a GitHub button says while no client id is configured. */
export function noClientIdMessage(cli: string): string {
  return (
    "Sign in with GitHub needs a GitHub App client id, and none is configured. " +
    "Set web.github_client_id in config/local/user.yml (or the distribution's " +
    `config), then restart the server (\`${cli} web restart\`). The app's setup ` +
    "is in docs/distributions.md, “Signing in with GitHub”."
  );
}
