/**
 * Shared test accounts, from the org config.
 *
 * Which accounts a team logs in as, and where their passwords live in the
 * secrets backend, are org data, so the engine reads them from
 * `test_accounts` in the org config instead of hard-wiring any:
 *
 *   test_accounts:
 *     vault: QA                 # secrets vault holding the items (default "test-accounts")
 *     roles:
 *       user:  { email: user@example.com,  item: Web Test User }
 *       beta:  { email: beta@example.com,  item: Web Test Beta }
 *       admin:                  # shared only in these environments; elsewhere
 *         email: admin@example.com     # each engineer runs `make auth-configure`
 *         item: Web Test Admin
 *         environments: [local, dev]
 *
 * A role with no entry (or outside its `environments`) has no shared
 * account; admin and root_admin then fall back to the per-engineer config
 * written by `make auth-configure`.
 */

import { readDenConfig } from "../den-config.js";
import type { SecretRef } from "../secrets/index.js";

export type TestRole = "admin" | "user" | "beta" | "root_admin";

export interface TestAccountConfig {
  /** Login email (or username) of the shared account. */
  email: string;
  /** Secrets-backend item holding the password. */
  item: string;
  /** Field within the item (default "password"). */
  field?: string;
  /** Vault override for this account (default: `test_accounts.vault`). */
  vault?: string;
  /** Environments the account is shared in; omitted = every environment. */
  environments?: string[];
}

export interface TestAccountsConfig {
  /** Default vault for every account (default "test-accounts"). */
  vault?: string;
  roles?: Partial<Record<TestRole, TestAccountConfig>>;
}

/** Vault used when `test_accounts.vault` is not set. */
export const DEFAULT_TEST_ACCOUNTS_VAULT = "test-accounts";

/** The configured `test_accounts` block ({} when absent or unreadable). */
export function readTestAccountsConfig(): TestAccountsConfig {
  try {
    return readDenConfig().test_accounts ?? {};
  } catch {
    return {};
  }
}

/** The vault test-account items live in. */
export function testAccountsVault(
  cfg: TestAccountsConfig = readTestAccountsConfig(),
): string {
  return cfg.vault?.trim() || DEFAULT_TEST_ACCOUNTS_VAULT;
}

/** A shared account resolved for one role and environment. */
export interface SharedTestAccount {
  email: string;
  ref: SecretRef;
}

/**
 * The shared account for `role` in `environment`, or undefined when the
 * org config declares none there (no entry, incomplete entry, or an
 * `environments` list that excludes it).
 */
export function sharedTestAccount(
  role: TestRole,
  environment: string,
  cfg: TestAccountsConfig = readTestAccountsConfig(),
): SharedTestAccount | undefined {
  const account = cfg.roles?.[role];
  if (!account?.email?.trim() || !account.item?.trim()) return undefined;
  if (
    Array.isArray(account.environments) &&
    !account.environments.includes(environment)
  ) {
    return undefined;
  }
  return {
    email: account.email.trim(),
    ref: {
      vault: account.vault?.trim() || testAccountsVault(cfg),
      item: account.item.trim(),
      field: account.field?.trim() || "password",
    },
  };
}
