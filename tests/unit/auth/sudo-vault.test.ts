process.env.DEN_SECRETS_PROVIDER = "1password";
/**
 * Unit tests for the 1Password-backed sudo password store.
 *
 * Mocks `child_process.execFile` via util.promisify.custom so the module's
 * execFileAsync calls resolve to {stdout, stderr} objects without hitting
 * a real op binary.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

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

// Import after mocks are registered
import {
  isOpSignedIn,
  readSudoFromVault,
  hasSudoInVault,
  saveSudoToVault,
} from "../../../src/shared/auth/sudo-vault.js";

beforeEach(() => {
  mockExecFileAsync.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── isOpSignedIn ─────────────────────────────────────────────────────────────

describe("isOpSignedIn", () => {
  it("returns true when `op whoami` exits 0", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "user@x", stderr: "" });
    await expect(isOpSignedIn()).resolves.toBe(true);
  });

  it("returns false when `op whoami` throws (not signed in / not installed)", async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error("not signed in"));
    await expect(isOpSignedIn()).resolves.toBe(false);
  });
});

// ── readSudoFromVault ────────────────────────────────────────────────────────

describe("readSudoFromVault", () => {
  it("returns the field value trimmed of whitespace", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: "hunter2\n",
      stderr: "",
    });
    await expect(readSudoFromVault()).resolves.toBe("hunter2");
  });

  it("returns null when the field is empty string", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "\n", stderr: "" });
    await expect(readSudoFromVault()).resolves.toBeNull();
  });

  it("returns null when op throws (item/field missing, not signed in, etc.)", async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error("no such field"));
    await expect(readSudoFromVault()).resolves.toBeNull();
  });

  it("passes the expected args to op (vault, item, field, --reveal)", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "v", stderr: "" });
    await readSudoFromVault();
    // The first positional arg to execFile is "op"; the 2nd is the argv array.
    // jest's MockedFunction<() => Promise<any>> doesn't carry types for the
    // call args here, so cast for assertion.
    const [bin, args] = mockExecFileAsync.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(bin).toBe("op");
    expect(args).toEqual([
      "item",
      "get",
      "Developer API Keys",
      "--vault",
      "Employee",
      "--fields",
      "label=DEN_LOCAL_ADMIN_PWD",
      "--reveal",
    ]);
  });
});

// ── hasSudoInVault ───────────────────────────────────────────────────────────

describe("hasSudoInVault", () => {
  it("returns true when readSudoFromVault returns a value", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "hunter2", stderr: "" });
    await expect(hasSudoInVault()).resolves.toBe(true);
  });

  it("returns false when the read fails or is empty", async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error("no field"));
    await expect(hasSudoInVault()).resolves.toBe(false);
  });
});

// ── saveSudoToVault ──────────────────────────────────────────────────────────

describe("saveSudoToVault", () => {
  it("invokes op item edit with the password assignment", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await saveSudoToVault("sekret");
    const [bin, args] = mockExecFileAsync.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(bin).toBe("op");
    expect(args).toEqual([
      "item",
      "edit",
      "Developer API Keys",
      "--vault",
      "Employee",
      "DEN_LOCAL_ADMIN_PWD[password]=sekret",
    ]);
  });

  it("rethrows when the op call fails (so callers can surface the error)", async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error("vault not found"));
    await expect(saveSudoToVault("x")).rejects.toThrow("vault not found");
  });
});
