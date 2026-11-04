/**
 * Unit tests for src/shared/auth/test-accounts.ts — shared test accounts
 * resolved from `test_accounts` in the org config.
 */

import { describe, it, expect } from "@jest/globals";
import {
  DEFAULT_TEST_ACCOUNTS_VAULT,
  sharedTestAccount,
  testAccountsVault,
} from "../../../src/shared/auth/test-accounts.js";

describe("testAccountsVault", () => {
  it("defaults to a neutral vault name", () => {
    expect(testAccountsVault({})).toBe(DEFAULT_TEST_ACCOUNTS_VAULT);
    expect(testAccountsVault({ vault: "  " })).toBe(
      DEFAULT_TEST_ACCOUNTS_VAULT,
    );
  });

  it("uses the configured vault", () => {
    expect(testAccountsVault({ vault: "QA" })).toBe("QA");
  });
});

describe("sharedTestAccount", () => {
  const cfg = {
    vault: "QA",
    roles: {
      user: { email: " user@example.com ", item: "Web Test User" },
      admin: {
        email: "admin@example.com",
        item: "Web Test Admin",
        vault: "Admins",
        field: "secret",
        environments: ["local"],
      },
      beta: { email: "beta@example.com", item: "" },
    },
  };

  it("resolves an account with the default vault and field", () => {
    expect(sharedTestAccount("user", "staging", cfg)).toEqual({
      email: "user@example.com",
      ref: { vault: "QA", item: "Web Test User", field: "password" },
    });
  });

  it("honours per-account vault/field and the environments list", () => {
    expect(sharedTestAccount("admin", "local", cfg)).toEqual({
      email: "admin@example.com",
      ref: { vault: "Admins", item: "Web Test Admin", field: "secret" },
    });
    expect(sharedTestAccount("admin", "production", cfg)).toBeUndefined();
  });

  it("is undefined for missing or incomplete roles", () => {
    expect(sharedTestAccount("root_admin", "local", cfg)).toBeUndefined();
    expect(sharedTestAccount("beta", "local", cfg)).toBeUndefined();
    expect(sharedTestAccount("user", "local", {})).toBeUndefined();
  });
});
