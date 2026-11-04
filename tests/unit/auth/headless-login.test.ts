process.env.DEN_SECRETS_PROVIDER = "1password";
/**
 * Unit tests for getCredentials() in headless-login.ts
 *
 * headlessLogin() requires a real browser (Playwright chromium) and is
 * covered by E2E tests. Only getCredentials() is unit-tested here.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

// ─── Mock fs ──────────────────────────────────────────────────────────────────
// ESM built-in module exports are non-configurable, so jest.spyOn fails.
// jest.mock("fs") replaces them with configurable jest.fn() instances.
jest.mock("fs");

import * as fs from "fs";

// ─── Mock child_process ───────────────────────────────────────────────────────
// promisify(execFile) checks for util.promisify.custom on the function.
// Without it, promisify resolves with only the first callback arg (a string),
// and `const { stdout } = await execFileAsync(...)` would give undefined.
// Setting the custom symbol makes promisify return { stdout, stderr }.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecFileAsync = jest.fn() as jest.MockedFunction<() => Promise<any>>;

jest.mock("child_process", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { promisify } = require("util");
  const execFile = jest.fn();
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] =
    mockExecFileAsync;
  return { execFile };
});

// Mock @playwright/test so headless-login.ts can be imported in Node (no browser)
jest.mock("@playwright/test", () => ({
  chromium: { launch: jest.fn() },
}));

// The shared accounts come from `test_accounts` in the org config.
const TEST_ACCOUNTS = {
  vault: "QA Vault",
  roles: {
    user: { email: "test-user@example.com", item: "Web Test User" },
    beta: { email: "test-beta@example.com", item: "Web Test Beta" },
    admin: {
      email: "test-admin@example.com",
      item: "Web Test Admin",
      environments: ["local", "dev", "staging"],
    },
    root_admin: {
      email: "test-root-admin@example.com",
      item: "Web Test Root Admin",
      field: "secret",
      environments: ["local", "dev", "staging"],
    },
  },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockReadDenConfig = jest.fn<() => any>();
jest.mock("../../../src/shared/den-config.js", () => ({
  readDenConfig: () => mockReadDenConfig(),
}));

// Import after mocks are registered
import { getCredentials } from "../../../src/shared/auth/headless-login.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockExistsSync = fs.existsSync as jest.Mock;
const mockReadFileSync = fs.readFileSync as jest.Mock;

function mockAdminConfig(
  overrides: Partial<{
    email: string;
    opRef: string;
    itemId: string;
    vaultId: string;
    fieldLabel: string;
  }> = {},
) {
  const config = {
    email: "admin@example.com",
    opRef: "op://Employee/My Login/password",
    itemId: "item-uuid-123",
    vaultId: "vault-uuid-456",
    fieldLabel: "password",
    ...overrides,
  };
  mockExistsSync.mockImplementation((p: unknown) =>
    String(p).endsWith("admin-auth.json"),
  );
  mockReadFileSync.mockReturnValue(JSON.stringify(config));
  return config;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("getCredentials", () => {
  beforeEach(() => {
    delete process.env.E2E_ADMIN_EMAIL;
    delete process.env.E2E_ADMIN_PASSWORD;
    delete process.env.E2E_USER_EMAIL;
    delete process.env.E2E_USER_PASSWORD;
    delete process.env.E2E_BETA_EMAIL;
    delete process.env.E2E_BETA_PASSWORD;
    delete process.env.E2E_ROOT_ADMIN_EMAIL;
    delete process.env.E2E_ROOT_ADMIN_PASSWORD;

    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("{}");
    mockReadDenConfig.mockReturnValue({ test_accounts: TEST_ACCOUNTS });

    mockExecFileAsync.mockResolvedValue({
      stdout: "secret-password\n",
      stderr: "",
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // ── ENV vars (CI mode) ──────────────────────────────────────────────────

  describe("ENV var credentials", () => {
    it("returns admin credentials from ENV vars", async () => {
      process.env.E2E_ADMIN_EMAIL = "admin@test.com";
      process.env.E2E_ADMIN_PASSWORD = "admin-pass";

      const result = await getCredentials("admin", "local");

      expect(result).toEqual({
        email: "admin@test.com",
        password: "admin-pass",
      });
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it("returns user credentials from ENV vars", async () => {
      process.env.E2E_USER_EMAIL = "user@test.com";
      process.env.E2E_USER_PASSWORD = "user-pass";

      const result = await getCredentials("user", "local");

      expect(result).toEqual({ email: "user@test.com", password: "user-pass" });
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it("ignores admin ENV vars when only email is set (no password)", async () => {
      process.env.E2E_ADMIN_EMAIL = "admin@test.com";
      // No password — falls through to the shared account for local

      const result = await getCredentials("admin", "local");

      // the configured shared admin covers local — op is mocked to succeed
      expect(result).toEqual({
        email: "test-admin@example.com",
        password: "secret-password",
      });
    });

    it("ignores user ENV vars when only email is set (no password)", async () => {
      process.env.E2E_USER_EMAIL = "user@test.com";
      // No password — falls through to 1Password

      const result = await getCredentials("user", "local");

      // op succeeds (mocked) → returns user creds from 1Password
      expect(result?.email).toBe("test-user@example.com");
    });

    it("returns beta credentials from ENV vars", async () => {
      process.env.E2E_BETA_EMAIL = "beta@test.com";
      process.env.E2E_BETA_PASSWORD = "beta-pass";

      const result = await getCredentials("beta", "local");

      expect(result).toEqual({ email: "beta@test.com", password: "beta-pass" });
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it("ignores beta ENV vars when only email is set (no password)", async () => {
      process.env.E2E_BETA_EMAIL = "beta@test.com";
      // No password — falls through to the shared account

      const result = await getCredentials("beta", "local");

      expect(result?.email).toBe("test-beta@example.com");
    });

    it("returns root_admin credentials from ENV vars", async () => {
      process.env.E2E_ROOT_ADMIN_EMAIL = "root@test.com";
      process.env.E2E_ROOT_ADMIN_PASSWORD = "root-pass";

      const result = await getCredentials("root_admin", "local");

      expect(result).toEqual({
        email: "root@test.com",
        password: "root-pass",
      });
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it("ignores root_admin ENV vars when only email is set (no password)", async () => {
      process.env.E2E_ROOT_ADMIN_EMAIL = "root@test.com";
      // No password — falls through to the shared account (local env)

      const result = await getCredentials("root_admin", "local");

      expect(result?.email).toBe("test-root-admin@example.com");
    });
  });

  // ── 1Password credentials (local dev mode) ──────────────────────────────

  describe("secrets-backend credentials", () => {
    it("fetches the user password from the configured shared account", async () => {
      const result = await getCredentials("user", "local");

      expect(result).toEqual({
        email: "test-user@example.com",
        password: "secret-password",
      });
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining(["item", "get", "Web Test User"]),
        expect.anything(),
      );
    });

    it("uses the configured test_accounts vault for the user lookup", async () => {
      await getCredentials("user", "local");

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining(["--vault", "QA Vault"]),
        expect.anything(),
      );
    });

    it("fetches admin password using itemId from config", async () => {
      mockAdminConfig({ itemId: "my-item-id" });

      // production uses per-engineer config file (not shared vault)
      const result = await getCredentials("admin", "production");

      expect(result?.email).toBe("admin@example.com");
      expect(result?.password).toBe("secret-password");
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining(["item", "get", "my-item-id"]),
        expect.anything(),
      );
    });

    it("includes vaultId and fieldLabel in admin op call", async () => {
      mockAdminConfig({ vaultId: "my-vault-id", fieldLabel: "my-password" });

      // production uses per-engineer config file (not shared vault)
      await getCredentials("admin", "production");

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining([
          "--vault",
          "my-vault-id",
          "--fields",
          "label=my-password",
        ]),
        expect.anything(),
      );
    });

    it("fetches admin from the shared account where its environments include the env", async () => {
      const result = await getCredentials("admin", "staging");

      expect(result?.email).toBe("test-admin@example.com");
      expect(result?.password).toBe("secret-password");
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining(["item", "get", "Web Test Admin"]),
        expect.anything(),
      );
    });

    it("trims trailing newline from op output", async () => {
      mockExecFileAsync.mockResolvedValue({
        stdout: "my-password\n",
        stderr: "",
      });

      const result = await getCredentials("admin", "local");

      expect(result?.password).toBe("my-password");
    });

    it("fetches the beta password from the configured shared account", async () => {
      const result = await getCredentials("beta", "local");

      expect(result).toEqual({
        email: "test-beta@example.com",
        password: "secret-password",
      });
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining(["item", "get", "Web Test Beta"]),
        expect.anything(),
      );
    });

    it("honours a per-account vault override", async () => {
      mockReadDenConfig.mockReturnValue({
        test_accounts: {
          ...TEST_ACCOUNTS,
          roles: {
            beta: { ...TEST_ACCOUNTS.roles.beta, vault: "Beta Vault" },
          },
        },
      });

      await getCredentials("beta", "local");

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining(["--vault", "Beta Vault"]),
        expect.anything(),
      );
    });

    it("fetches root_admin from the shared account (custom field) for local env", async () => {
      const result = await getCredentials("root_admin", "local");

      expect(result).toEqual({
        email: "test-root-admin@example.com",
        password: "secret-password",
      });
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining([
          "item",
          "get",
          "Web Test Root Admin",
          "--fields",
          "label=secret",
        ]),
        expect.anything(),
      );
    });

    it("fetches root_admin password using config for production env", async () => {
      mockAdminConfig({ email: "root@example.com", itemId: "root-item-id" });

      const result = await getCredentials("root_admin", "production");

      expect(result?.email).toBe("root@example.com");
      expect(result?.password).toBe("secret-password");
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining(["item", "get", "root-item-id"]),
        expect.anything(),
      );
    });

    it("returns null for root_admin when production config is missing", async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await getCredentials("root_admin", "production");

      expect(result).toBeNull();
    });

    it("fetches root_admin from the shared account for staging env", async () => {
      const result = await getCredentials("root_admin", "staging");

      expect(result?.email).toBe("test-root-admin@example.com");
      expect(result?.password).toBe("secret-password");
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining([
          "item",
          "get",
          "Web Test Root Admin",
          "--fields",
          "label=secret",
        ]),
        expect.anything(),
      );
    });
  });

  // ── No shared account configured ─────────────────────────────────────────

  describe("without test_accounts in the org config", () => {
    beforeEach(() => {
      mockReadDenConfig.mockReturnValue({});
    });

    it("returns null for user (no hard-wired account)", async () => {
      expect(await getCredentials("user", "local")).toBeNull();
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it("falls back to the per-engineer config for admin", async () => {
      mockAdminConfig({ itemId: "personal-item" });

      const result = await getCredentials("admin", "local");

      expect(result?.email).toBe("admin@example.com");
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining(["item", "get", "personal-item"]),
        expect.anything(),
      );
    });

    it("treats an unreadable org config as no shared accounts", async () => {
      mockReadDenConfig.mockImplementation(() => {
        throw new Error("no config");
      });

      expect(await getCredentials("beta", "local")).toBeNull();
    });
  });

  // ── Per-environment config lookup ────────────────────────────────────────

  describe("per-environment config lookup", () => {
    it("prefers env-specific config over generic", async () => {
      const prodConfig = {
        email: "admin-prod@example.com",
        opRef: "op://x/y/z",
        itemId: "prod-item-id",
        vaultId: "vault-id",
        fieldLabel: "password",
      };
      const genericConfig = {
        email: "admin-generic@example.com",
        opRef: "op://x/y/z",
        itemId: "generic-item-id",
        vaultId: "vault-id",
        fieldLabel: "password",
      };

      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        return (
          s.endsWith("admin-auth-production.json") ||
          s.endsWith("admin-auth.json")
        );
      });
      mockReadFileSync.mockImplementation((p: unknown) => {
        return String(p).endsWith("admin-auth-production.json")
          ? JSON.stringify(prodConfig)
          : JSON.stringify(genericConfig);
      });

      const result = await getCredentials("admin", "production");

      expect(result?.email).toBe("admin-prod@example.com");
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "op",
        expect.arrayContaining(["prod-item-id"]),
        expect.anything(),
      );
    });

    it("falls back to generic config when env-specific is absent", async () => {
      const genericConfig = {
        email: "admin-generic@example.com",
        opRef: "op://x/y/z",
        itemId: "generic-item-id",
        vaultId: "vault-id",
        fieldLabel: "password",
      };

      mockExistsSync.mockImplementation(
        (p: unknown) =>
          String(p).endsWith("admin-auth.json") &&
          !String(p).includes("admin-auth-"),
      );
      mockReadFileSync.mockReturnValue(JSON.stringify(genericConfig));

      const result = await getCredentials("admin", "production");

      expect(result?.email).toBe("admin-generic@example.com");
    });

    it("returns null when neither env-specific nor generic config exists", async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await getCredentials("admin", "production");

      expect(result).toBeNull();
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns null when op is not installed", async () => {
      mockExecFileAsync.mockRejectedValue(
        Object.assign(new Error("spawn op ENOENT"), { code: "ENOENT" }),
      );

      const result = await getCredentials("user", "local");

      expect(result).toBeNull();
    });

    it("returns null when op session has expired", async () => {
      mockExecFileAsync.mockRejectedValue(
        new Error("You are not currently signed in to 1Password CLI"),
      );

      const result = await getCredentials("user", "local");

      expect(result).toBeNull();
    });

    it("returns null for admin when op call fails", async () => {
      mockExecFileAsync.mockRejectedValue(new Error("item not found"));

      const result = await getCredentials("admin", "local");

      expect(result).toBeNull();
    });

    it("returns null for admin when config file is missing", async () => {
      mockExistsSync.mockReturnValue(false);

      // production requires config file; no file → null
      const result = await getCredentials("admin", "production");

      expect(result).toBeNull();
    });

    it("returns null when config file exists but is malformed JSON", async () => {
      mockExistsSync.mockImplementation((p: unknown) =>
        String(p).endsWith("admin-auth.json"),
      );
      mockReadFileSync.mockReturnValue("{ not valid json");

      // production uses config file; malformed file → null
      const result = await getCredentials("admin", "production");

      expect(result).toBeNull();
    });
  });
});
