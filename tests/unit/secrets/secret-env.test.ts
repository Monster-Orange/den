/**
 * R16 secret_env: ref parsing and validation, what each provider does with a
 * scoped ref, and all-or-nothing resolution that never echoes a value.
 */
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
  DopplerProvider,
  EnvProvider,
  OnePasswordProvider,
  flatKeyFor,
  parseSecretEnvRef,
  resolveSecretEnv,
  secretEnvRefError,
  secretEnvSpecErrors,
  type SecretsProvider,
} from "../../../src/shared/secrets/index.js";
import { validateManifest } from "../../../src/shared/manifest/validate-manifest.js";

const FAKE = "sk-test-123";

beforeEach(() => mockExecFileAsync.mockReset());

describe("secret_env refs", () => {
  it("parses a/b/c into a scoped ref", () => {
    expect(parseSecretEnvRef("proj/dev_personal/OPENAI_API_KEY")).toEqual({
      vault: "proj",
      item: "dev_personal",
      field: "OPENAI_API_KEY",
      scoped: true,
    });
    // 1Password names keep their spaces.
    expect(parseSecretEnvRef("Engineering/Stripe Test/secret key").item).toBe(
      "Stripe Test",
    );
  });

  it.each([
    "OPENAI_API_KEY",
    "proj/OPENAI_API_KEY",
    "a/b/c/d",
    "a//c",
    "/b/c",
    "a/b/",
    "a/ b/c",
    "",
  ])("rejects %p (not exactly three non-empty parts)", (raw) => {
    expect(secretEnvRefError(raw)).toMatch(/exactly three non-empty parts/);
    expect(() => parseSecretEnvRef(raw)).toThrow(/secret_env ref/);
  });

  it("checks a whole block: env var names and refs", () => {
    expect(secretEnvSpecErrors({ OK_KEY: "a/b/c" }, "x")).toEqual([]);
    const errs = secretEnvSpecErrors({ "bad-key": "a/b/c", K: "a/b" }, "x");
    expect(errs.join("\n")).toMatch(/x\.bad-key: "bad-key" is not a valid/);
    expect(errs.join("\n")).toMatch(/x\.K: ref "a\/b" must be exactly three/);
    expect(secretEnvSpecErrors(["a/b/c"], "x")[0]).toMatch(/must be a map/);
  });

  it("manifest validation rejects malformed refs in compose and services", () => {
    const ok = validateManifest({
      name: "r",
      compose: { secret_env: { OPENAI_API_KEY: "proj/dev/OPENAI_API_KEY" } },
      services: { api: { secret_env: { SOME_KEY: "vault/item/field" } } },
    });
    expect(ok.errors).toEqual([]);
    expect(ok.valid).toBe(true);

    const bad = validateManifest({
      name: "r",
      compose: { secret_env: { OPENAI_API_KEY: "OPENAI_API_KEY" } },
      services: { api: { secret_env: { "not-env": "a/b/c", K: "a//c" } } },
    });
    expect(bad.valid).toBe(false);
    const paths = bad.errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "compose.secret_env.OPENAI_API_KEY",
        "services.api.secret_env.K",
      ]),
    );
    expect(bad.errors.map((e) => e.message).join("\n")).toMatch(
      /exactly three non-empty parts/,
    );
    expect(paths.some((p) => p.startsWith("services.api.secret_env"))).toBe(
      true,
    );
  });
});

