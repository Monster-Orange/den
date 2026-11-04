/**
 * Unit tests for journey browser-session provisioning
 * (src/pillars/journeys/tools/browser-session.ts).
 *
 * Contract under test (plan: jrn-browser-tool packet):
 * - provisionBrowserSession(role, env) mints a FRESH storageState at every
 *   invocation via getCredentials → headlessLogin — no staleness heuristic,
 *   mirroring src/pillars/browser/global-setup.ts which re-mints every run.
 * - headlessLogin is pointed at envConfig.baseUrls.web only.
 * - The auth-file path comes from resolveAuthPath's convention
 *   (playwright/.auth/<role>-<env>.json).
 * - The function returns ONLY the auth-file path — credential values never
 *   appear in the return value or in thrown errors.
 * - Missing credentials fail loudly with an actionable message.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

jest.mock("../../../src/shared/auth/headless-login.js", () => ({
  getCredentials: jest.fn(),
  headlessLogin: jest.fn(),
}));

jest.mock("../../../src/shared/environment/env-selector.js", () => ({
  envSelector: {
    loadEnvironment: jest.fn(),
  },
}));

import {
  getCredentials,
  headlessLogin,
} from "../../../src/shared/auth/headless-login.js";
import { envSelector } from "../../../src/shared/environment/env-selector.js";
import { TEST_APP } from "./fixtures/test-app.js";
import { resolveAuthPath } from "../../../src/shared/environment/playwright-env.js";
import {
  provisionBrowserSession,
  deriveApiTokenFromSession,
} from "../../../src/pillars/journeys/tools/browser-session.js";

const mockedGetCredentials = getCredentials as jest.Mock;
const mockedHeadlessLogin = headlessLogin as jest.Mock;
const mockedLoadEnvironment = envSelector.loadEnvironment as jest.Mock;

const WEB_BASE = "http://localhost:3000";
const EMAIL = "test-user@example.com";
const PASSWORD = "sentinel-password-never-leaks";

function envConfig() {
  return {
    name: "local",
    baseUrls: {
      web: WEB_BASE,
      api: "http://localhost:8000",
      services: { folders: "http://localhost:8084" },
    },
  };
}

describe("provisionBrowserSession", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedLoadEnvironment.mockResolvedValue(envConfig() as never);
    mockedGetCredentials.mockResolvedValue({
      email: EMAIL,
      password: PASSWORD,
    } as never);
    mockedHeadlessLogin.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("mints a fresh storageState via getCredentials → headlessLogin", async () => {
    await provisionBrowserSession("user", "local");

    expect(mockedGetCredentials).toHaveBeenCalledWith("user", "local");
    expect(mockedHeadlessLogin).toHaveBeenCalledTimes(1);
    const [role, baseUrl, email, password, authFile] =
      mockedHeadlessLogin.mock.calls[0];
    expect(role).toBe("user");
    expect(baseUrl).toBe(WEB_BASE);
    expect(email).toBe(EMAIL);
    expect(password).toBe(PASSWORD);
    expect(authFile).toBe(resolveAuthPath("user", "local", process.cwd()));
  });

  it("re-mints on EVERY invocation — no staleness heuristic", async () => {
    await provisionBrowserSession("admin", "local");
    await provisionBrowserSession("admin", "local");

    // A staleness heuristic would skip the second login; fresh-per-run
    // provisioning must not.
    expect(mockedGetCredentials).toHaveBeenCalledTimes(2);
    expect(mockedHeadlessLogin).toHaveBeenCalledTimes(2);
  });

  it("points the login at envConfig.baseUrls.web only", async () => {
    await provisionBrowserSession("beta", "local");

    const [, baseUrl] = mockedHeadlessLogin.mock.calls[0];
    expect(baseUrl).toBe(WEB_BASE);
    expect(baseUrl).not.toContain("8000");
    expect(baseUrl).not.toContain("8084");
  });

  it("returns ONLY the auth-file path — no credential values", async () => {
    const result = await provisionBrowserSession("user", "local");

    expect(typeof result).toBe("string");
    expect(result).toBe(resolveAuthPath("user", "local", process.cwd()));
    expect(result).not.toContain(EMAIL);
    expect(result).not.toContain(PASSWORD);
  });

  it("fails loudly and actionably when no credentials resolve", async () => {
    mockedGetCredentials.mockResolvedValue(null as never);

    await expect(provisionBrowserSession("user", "local")).rejects.toThrow(
      /No credentials for user/,
    );
    // The error must name both sourcing paths (the secrets backend locally, env vars
    // in CI) so the failure is actionable.
    await expect(provisionBrowserSession("user", "local")).rejects.toThrow(
      /E2E_USER_EMAIL/,
    );
    expect(mockedHeadlessLogin).not.toHaveBeenCalled();
  });

  it("never leaks the password through thrown errors", async () => {
    mockedHeadlessLogin.mockRejectedValue(
      new Error("login step failed") as never,
    );

    await expect(provisionBrowserSession("user", "local")).rejects.not.toThrow(
      new RegExp(PASSWORD),
    );
    try {
      await provisionBrowserSession("user", "local");
    } catch (error) {
      expect(String(error)).not.toContain(PASSWORD);
      expect(String(error)).not.toContain(EMAIL);
    }
  });
});

// ── deriveApiTokenFromSession (password-grant-free API token) ────────────────

describe("deriveApiTokenFromSession", () => {
  const AUTH_FILE = "/tmp/playwright/.auth/user-local.json";
  const SESSION_TOKEN = TEST_APP.session_token;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedLoadEnvironment.mockResolvedValue(envConfig() as never);
  });

  it("calls the app's configured session-token route against the web base URL", async () => {
    const fetchAccessToken = jest.fn(async () => ({
      status: 200,
      body: {
        access_token: "session-derived-jwt",
        org_id: "org-123",
        expires_at: 9_999_999_999,
      },
    }));

    const result = await deriveApiTokenFromSession(
      AUTH_FILE,
      "local",
      SESSION_TOKEN,
      { fetchAccessToken: fetchAccessToken as never },
    );

    expect(fetchAccessToken).toHaveBeenCalledWith(
      WEB_BASE,
      AUTH_FILE,
      "/api/auth/token",
    );
    expect(result).toEqual({
      apiToken: "session-derived-jwt",
      headers: { "X-Org-ID": "org-123" },
    });
  });

  it("reads a custom token field and declares no headers when none are configured", async () => {
    const result = await deriveApiTokenFromSession(
      AUTH_FILE,
      "local",
      { path: "/session/token", token_field: "jwt" },
      {
        fetchAccessToken: (async () => ({
          status: 200,
          body: { jwt: "custom-jwt" },
        })) as never,
      },
    );

    expect(result).toEqual({ apiToken: "custom-jwt", headers: {} });
  });

  it("fails loudly when the manifest declares no session_token", async () => {
    await expect(
      deriveApiTokenFromSession(AUTH_FILE, "local", undefined, {
        fetchAccessToken: (async () => ({ status: 200, body: {} })) as never,
      }),
    ).rejects.toThrow(/journeys\.app\.session_token/);
  });

  it("fails loudly on 401 (no valid session cookie) — never returns an empty token", async () => {
    await expect(
      deriveApiTokenFromSession(AUTH_FILE, "local", SESSION_TOKEN, {
        fetchAccessToken: (async () => ({ status: 401, body: {} })) as never,
      }),
    ).rejects.toThrow(/session not authenticated/);
  });

  it("fails loudly on 403 (authenticated, no API access)", async () => {
    await expect(
      deriveApiTokenFromSession(AUTH_FILE, "local", SESSION_TOKEN, {
        fetchAccessToken: (async () => ({ status: 403, body: {} })) as never,
      }),
    ).rejects.toThrow(/no API access/);
  });

  it("fails loudly when the response is missing the token or a declared header field", async () => {
    await expect(
      deriveApiTokenFromSession(AUTH_FILE, "local", SESSION_TOKEN, {
        fetchAccessToken: (async () => ({
          status: 200,
          body: { access_token: "jwt" },
        })) as never,
      }),
    ).rejects.toThrow(/missing org_id/);

    await expect(
      deriveApiTokenFromSession(AUTH_FILE, "local", SESSION_TOKEN, {
        fetchAccessToken: (async () => ({
          status: 200,
          body: { org_id: "org-1" },
        })) as never,
      }),
    ).rejects.toThrow(/missing access_token/);
  });
});
