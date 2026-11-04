/**
 * Unit tests for mintFreshApiToken (src/shared/auth/api-token.ts) — the
 * NON-CACHING JWT mint path used by the journeys runner (review finding 2:
 * the journeys "memory-only" guarantee must not route through the disk
 * cache under playwright/.auth or mutate process.env).
 */

import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mintFreshApiToken } from "../../../src/shared/auth/api-token.js";

const AUTH_DIR = path.resolve(process.cwd(), "playwright/.auth");

function listAuthDir(): string[] {
  return fs.existsSync(AUTH_DIR) ? fs.readdirSync(AUTH_DIR).sort() : [];
}

const CREDS = { email: "user@example.com", password: "pw-sentinel" };

afterEach(() => {
  delete process.env.E2E_AUTH0_CLIENT_SECRET;
  jest.restoreAllMocks();
});

describe("mintFreshApiToken", () => {
  it("returns the minted token without writing any cache file", async () => {
    const before = listAuthDir();
    const mintJwt = jest.fn(async () => ({
      accessToken: "fresh-jwt",
      expiresIn: 3600,
      tokenType: "Bearer",
    }));

    const token = await mintFreshApiToken("user", "local", {
      getCredentials: async () => CREDS,
      mintJwt: mintJwt as never,
    });

    expect(token).toBe("fresh-jwt");
    expect(listAuthDir()).toEqual(before);
  });

  it("never mutates process.env (client secret passed explicitly)", async () => {
    process.env.E2E_AUTH0_CLIENT_SECRET = "env-secret-sentinel";
    const mintJwt = jest.fn(async () => ({
      accessToken: "fresh-jwt",
      expiresIn: 3600,
      tokenType: "Bearer",
    }));
    const envBefore = { ...process.env };

    await mintFreshApiToken("user", "local", {
      getCredentials: async () => CREDS,
      mintJwt: mintJwt as never,
    });

    expect(mintJwt).toHaveBeenCalledWith("local", CREDS.email, CREDS.password, {
      clientSecret: "env-secret-sentinel",
    });
    expect({ ...process.env }).toEqual(envBefore);
  });

  it("fails loudly when no credentials are available", async () => {
    await expect(
      mintFreshApiToken("user", "local", {
        getCredentials: async () => null,
        mintJwt: (async () => ({
          accessToken: "x",
          expiresIn: 1,
          tokenType: "Bearer",
        })) as never,
      }),
    ).rejects.toThrow(/No credentials available/);
  });
});
