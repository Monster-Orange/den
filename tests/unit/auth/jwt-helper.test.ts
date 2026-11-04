/**
 * Tests for JWTHelper
 */

import { describe, it, expect } from "@jest/globals";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { JWTHelper } from "../../../src/shared/auth/jwt-helper.js";

describe("JWTHelper", () => {
  const jwtHelper = new JWTHelper();
  const secret = "test-secret";

  const createToken = (
    payload: Record<string, unknown>,
    expiresIn?: SignOptions["expiresIn"],
  ) => {
    if (expiresIn !== undefined) {
      return jwt.sign(payload, secret, { expiresIn });
    }
    return jwt.sign(payload, secret);
  };

  describe("decode", () => {
    it("should decode valid token", () => {
      const payload = {
        sub: "123",
        email: "test@example.com",
        name: "Test User",
      };
      const token = createToken(payload);

      const decoded = jwtHelper.decode(token);

      expect(decoded.sub).toBe("123");
      expect(decoded.email).toBe("test@example.com");
      expect(decoded.name).toBe("Test User");
    });

    it("should throw error for invalid token", () => {
      expect(() => jwtHelper.decode("invalid.token")).toThrow(
        /Failed to decode JWT/,
      );
    });

    it("should decode token with custom claims", () => {
      const payload = {
        sub: "123",
        customClaim: "value",
        nested: { data: "test" },
      };
      const token = createToken(payload);

      const decoded = jwtHelper.decode(token);

      expect(decoded.customClaim).toBe("value");
      expect((decoded.nested as { data: string }).data).toBe("test");
    });
  });

  describe("isExpired", () => {
    it("should return false for non-expired token", () => {
      const payload = { sub: "123" };
      const token = createToken(payload, "1h");

      expect(jwtHelper.isExpired(token)).toBe(false);
    });

    it("should return true for expired token", () => {
      const payload = { sub: "123", exp: Math.floor(Date.now() / 1000) - 10 }; // Expired 10 seconds ago
      const token = createToken(payload);

      const isExpired = jwtHelper.isExpired(token);
      expect(isExpired).toBe(true);
    });

    it("should return false for token without expiration", () => {
      const payload = { sub: "123" };
      const token = createToken(payload);

      expect(jwtHelper.isExpired(token)).toBe(false);
    });

    it("should return true for invalid token", () => {
      expect(jwtHelper.isExpired("invalid.token")).toBe(true);
    });
  });

  describe("getRemainingTime", () => {
    it("should return remaining time for valid token", () => {
      const payload = { sub: "123" };
      const token = createToken(payload, "1h");

      const remaining = jwtHelper.getRemainingTime(token);

      // Should be approximately 3600 seconds (1 hour)
      expect(remaining).toBeGreaterThan(3590);
      expect(remaining).toBeLessThan(3610);
    });

    it("should return 0 for expired token", () => {
      const payload = { sub: "123" };
      const token = createToken(payload, "0s");

      const remaining = jwtHelper.getRemainingTime(token);
      expect(remaining).toBe(0);
    });

    it("should return Infinity for token without expiration", () => {
      const payload = { sub: "123" };
      const token = createToken(payload);

      const remaining = jwtHelper.getRemainingTime(token);
      expect(remaining).toBe(Infinity);
    });

    it("should return 0 for invalid token", () => {
      expect(jwtHelper.getRemainingTime("invalid.token")).toBe(0);
    });
  });

  describe("extractClaims", () => {
    it("should extract all claims from token", () => {
      const payload = {
        sub: "123",
        email: "test@example.com",
        roles: ["admin", "user"],
        customClaim: "value",
      };
      const token = createToken(payload);

      const claims = jwtHelper.extractClaims(token);

      expect(claims.sub).toBe("123");
      expect(claims.email).toBe("test@example.com");
      expect(claims.roles).toEqual(["admin", "user"]);
      expect(claims.customClaim).toBe("value");
    });
  });

  describe("extractRoles", () => {
    it("should extract roles from standard roles claim", () => {
      const payload = { sub: "123", roles: ["admin", "user"] };
      const token = createToken(payload);

      const roles = jwtHelper.extractRoles(token);
      expect(roles).toEqual(["admin", "user"]);
    });

    it("should extract roles from custom namespace claim", () => {
      const payload = {
        sub: "123",
        "https://example.app/roles": ["admin", "user"],
      };
      const token = createToken(payload);

      const roles = jwtHelper.extractRoles(token);
      expect(roles).toEqual(["admin", "user"]);
    });

    it("should extract single role as string", () => {
      const payload = { sub: "123", role: "admin" };
      const token = createToken(payload);

      const roles = jwtHelper.extractRoles(token);
      expect(roles).toEqual(["admin"]);
    });

    it("should return empty array when no roles present", () => {
      const payload = { sub: "123" };
      const token = createToken(payload);

      const roles = jwtHelper.extractRoles(token);
      expect(roles).toEqual([]);
    });
  });

  describe("extractPermissions", () => {
    it("should extract permissions from permissions claim", () => {
      const payload = {
        sub: "123",
        permissions: ["read:users", "write:users"],
      };
      const token = createToken(payload);

      const permissions = jwtHelper.extractPermissions(token);
      expect(permissions).toEqual(["read:users", "write:users"]);
    });

    it("should extract permissions from custom namespace claim", () => {
      const payload = {
        sub: "123",
        "https://example.app/permissions": ["read:users", "write:users"],
      };
      const token = createToken(payload);

      const permissions = jwtHelper.extractPermissions(token);
      expect(permissions).toEqual(["read:users", "write:users"]);
    });

    it("should extract permissions from scope string", () => {
      const payload = { sub: "123", scope: "read:users write:users" };
      const token = createToken(payload);

      const permissions = jwtHelper.extractPermissions(token);
      expect(permissions).toEqual(["read:users", "write:users"]);
    });

    it("should extract permissions from scope array", () => {
      const payload = { sub: "123", scope: ["read:users", "write:users"] };
      const token = createToken(payload);

      const permissions = jwtHelper.extractPermissions(token);
      expect(permissions).toEqual(["read:users", "write:users"]);
    });

    it("should return empty array when no permissions present", () => {
      const payload = { sub: "123" };
      const token = createToken(payload);

      const permissions = jwtHelper.extractPermissions(token);
      expect(permissions).toEqual([]);
    });
  });

  describe("hasRole", () => {
    it("should return true when token has role", () => {
      const payload = { sub: "123", roles: ["admin", "user"] };
      const token = createToken(payload);

      expect(jwtHelper.hasRole(token, "admin")).toBe(true);
      expect(jwtHelper.hasRole(token, "user")).toBe(true);
    });

    it("should return false when token does not have role", () => {
      const payload = { sub: "123", roles: ["user"] };
      const token = createToken(payload);

      expect(jwtHelper.hasRole(token, "admin")).toBe(false);
    });
  });

  describe("hasPermission", () => {
    it("should return true when token has permission", () => {
      const payload = {
        sub: "123",
        permissions: ["read:users", "write:users"],
      };
      const token = createToken(payload);

      expect(jwtHelper.hasPermission(token, "read:users")).toBe(true);
      expect(jwtHelper.hasPermission(token, "write:users")).toBe(true);
    });

    it("should return false when token does not have permission", () => {
      const payload = { sub: "123", permissions: ["read:users"] };
      const token = createToken(payload);

      expect(jwtHelper.hasPermission(token, "write:users")).toBe(false);
    });
  });

  describe("getExpirationDate", () => {
    it("should return expiration date for token with exp claim", () => {
      const payload = { sub: "123" };
      const token = createToken(payload, "1h");

      const expDate = jwtHelper.getExpirationDate(token);

      expect(expDate).toBeInstanceOf(Date);
      expect(expDate!.getTime()).toBeGreaterThan(Date.now());
    });

    it("should return null for token without exp claim", () => {
      const payload = { sub: "123" };
      const token = createToken(payload);

      const expDate = jwtHelper.getExpirationDate(token);
      expect(expDate).toBeNull();
    });
  });

  describe("getIssueDate", () => {
    it("should return issue date for token with iat claim", () => {
      const payload = { sub: "123" };
      const token = createToken(payload);

      const issueDate = jwtHelper.getIssueDate(token);

      expect(issueDate).toBeInstanceOf(Date);
      expect(issueDate!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("should return null for token without iat claim", () => {
      // JWT library always adds iat, so we need to manually create a token without it
      const payloadWithoutIat = { sub: "123" };
      const token = jwt.sign(payloadWithoutIat, secret, { noTimestamp: true });

      const issueDate = jwtHelper.getIssueDate(token);
      expect(issueDate).toBeNull();
    });
  });
});
