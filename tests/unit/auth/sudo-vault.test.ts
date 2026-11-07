/**
 * The secrets-backed sudo password store.
 *
 * There is no built-in location (0.3.0-dev.23): the `sudo` ref comes from
 * `secrets.refs.sudo` in the distribution's config, or (LK-4, 0.4.5) in the
 * person's user.yml, written by saving. With it, the 1password strategy
 * reads and writes exactly that item and field; without it, every helper
 * says "not configured" and nothing is spawned, whatever the backend (none,
 * doppler, env, 1password), until the password is saved where a backend
 * keeps it: then the item is created and the ref written to user.yml. The
 * distribution's ref still wins over the person's.
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let userConfig: any = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let userWrites: any[] = [];
jest.mock("../../../src/shared/den-config.js", () => ({
  readDenConfig: () => orgConfig,
  readUserConfig: () => userConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeUserConfig: (c: any) => {
    userWrites.push(c);
    userConfig = c;
  },
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
  userConfig = {};
  userWrites = [];
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
    // An edit that fails, then a create that fails: the edit's error.
    mockExecFileAsync
      .mockRejectedValueOnce(new Error("vault not found"))
      .mockRejectedValueOnce(new Error("create failed"));
    await expect(saveSudoToVault("x")).rejects.toThrow("vault not found");
    expect(userWrites).toEqual([]);
  });

  it("vault-status is neutral: backend, backendAvailable, opAvailable alias", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "user@x", stderr: "" }) // whoami
      .mockResolvedValueOnce({ stdout: "pw", stderr: "" }); // item get
    await expect(sudoVaultStatus()).resolves.toEqual({
      backend: "1password",
      label: "1Password",
      configured: true,
      canSave: true,
      backendAvailable: true,
      hasStored: true,
      opAvailable: true,
      // The real config file, for the UI's not-configured note.
      configFile: "config/den.yml",
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
  // [name, config, backendAvailable with the CLI on PATH, canSave (LK-4)]
  ["1password", onePassword(), true, true],
  ["doppler", { secrets: { provider: "doppler" } }, true, true],
  // env keeps nothing past the process: no save.
  ["env", { secrets: { provider: "env" } }, true, false],
  ["none", { secrets: { provider: "none" } }, false, false],
  ["unset (implicit doppler)", {}, false, false],
])("%s with no secrets.refs.sudo", (_name, cfg, available, canSave) => {
  beforeEach(() => {
    orgConfig = cfg;
    resetSecretsProviderCache();
  });

  it("reports not configured, pointing at secrets.refs.sudo; spawns nothing", async () => {
    const st = await sudoVaultStatus();
    expect(st.configured).toBe(false);
    // An explicit backend whose CLI is installed is available (the alias
    // keeps its 0.2.x meaning); not configured is `configured`'s job.
    expect(st.backendAvailable).toBe(available);
    expect(st.opAvailable).toBe(available);
    expect(st.hasStored).toBe(false);
    // LK-4: saving works without editing YAML where a backend keeps it.
    expect(st.canSave).toBe(canSave);
    expect(st.reason).toMatch(
      /^not configured: set secrets\.provider and secrets\.refs\.sudo in config\//,
    );
    await expect(isOpSignedIn()).resolves.toBe(false);
    await expect(readSudoFromVault()).resolves.toBeNull();
    if (!canSave) {
      await expect(saveSudoToVault("x")).rejects.toThrow(/not configured/);
      expect(userWrites).toEqual([]);
    }
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("CLI not on PATH: not available either way; still spawns nothing", async () => {
    cliOnPath = false;
    const st = await sudoVaultStatus();
    expect([st.configured, st.backendAvailable]).toEqual([
      false,
      _name === "env" ? available : false,
    ]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

describe("LK-4: saving with no secrets.refs.sudo (1password)", () => {
  beforeEach(() => {
    orgConfig = onePassword();
    resetSecretsProviderCache();
  });
  const calls = () =>
    mockExecFileAsync.mock.calls.map(
      (c) => (c as unknown as [string, string[]])[1],
    );

  it("creates the item, then writes the ref to user.yml; the ref is then configured", async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(
        new Error(
          'Command failed: op item edit\n"Den admin password" isn\'t an item',
        ),
      )
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    userConfig = { local_dev: true };
    await expect(saveSudoToVault("sekret")).resolves.toEqual({
      ref: "created",
    });
    expect(calls()).toEqual([
      ["item", "edit", "Den admin password", "password[password]=sekret"],
      [
        "item",
        "create",
        "--category",
        "password",
        "--title",
        "Den admin password",
        "password[password]=sekret",
      ],
    ]);
    // The person's user.yml, keeping what was there.
    expect(userWrites).toEqual([
      {
        local_dev: true,
        secrets: {
          refs: { sudo: { item: "Den admin password", field: "password" } },
        },
      },
    ]);
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "user@x", stderr: "" })
      .mockResolvedValueOnce({ stdout: "sekret", stderr: "" });
    await expect(sudoVaultStatus()).resolves.toMatchObject({
      configured: true,
      canSave: true,
      hasStored: true,
    });
  });

  it("a failed save writes no ref, and its error never carries the password", async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(
        new Error(
          "Command failed: op item edit X password[password]=sekret\nnot signed in",
        ),
      )
      .mockRejectedValueOnce(
        new Error("Command failed: op item create password[password]=sekret"),
      );
    const err = await saveSudoToVault("sekret").then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe("not signed in");
    expect(String(err?.message)).not.toContain("sekret");
    expect(userWrites).toEqual([]);
    expect((await sudoVaultStatus()).configured).toBe(false);
  });

  it("the distribution's ref wins over one in user.yml", async () => {
    orgConfig = onePassword({ sudo: REF });
    userConfig = {
      secrets: {
        refs: { sudo: { item: "Den admin password", field: "password" } },
      },
    };
    resetSecretsProviderCache();
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await expect(saveSudoToVault("sekret")).resolves.toEqual({
      ref: "configured",
    });
    expect(calls()[0]).toEqual([
      "item",
      "edit",
      "Dev Keys",
      "--vault",
      "Team Vault",
      "DEN_LOCAL_ADMIN_PWD[password]=sekret",
    ]);
    expect(userWrites).toEqual([]);
  });

  it("op not on PATH: no save offered, nothing created or written", async () => {
    cliOnPath = false;
    expect((await sudoVaultStatus()).canSave).toBe(false);
    await expect(saveSudoToVault("x")).rejects.toThrow(/not configured/);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(userWrites).toEqual([]);
  });
});
