/**
 * Unit tests for token-refresh.ts
 *
 * isTokenExpired() is a pure exported function — tested directly.
 *
 * refreshAuthIfNeeded() orchestrates file I/O + a headless browser check.
 * fs/promises and @playwright/test are mocked so no browser ever launches.
 *
 * Key behaviours guarded:
 *  - isTokenExpired: expiry maths, 5-min buffer, invalid JWT format
 *  - refreshAuthIfNeeded: file-not-found, valid session, connection-refused
 *    graceful degradation, bad JSON, failed refresh path
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// ─── Mocks (must precede the imports they replace) ───────────────────────────

jest.mock("fs/promises", () => ({
  access: jest.fn(),
  readFile: jest.fn(),
}));

jest.mock("@playwright/test", () => ({
  chromium: { launch: jest.fn() },
}));

import * as fsPromises from "fs/promises";
import { chromium } from "@playwright/test";
import {
  isSignedInUrl,
  isTokenExpired,
  refreshAuthIfNeeded,
} from "../../../src/shared/auth/token-refresh.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockAccess = fsPromises.access as jest.Mock;
const mockReadFile = fsPromises.readFile as jest.Mock;
const mockLaunch = chromium.launch as jest.Mock;

/** Build a JWT with the given exp claim (Unix seconds). */
function makeJwt(exp: number): string {
  const header = Buffer.from('{"alg":"HS256"}').toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

/** Unix seconds, offset from now. */
const nowSecs = () => Math.floor(Date.now() / 1000);

const MOCK_STORAGE_STATE = JSON.stringify({ cookies: [], origins: [] });

/**
 * Build a mock chromium browser chain.
 * @param pageUrl  URL that page.url() returns after navigation
 * @param gotoErr  If set, page.goto() throws this error
 */
function makeMockBrowser(pageUrl: string, gotoErr?: Error) {
  const mockPage = {
    goto: jest.fn(async () => {
      if (gotoErr) throw gotoErr;
    }),
    url: jest.fn(() => pageUrl),
    waitForURL: jest.fn(async () => {}),
  };
  const mockContext = {
    newPage: jest.fn(async () => mockPage),
    storageState: jest.fn(async () => {}),
  };
  const mockBrowser = {
    newContext: jest.fn(async () => mockContext),
    close: jest.fn(async () => {}),
  };
  return { mockPage, mockContext, mockBrowser };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── isTokenExpired ───────────────────────────────────────────────────────────

describe("isTokenExpired", () => {
  it("returns false for a token that expires well in the future", () => {
    const exp = nowSecs() + 3600; // 1 hour from now
    expect(isTokenExpired(makeJwt(exp))).toBe(false);
  });

  it("returns true for a token that has already expired", () => {
    const exp = nowSecs() - 60; // 1 minute ago
    expect(isTokenExpired(makeJwt(exp))).toBe(true);
  });

  it("returns true when within the 5-minute buffer window", () => {
    const exp = nowSecs() + 240; // 4 minutes from now (inside 5-min buffer)
    expect(isTokenExpired(makeJwt(exp))).toBe(true);
  });

  it("returns false when just outside the 5-minute buffer window", () => {
    const exp = nowSecs() + 360; // 6 minutes from now (outside buffer)
    expect(isTokenExpired(makeJwt(exp))).toBe(false);
  });

  it("returns true for a non-JWT string (not 3 parts)", () => {
    expect(isTokenExpired("notajwt")).toBe(true);
    expect(isTokenExpired("a.b")).toBe(true);
  });

  it("returns true for a JWT with undecodable payload", () => {
    expect(isTokenExpired("header.!!!.sig")).toBe(true);
  });

  it("returns true for a JWT with no exp field in payload", () => {
    const header = Buffer.from("{}").toString("base64url");
    const payload = Buffer.from('{"sub":"user"}').toString("base64url");
    expect(isTokenExpired(`${header}.${payload}.sig`)).toBe(true);
  });
});

// ─── refreshAuthIfNeeded ─────────────────────────────────────────────────────

describe("refreshAuthIfNeeded", () => {
  it("returns false when the auth file does not exist", async () => {
    mockAccess.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const result = await refreshAuthIfNeeded(
      "/playwright/.auth/admin.json",
      "http://localhost:3000",
    );
    expect(result).toBe(false);
  });

  it("returns true when the existing session is valid (lands back on the app)", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(MOCK_STORAGE_STATE);
    const { mockBrowser } = makeMockBrowser("http://localhost:3000/home");
    mockLaunch.mockResolvedValue(mockBrowser);

    const result = await refreshAuthIfNeeded(
      "/playwright/.auth/admin.json",
      "http://localhost:3000",
    );
    expect(result).toBe(true);
  });

  it("returns true when session is invalid but refresh succeeds", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(MOCK_STORAGE_STATE);

    // First launch: checkTokenValidity — ends at the IdP (invalid)
    const { mockBrowser: invalidBrowser } = makeMockBrowser(
      "https://login.example.com/authorize",
    );
    // Second launch: attemptRefresh — back on the app (success)
    const { mockBrowser: refreshedBrowser } = makeMockBrowser(
      "http://localhost:3000/home",
    );

    mockLaunch
      .mockResolvedValueOnce(invalidBrowser)
      .mockResolvedValueOnce(refreshedBrowser);

    const result = await refreshAuthIfNeeded(
      "/playwright/.auth/admin.json",
      "http://localhost:3000",
    );
    expect(result).toBe(true);
  });

  it("returns false when session is invalid and refresh also fails", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(MOCK_STORAGE_STATE);

    // Both launches end at the IdP
    const { mockBrowser: invalidBrowser1 } = makeMockBrowser(
      "https://login.example.com/authorize",
    );
    const { mockBrowser: invalidBrowser2 } = makeMockBrowser(
      "https://login.example.com/authorize",
    );
    mockLaunch
      .mockResolvedValueOnce(invalidBrowser1)
      .mockResolvedValueOnce(invalidBrowser2);

    const result = await refreshAuthIfNeeded(
      "/playwright/.auth/admin.json",
      "http://localhost:3000",
    );
    expect(result).toBe(false);
  });

  it("returns true when app is unreachable (ERR_CONNECTION_REFUSED) — graceful degradation", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(MOCK_STORAGE_STATE);

    const connRefused = Object.assign(
      new Error("net::ERR_CONNECTION_REFUSED"),
      {
        code: "ERR_CONNECTION_REFUSED",
      },
    );
    const { mockBrowser } = makeMockBrowser("", connRefused);
    mockLaunch.mockResolvedValue(mockBrowser);

    const result = await refreshAuthIfNeeded(
      "/playwright/.auth/admin.json",
      "http://localhost:3000",
    );
    // Cannot reach app → assume valid so tests can fail naturally
    expect(result).toBe(true);
  });

  it("returns false when the auth file contains invalid JSON", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("not valid json {{{");
    // The function logs console.warn on parse failure — suppress it in tests
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await refreshAuthIfNeeded(
      "/playwright/.auth/admin.json",
      "http://localhost:3000",
    );
    warnSpy.mockRestore();
    expect(result).toBe(false);
  });

  it("navigates to the configured signedInPath and requires landing under it", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(MOCK_STORAGE_STATE);
    const { mockBrowser, mockPage } = makeMockBrowser(
      "http://localhost:3000/dashboard/overview",
    );
    mockLaunch.mockResolvedValue(mockBrowser);

    const result = await refreshAuthIfNeeded(
      "/playwright/.auth/admin.json",
      "http://localhost:3000",
      { signedInPath: "/dashboard" },
    );

    expect(result).toBe(true);
    expect(mockPage.goto).toHaveBeenCalledWith(
      "http://localhost:3000/dashboard",
      expect.anything(),
    );
  });
});

// ─── isSignedInUrl ───────────────────────────────────────────────────────────

describe("isSignedInUrl", () => {
  const base = "http://localhost:3000";

  it("accepts any app-origin page when signedInPath is /", () => {
    expect(isSignedInUrl("http://localhost:3000/anything", base, "/")).toBe(
      true,
    );
  });

  it("rejects another origin (the IdP)", () => {
    expect(
      isSignedInUrl("https://login.example.com/authorize", base, "/"),
    ).toBe(false);
  });

  it("is segment-aware for a signedInPath", () => {
    expect(isSignedInUrl(`${base}/app`, base, "/app")).toBe(true);
    expect(isSignedInUrl(`${base}/app/x`, base, "/app/")).toBe(true);
    expect(isSignedInUrl(`${base}/apple`, base, "/app")).toBe(false);
    expect(isSignedInUrl(`${base}/login`, base, "/app")).toBe(false);
  });

  it("rejects an unparseable href", () => {
    expect(isSignedInUrl("", base, "/")).toBe(false);
  });
});
