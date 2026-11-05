/**
 * The secrets-backed sudo password store.
 *
 * There is no built-in location (0.3.0-dev.23): the `sudo` ref comes only
 * from `secrets.refs.sudo` in the distribution's config. With it, the
 * 1password strategy reads and writes exactly that item and field; without
 * it, every helper says "not configured" and nothing is spawned, whatever
 * the backend (none, doppler, env, 1password).
 *
 * Mocks `child_process.execFile` via util.promisify.custom so no real `op`
 * or `doppler` ever runs, and the org config via den-config.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecFileAsync = jest.fn() as jest.MockedFunction<() => Promise<any>>;

jest.mock("child_process", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { promisify } = require("util");
  const execFile = jest.fn();
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] =
    mockExecFileAsync;
  return { execFile, spawn: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let orgConfig: any = {};
jest.mock("../../../src/shared/den-config.js", () => ({
  readDenConfig: () => orgConfig,
  readUserConfig: () => ({}),
}));

// detect(): the backend's CLI is "on PATH" unless a test says otherwise.
let cliOnPath = true;
jest.mock("../../../src/shared/strategies/registry.js", () => ({
  ...jest.requireActual<object>("../../../src/shared/strategies/registry.js"),
  onPath: () => cliOnPath,
}));

import {
  isOpSignedIn,
  readSudoFromVault,
  hasSudoInVault,
  saveSudoToVault,
  sudoVaultStatus,
} from "../../../src/shared/auth/sudo-vault.js";
import { resetSecretsProviderCache } from "../../../src/shared/secrets/index.js";

const REF = {
  vault: "Team Vault",
  item: "Dev Keys",
  field: "DEN_LOCAL_ADMIN_PWD",
};
const onePassword = (refs?: object) => ({
  secrets: { provider: "1password", ...(refs ? { refs } : {}) },
});

beforeEach(() => {
  mockExecFileAsync.mockReset();
  delete process.env.DEN_SECRETS_PROVIDER;
  orgConfig = onePassword({ sudo: REF });
  cliOnPath = true;
  resetSecretsProviderCache();
});

describe("with secrets.refs.sudo configured (1password)", () => {
  it("isOpSignedIn follows `op whoami`", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "user@x", stderr: "" });
    await expect(isOpSignedIn()).resolves.toBe(true);
    mockExecFileAsync.mockRejectedValueOnce(new Error("not signed in"));
    await expect(isOpSignedIn()).resolves.toBe(false);
  });

  it("reads exactly the configured vault, item and field", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "v\n", stderr: "" });
    await expect(readSudoFromVault()).resolves.toBe("v");
    const [bin, args] = mockExecFileAsync.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(bin).toBe("op");
    expect(args).toEqual([
      "item",
      "get",
      "Dev Keys",
      "--vault",
      "Team Vault",
      "--fields",
      "label=DEN_LOCAL_ADMIN_PWD",
      "--reveal",
    ]);
  });

  it("returns null for an empty field or a failed read", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "\n", stderr: "" });
    await expect(readSudoFromVault()).resolves.toBeNull();
    mockExecFileAsync.mockRejectedValueOnce(new Error("no such field"));
    await expect(hasSudoInVault()).resolves.toBe(false);
  });

  it("saves to the configured item and rethrows backend errors", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await saveSudoToVault("sekret");
    const [, args] = mockExecFileAsync.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(args).toEqual([
      "item",
      "edit",
      "Dev Keys",
      "--vault",
      "Team Vault",
      "DEN_LOCAL_ADMIN_PWD[password]=sekret",
    ]);
    mockExecFileAsync.mockRejectedValueOnce(new Error("vault not found"));
    await expect(saveSudoToVault("x")).rejects.toThrow("vault not found");
  });

  it("vault-status is neutral: backend, backendAvailable, opAvailable alias", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "user@x", stderr: "" }) // whoami
      .mockResolvedValueOnce({ stdout: "pw", stderr: "" }); // item get
    await expect(sudoVaultStatus()).resolves.toEqual({
      backend: "1password",
      label: "1Password",
      configured: true,
      backendAvailable: true,
      hasStored: true,
      opAvailable: true,
    });
  });

  it("op not on PATH: not available, with the reason, and op is never spawned", async () => {
    cliOnPath = false;
    const st = await sudoVaultStatus();
    expect(st).toMatchObject({
      backend: "1password",
      configured: true,
      backendAvailable: false,
      opAvailable: false,
    });
    expect(st.reason).toMatch(/not available: .*\(op\) is not on PATH/);
    await expect(readSudoFromVault()).resolves.toBeNull();
    await expect(saveSudoToVault("x")).rejects.toThrow(/not available/);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

describe.each([
  ["1password", onePassword()],
  ["doppler", { secrets: { provider: "doppler" } }],
  ["env", { secrets: { provider: "env" } }],
  ["none", { secrets: { provider: "none" } }],
  ["unset (implicit doppler)", {}],
])("%s with no secrets.refs.sudo", (_name, cfg) => {
  beforeEach(() => {
    orgConfig = cfg;
    resetSecretsProviderCache();
  });

  it("reports not configured, pointing at secrets.refs.sudo; spawns nothing", async () => {
    const st = await sudoVaultStatus();
    expect(st.configured).toBe(false);
    expect(st.backendAvailable).toBe(false);
    expect(st.opAvailable).toBe(false);
    expect(st.hasStored).toBe(false);
    expect(st.reason).toMatch(
      /^not configured: set secrets\.provider and secrets\.refs\.sudo in config\//,
    );
    await expect(isOpSignedIn()).resolves.toBe(false);
    await expect(readSudoFromVault()).resolves.toBeNull();
    await expect(saveSudoToVault("x")).rejects.toThrow(/not configured/);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});
