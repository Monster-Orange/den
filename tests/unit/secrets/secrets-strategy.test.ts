import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockExecFileAsync = jest.fn() as jest.MockedFunction<
  (...a: unknown[]) => Promise<{ stdout: string; stderr: string }>
>;

jest.mock("child_process", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { promisify } = require("util");
  const execFile = jest.fn();
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] =
    mockExecFileAsync;
  return { execFile, spawn: jest.fn() };
});

import {
  createSecretsProvider,
  flatKeyFor,
  resolveProviderName,
  toEnvName,
  DopplerProvider,
  EnvProvider,
  OnePasswordProvider,
} from "../../../src/shared/secrets/index.js";

const REF = {
  vault: "Test Accounts",
  item: "Shop Test User (Auth0)",
  field: "password",
};

beforeEach(() => mockExecFileAsync.mockReset());

describe("flat key mapping", () => {
  it("upper-snakes item+field by default", () => {
    expect(toEnvName("Shop Test User (Auth0) password")).toBe(
      "SHOP_TEST_USER_AUTH0_PASSWORD",
    );
    expect(flatKeyFor(REF)).toBe("SHOP_TEST_USER_AUTH0_PASSWORD");
  });
  it("uses an env-shaped field verbatim", () => {
    expect(
      flatKeyFor({ vault: "v", item: "Keys", field: "OPENAI_API_KEY" }),
    ).toBe("OPENAI_API_KEY");
  });
  it("prefers ref.key, then the secrets.keys override map", () => {
    expect(flatKeyFor({ ...REF, key: "PINNED" })).toBe("PINNED");
    expect(
      flatKeyFor(REF, {
        "Test Accounts/Shop Test User (Auth0)/password": "E2E_USER_PASSWORD",
      }),
    ).toBe("E2E_USER_PASSWORD");
  });
});

describe("provider selection is configuration, not code", () => {
  it("defaults to doppler", () => {
    expect(resolveProviderName({}, {})).toBe("doppler");
  });
  it("honours config, and env overrides config", () => {
    expect(resolveProviderName({ provider: "1password" }, {})).toBe(
      "1password",
    );
    expect(
      resolveProviderName(
        { provider: "1password" },
        { DEN_SECRETS_PROVIDER: "env" },
      ),
    ).toBe("env");
  });
  it("rejects unknown backends loudly", () => {
    expect(() =>
      resolveProviderName({}, { DEN_SECRETS_PROVIDER: "vault9" }),
    ).toThrow(/not one of/);
    expect(() =>
      resolveProviderName({ provider: "nope" as never }, {}),
    ).toThrow(/not one of/);
  });
  it("builds the matching strategy", () => {
    expect(createSecretsProvider("doppler")).toBeInstanceOf(DopplerProvider);
    expect(createSecretsProvider("1password")).toBeInstanceOf(
      OnePasswordProvider,
    );
    expect(createSecretsProvider("env")).toBeInstanceOf(EnvProvider);
  });
});

describe("DopplerProvider", () => {
  it("reads the flat key with --plain and the configured scope", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "s3cret\n", stderr: "" });
    const p = new DopplerProvider({ project: "ent-compass", config: "dev" });
    await expect(p.get(REF)).resolves.toBe("s3cret");
    const [bin, args] = mockExecFileAsync.mock.calls[0];
    expect(bin).toBe("doppler");
    expect(args).toEqual([
      "secrets",
      "get",
      "SHOP_TEST_USER_AUTH0_PASSWORD",
      "--plain",
      "--project",
      "ent-compass",
      "--config",
      "dev",
    ]);
  });
  it("tryGet returns null on CLI failure", async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error("not found"));
    await expect(new DopplerProvider().tryGet(REF)).resolves.toBeNull();
  });
  it("wraps child commands with doppler run", () => {
    expect(new DopplerProvider({ config: "dev" }).runPrefix()).toEqual([
      "doppler",
      "run",
      "--config",
      "dev",
      "--",
    ]);
  });
  it("preflight explains how to log in when the CLI is unavailable", async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error("ENOENT"));
    const r = await new DopplerProvider().preflight();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/doppler login/);
  });
});

describe("EnvProvider", () => {
  it("reads and writes process-local env keys", async () => {
    const env: NodeJS.ProcessEnv = { SHOP_TEST_USER_AUTH0_PASSWORD: "pw" };
    const p = new EnvProvider({}, env);
    await expect(p.get(REF)).resolves.toBe("pw");
    await p.set({ vault: "", item: "x", field: "NEW_KEY" }, "v");
    expect(env.NEW_KEY).toBe("v");
    await expect(
      p.tryGet({ vault: "", item: "x", field: "MISSING" }),
    ).resolves.toBeNull();
    await expect(
      p.get({ vault: "", item: "x", field: "MISSING" }),
    ).rejects.toThrow(/MISSING/);
  });
});

describe("OnePasswordProvider", () => {
  it("uses op item get with vault, field label and --reveal", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "pw\n", stderr: "" });
    await expect(new OnePasswordProvider().get(REF)).resolves.toBe("pw");
    expect(mockExecFileAsync.mock.calls[0][1]).toEqual([
      "item",
      "get",
      "Shop Test User (Auth0)",
      "--vault",
      "Test Accounts",
      "--fields",
      "label=password",
      "--reveal",
    ]);
  });
});