describe("scoped refs per provider", () => {
  const SCOPED = parseSecretEnvRef("proj/dev_personal/OPENAI_API_KEY");

  it("Doppler: vault → --project, item → --config, field → key", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: `${FAKE}\n`,
      stderr: "",
    });
    // The configured scope and key map do not apply to a scoped ref.
    const p = new DopplerProvider({
      project: "other",
      config: "prd",
      keys: { "proj/dev_personal/OPENAI_API_KEY": "REMAPPED" },
    });
    await expect(p.get(SCOPED)).resolves.toBe(FAKE);
    const [bin, args] = mockExecFileAsync.mock.calls[0];
    expect(bin).toBe("doppler");
    expect(args).toEqual([
      "secrets",
      "get",
      "OPENAI_API_KEY",
      "--plain",
      "--project",
      "proj",
      "--config",
      "dev_personal",
    ]);
  });

  it("Doppler: an unscoped ref keeps the configured scope and key map", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: `${FAKE}\n`,
      stderr: "",
    });
    const p = new DopplerProvider({
      project: "other",
      config: "prd",
      keys: { "Vault/Item/field": "MAPPED_KEY" },
    });
    await p.get({ vault: "Vault", item: "Item", field: "field" });
    expect(mockExecFileAsync.mock.calls[0][1]).toEqual([
      "secrets",
      "get",
      "MAPPED_KEY",
      "--plain",
      "--project",
      "other",
      "--config",
      "prd",
    ]);
    // Without a configured scope, no flags: doppler's own setup decides.
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: `${FAKE}\n`,
      stderr: "",
    });
    await new DopplerProvider().get({
      vault: "v",
      item: "Keys",
      field: "OPENAI_API_KEY",
    });
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual([
      "secrets",
      "get",
      "OPENAI_API_KEY",
      "--plain",
    ]);
  });

  it("flatKeyFor: a scoped ref is its field, whatever the overrides", () => {
    expect(
      flatKeyFor(parseSecretEnvRef("a/b/lower_case"), {
        "a/b/lower_case": "X",
      }),
    ).toBe("lower_case");
    // Unscoped: unchanged (override map, then derivation).
    expect(
      flatKeyFor({ vault: "a", item: "b", field: "c" }, { "a/b/c": "X" }),
    ).toBe("X");
    expect(flatKeyFor({ vault: "a", item: "My Item", field: "pw" })).toBe(
      "MY_ITEM_PW",
    );
  });

  it("1Password: vault / item / field as is", async () => {
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: `${FAKE}\n`,
      stderr: "",
    });
    await new OnePasswordProvider().get(
      parseSecretEnvRef("Engineering/Stripe Test/secret key"),
    );
    expect(mockExecFileAsync.mock.calls[0][1]).toEqual([
      "item",
      "get",
      "Stripe Test",
      "--vault",
      "Engineering",
      "--fields",
      "label=secret key",
      "--reveal",
    ]);
  });

  it("env: the field is the env var name, the key map is not applied", async () => {
    const p = new EnvProvider(
      { "proj/dev/OPENAI_API_KEY": "REMAPPED" },
      { OPENAI_API_KEY: FAKE, REMAPPED: "wrong" },
    );
    await expect(
      p.get(parseSecretEnvRef("proj/dev/OPENAI_API_KEY")),
    ).resolves.toBe(FAKE);
  });
});

describe("resolveSecretEnv", () => {
  const spec = {
    OPENAI_API_KEY: "proj/dev_personal/OPENAI_API_KEY",
    OTHER_KEY: "proj/dev_personal/OTHER_KEY",
  };

  it("resolves every key", async () => {
    const p = new EnvProvider({}, { OPENAI_API_KEY: FAKE, OTHER_KEY: "o-1" });
    await expect(resolveSecretEnv(spec, p, "stack s")).resolves.toEqual({
      ok: true,
      env: { OPENAI_API_KEY: FAKE, OTHER_KEY: "o-1" },
    });
  });

  it("is all or nothing, naming key, ref and provider, never a value", async () => {
    const p = new EnvProvider({}, { OPENAI_API_KEY: FAKE });
    const r = await resolveSecretEnv(spec, p, "stack s");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r).not.toHaveProperty("env");
    expect(r.missing).toEqual([
      { key: "OTHER_KEY", ref: "proj/dev_personal/OTHER_KEY" },
    ]);
    expect(r.message).toMatch(/stack s/);
    expect(r.message).toMatch(
      /OTHER_KEY \(ref proj\/dev_personal\/OTHER_KEY, provider env\)/,
    );
    expect(JSON.stringify(r)).not.toContain(FAKE);
  });

  it("treats a provider error as missing, without its text", async () => {
    const p: SecretsProvider = {
      ...new EnvProvider({}, {}),
      name: "doppler",
      tryGet: async () => {
        throw new Error(`leaky ${FAKE}`);
      },
    } as unknown as SecretsProvider;
    const r = await resolveSecretEnv({ K: "a/b/K" }, p, "t");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(FAKE);
    expect(JSON.stringify(r)).toMatch(/provider doppler/);
  });

  it("asks nothing for an empty block", async () => {
    const tryGet = jest.fn();
    const p = { name: "env", tryGet } as unknown as SecretsProvider;
    await expect(resolveSecretEnv(undefined, p, "t")).resolves.toEqual({
      ok: true,
      env: {},
    });
    expect(tryGet).not.toHaveBeenCalled();
  });
});
