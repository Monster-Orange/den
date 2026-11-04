/**
 * JWT Helper
 * Handles JWT token operations
 */

import jwt from "jsonwebtoken";

export interface JWTPayload {
  sub?: string;
  email?: string;
  name?: string;
  roles?: string[];
  permissions?: string[];
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

export class JWTHelper {
  /**
   * Decode JWT token without verification
   */
  decode(token: string): JWTPayload {
    try {
      const decoded = jwt.decode(token);
      if (!decoded || typeof decoded === "string") {
        throw new Error("Invalid token format");
      }
      return decoded as JWTPayload;
    } catch (error) {
      throw new Error(`Failed to decode JWT: ${(error as Error).message}`);
    }
  }

  /**
   * Check if token is expired
   */
  isExpired(token: string): boolean {
    try {
      const decoded = this.decode(token);

      if (!decoded.exp) {
        // If no expiration, consider it as never expires
        return false;
      }

      const now = Math.floor(Date.now() / 1000);
      return decoded.exp < now;
    } catch {
      // If we can't decode, consider it expired
      return true;
    }
  }

  /**
   * Get remaining time in seconds
   */
  getRemainingTime(token: string): number {
    try {
      const decoded = this.decode(token);

      if (!decoded.exp) {
        return Infinity;
      }

      const now = Math.floor(Date.now() / 1000);
      const remaining = decoded.exp - now;

      return remaining > 0 ? remaining : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Extract claims from token
   */
  extractClaims(token: string): Record<string, unknown> {
    return this.decode(token);
  }

  /**
   * Extract roles from token
   */
  extractRoles(token: string): string[] {
    const decoded = this.decode(token);

    // Try common role claim names
    if (decoded.roles && Array.isArray(decoded.roles)) {
      return decoded.roles;
    }

    if (
      decoded["https://example.app/roles"] &&
      Array.isArray(decoded["https://example.app/roles"])
    ) {
      return decoded["https://example.app/roles"] as string[];
    }

    if (decoded.role && Array.isArray(decoded.role)) {
      return decoded.role as string[];
    }

    if (typeof decoded.role === "string") {
      return [decoded.role];
    }

    return [];
  }

  /**
   * Extract permissions from token
   */
  extractPermissions(token: string): string[] {
    const decoded = this.decode(token);

    // Try common permission claim names
    if (decoded.permissions && Array.isArray(decoded.permissions)) {
      return decoded.permissions;
    }

    if (
      decoded["https://example.app/permissions"] &&
      Array.isArray(decoded["https://example.app/permissions"])
    ) {
      return decoded["https://example.app/permissions"] as string[];
    }

    if (decoded.scope) {
      // Handle space-separated scopes (common in OAuth)
      if (typeof decoded.scope === "string") {
        return decoded.scope.split(" ");
      }
      if (Array.isArray(decoded.scope)) {
        return decoded.scope as string[];
      }
    }

    return [];
  }

  /**
   * Check if token has specific role
   */
  hasRole(token: string, role: string): boolean {
    const roles = this.extractRoles(token);
    return roles.includes(role);
  }

  /**
   * Check if token has specific permission
   */
  hasPermission(token: string, permission: string): boolean {
    const permissions = this.extractPermissions(token);
    return permissions.includes(permission);
  }

  /**
   * Get token expiration date
   */
  getExpirationDate(token: string): Date | null {
    const decoded = this.decode(token);

    if (!decoded.exp) {
      return null;
    }

    return new Date(decoded.exp * 1000);
  }

  /**
   * Get token issue date
   */
  getIssueDate(token: string): Date | null {
    const decoded = this.decode(token);

    if (!decoded.iat) {
      return null;
    }

    return new Date(decoded.iat * 1000);
  }
}

// Export singleton instance
export const jwtHelper = new JWTHelper();
