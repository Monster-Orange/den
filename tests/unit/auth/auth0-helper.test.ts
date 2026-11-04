/**
 * Tests for Auth0Helper
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Auth0Helper } from "../../../src/shared/auth/auth0-helper.js";

// Mock Auth0 AuthenticationClient
jest.mock("auth0", () => ({
  AuthenticationClient: jest.fn().mockImplementation(() => ({
    oauth: {
      passwordGrant: jest.fn(),
      refreshTokenGrant: jest.fn(),
      clientCredentialsGrant: jest.fn(),
    },
    users: {
      getInfo: jest.fn(),
    },
  })),
}));

// jest.Mock<Promise<unknown>> ensures mockResolvedValue/mockRejectedValue
// accept any value (avoids 'never' inference from the default T=unknown)
type MockFn = jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

interface MockOAuthClient {
  passwordGrant: MockFn;
  refreshTokenGrant: MockFn;
  clientCredentialsGrant: MockFn;
}

interface MockAuth0ClientType {
  oauth: MockOAuthClient;
  users: { getInfo: MockFn };
}

describe("Auth0Helper", () => {
  let auth0Helper: Auth0Helper;
  let mockAuth0Client: MockAuth0ClientType;

  const config = {
    domain: "example-test.us.auth0.com",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    audience: "https://api-test.example.app",
  };

  beforeEach(() => {
    auth0Helper = new Auth0Helper(config);
    // Get the mocked client instance
    mockAuth0Client = (
      auth0Helper as unknown as { auth0Client: MockAuth0ClientType }
    ).auth0Client;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("loginWithPassword", () => {
    it("should login with valid credentials", async () => {
      const mockResponse = {
        data: {
          access_token: "access_token_123",
          refresh_token: "refresh_token_123",
          id_token: "id_token_123",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid profile email",
        },
      };

      mockAuth0Client.oauth.passwordGrant.mockResolvedValue(mockResponse);

      const result = await auth0Helper.loginWithPassword(
        "user@example.com",
        "password123",
      );

      expect(result.access_token).toBe("access_token_123");
      expect(result.refresh_token).toBe("refresh_token_123");
      expect(result.id_token).toBe("id_token_123");
      expect(result.expires_in).toBe(3600);

      expect(mockAuth0Client.oauth.passwordGrant).toHaveBeenCalledWith({
        username: "user@example.com",
        password: "password123",
        realm: "Username-Password-Authentication",
        scope: "openid profile email",
        audience: config.audience,
      });
    });

    it("should throw error on authentication failure", async () => {
      mockAuth0Client.oauth.passwordGrant.mockRejectedValue({
        message: "Invalid credentials",
      });

      await expect(
        auth0Helper.loginWithPassword("user@example.com", "wrong-password"),
      ).rejects.toThrow(/Auth0 password login failed/);
    });
  });

  describe("refreshToken", () => {
    it("should refresh token with valid refresh token", async () => {
      const mockResponse = {
        data: {
          access_token: "new_access_token",
          refresh_token: "new_refresh_token",
          id_token: "new_id_token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid profile email",
        },
      };

      mockAuth0Client.oauth.refreshTokenGrant.mockResolvedValue(mockResponse);

      const result = await auth0Helper.refreshToken("old_refresh_token");

      expect(result.access_token).toBe("new_access_token");
      expect(result.refresh_token).toBe("new_refresh_token");

      expect(mockAuth0Client.oauth.refreshTokenGrant).toHaveBeenCalledWith({
        refresh_token: "old_refresh_token",
      });
    });

    it("should throw error on refresh failure", async () => {
      mockAuth0Client.oauth.refreshTokenGrant.mockRejectedValue({
        message: "Invalid refresh token",
      });

      await expect(auth0Helper.refreshToken("invalid_token")).rejects.toThrow(
        /Auth0 token refresh failed/,
      );
    });
  });

  describe("getUserInfo", () => {
    beforeEach(() => {
      // Mock fetch for getUserInfo
      global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    });

    afterEach(() => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockRestore();
    });

    it("should get user info with valid access token", async () => {
      const mockUserInfo = {
        sub: "auth0|123",
        email: "user@example.com",
        name: "Test User",
        picture: "https://example.com/avatar.jpg",
      };

      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue({
        ok: true,
        json: async () => mockUserInfo,
      } as Response);

      const result = await auth0Helper.getUserInfo("access_token_123");

      expect(result.email).toBe("user@example.com");
      expect(result.name).toBe("Test User");

      expect(global.fetch).toHaveBeenCalledWith(
        `https://${config.domain}/userinfo`,
        expect.objectContaining({
          headers: { Authorization: "Bearer access_token_123" },
        }),
      );
    });

    it("should throw error on failure", async () => {
      (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      await expect(auth0Helper.getUserInfo("invalid_token")).rejects.toThrow(
        /Failed to get user info/,
      );
    });
  });

  describe("clientCredentialsGrant", () => {
    it("should authenticate with client credentials", async () => {
      const mockResponse = {
        data: {
          access_token: "access_token_123",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "api:read api:write",
        },
      };

      mockAuth0Client.oauth.clientCredentialsGrant.mockResolvedValue(
        mockResponse,
      );

      const result = await auth0Helper.clientCredentialsGrant();

      expect(result.access_token).toBe("access_token_123");
      expect(result.expires_in).toBe(3600);

      expect(mockAuth0Client.oauth.clientCredentialsGrant).toHaveBeenCalledWith(
        {
          audience: config.audience,
        },
      );
    });

    it("should use custom audience if provided", async () => {
      const mockResponse = {
        data: {
          access_token: "access_token_123",
          expires_in: 3600,
          token_type: "Bearer",
        },
      };

      mockAuth0Client.oauth.clientCredentialsGrant.mockResolvedValue(
        mockResponse,
      );

      await auth0Helper.clientCredentialsGrant(
        "https://custom-api.example.app",
      );

      expect(mockAuth0Client.oauth.clientCredentialsGrant).toHaveBeenCalledWith(
        {
          audience: "https://custom-api.example.app",
        },
      );
    });

    it("should throw error when client secret is missing", async () => {
      const helperWithoutSecret = new Auth0Helper({
        ...config,
        clientSecret: undefined,
      });

      await expect(
        helperWithoutSecret.clientCredentialsGrant(),
      ).rejects.toThrow(/Client secret is required/);
    });

    it("should throw error on authentication failure", async () => {
      mockAuth0Client.oauth.clientCredentialsGrant.mockRejectedValue({
        message: "Invalid client credentials",
      });

      await expect(auth0Helper.clientCredentialsGrant()).rejects.toThrow(
        /Auth0 client credentials grant failed/,
      );
    });
  });

  describe("configuration", () => {
    it("should accept minimal configuration", () => {
      const minimalHelper = new Auth0Helper({
        domain: "example.us.auth0.com",
        clientId: "client-id",
      });

      expect(minimalHelper).toBeInstanceOf(Auth0Helper);
    });

    it("should accept full configuration", () => {
      const fullHelper = new Auth0Helper({
        domain: "example.us.auth0.com",
        clientId: "client-id",
        clientSecret: "client-secret",
        audience: "https://api.example.app",
      });

      expect(fullHelper).toBeInstanceOf(Auth0Helper);
    });
  });
});
