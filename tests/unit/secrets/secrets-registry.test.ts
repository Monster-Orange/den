/**
 * Secrets strategies as registered strategies (0.3.0-dev.23): the registry
 * entries and their detect(), the `none` strategy, no built-in refs or
 * account, OP_ACCOUNT only from the 1password strategy, the lazy implicit
 * doppler default, and the legacy warning for 1password with no refs.
 *
 * child_process is mocked: no real op or doppler can ever run here.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockExecFileAsync = jest.fn() as jest.MockedFunction<
  (...a: unknown[]) => Promise<{ stdout: string; stderr: string }>
>;
const mockSpawn = jest.fn();
jest.mock("child_process", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { promisify } = require("util");
  const execFile = jest.fn();
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] =
    mockExecFileAsync;
  return { execFile, spawn: mockSpawn, execSync: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let orgConfig: any = {};
jest.mock("../../../src/shared/den-config.js", () => ({
  readDenConfig: () => orgConfig,
  readUserConfig: () => ({}),
}));

import {
  createSecretsProvider,
  getSecretsProvider,
  IMPLICIT_PROVIDER_WARNING,
  namedSecretRef,
  NoneProvider,
  resetSecretsProviderCache,
  resolveProvider,
  secretsConfigWarnings,
  secretsProcessEnv,
  secretsStatus,
  secretsStrategy,
  secretsStrategyIds,
} from "../../../src/shared/secrets/index.js";
import { getStrategy } from "../../../src/shared/strategies/registry.js";
import { webServerEnv } from "../../../src/ui/cli/web-command.js";

/** A PATH of one dir holding fake executables (or nothing). */
function pathWith(bins: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-detect-"));
  for (const b of bins) {
    fs.writeFileSync(path.join(dir, b), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(dir, b), 0o755);
  }
  return dir;
}

beforeEach(() => {
  mockExecFileAsync.mockReset();
  mockSpawn.mockReset();
  orgConfig = {};
  delete process.env.DEN_SECRETS_PROVIDER;
  resetSecretsProviderCache();
});

describe("the registry", () => {
  it("registers every built-in as { id, kind: secrets, detect, capabilities }", () => {
    expect(secretsStrategyIds()).toEqual([
      "none",
      "env",
      "doppler",
      "1password",
    ]);
    for (const id of secretsStrategyIds()) {
      const s = getStrategy("secrets", id)!;
      expect(s).toMatchObject({ id, kind: "secrets" });
      expect(typeof s.detect).toBe("function");
      expect(typeof (s.capabilities as { create: unknown }).create).toBe(
        "function",
      );
    }
    expect(secretsStrategy("1password")!.capabilities.setup).toBeDefined();
    expect(secretsStrategy("none")!.capabilities.setup).toBeUndefined();
  });

  it("detect(): op / doppler off PATH are unavailable with a reason; env and none always available", () => {
    const empty = { PATH: pathWith([]) };
    expect(secretsStrategy("1password")!.detect(empty)).toEqual({
      available: false,
      reason: "The 1Password CLI (op) is not on PATH",
    });
    expect(secretsStrategy("doppler")!.detect(empty)).toEqual({
      available: false,
      reason: "The Doppler CLI (doppler) is not on PATH",
    });
    expect(secretsStrategy("env")!.detect(empty).available).toBe(true);
    expect(secretsStrategy("none")!.detect(empty)).toEqual({
      available: true,
      reason: "no secrets backend configured",
    });
    const both = { PATH: pathWith(["op", "doppler"]) };
    expect(secretsStrategy("1password")!.detect(both).available).toBe(true);
    expect(secretsStrategy("doppler")!.detect(both).available).toBe(true);
    // detect() is a file check: nothing is spawned.
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("a backend whose CLI is off PATH reports the reason; no feature spawns it", async () => {
    const saved = process.env.PATH;
    process.env.PATH = pathWith([]);
    try {
      for (const provider of ["doppler", "1password"]) {
        orgConfig = { secrets: { provider } };
        resetSecretsProviderCache();
        const p = getSecretsProvider();
        const ref = { vault: "v", item: "i", field: "F" };
        await expect(p.isReady()).resolves.toBe(false);
        await expect(p.tryGet(ref)).resolves.toBeNull();
        await expect(p.get(ref)).rejects.toThrow(
          /not available: .*not on PATH/,
        );
        await expect(p.set(ref, "x")).rejects.toThrow(/not available/);
        const pre = await p.preflight();
        expect(pre.ok).toBe(false);
        expect(pre.message).toMatch(/not available/);
        expect(p.runPrefix()).toEqual([]);
      }
      expect(mockExecFileAsync).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("none", () => {
  it("resolves nothing, never spawns, and says not configured", async () => {
    const p = new NoneProvider();
    const ref = { vault: "v", item: "i", field: "F" };
    await expect(p.isReady()).resolves.toBe(false);
    await expect(p.tryGet()).resolves.toBeNull();
    await expect(p.get(ref)).rejects.toThrow(/not configured/);
    await expect(p.set()).rejects.toThrow(/not configured/);
    await expect(p.preflight()).resolves.toMatchObject({ ok: true });
    expect(p.runPrefix()).toEqual([]);
    expect(createSecretsProvider("none")).toBeInstanceOf(NoneProvider);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("is an explicit choice", () => {
    expect(resolveProvider({ provider: "none" }, {})).toEqual({
      name: "none",
      implicit: false,
    });
  });
});

describe("no built-in refs", () => {
  it.each(["1password", "doppler", "env", "none"] as const)(
    "%s: sudo and journeys_agent_key are null without secrets.refs",
    (provider) => {
      expect(namedSecretRef("sudo", { provider }, provider)).toBeNull();
      expect(
        namedSecretRef("journeys_agent_key", { provider }, provider),
      ).toBeNull();
    },
  );

  it("returns exactly the configured ref; 1password needs item + field, flat-key backends a key or field", () => {
    const refs = {
      sudo: { vault: "Team", item: "Dev Keys", field: "X_PWD" },
      flat: { key: "X_PWD" },
    };
    expect(namedSecretRef("sudo", { refs }, "1password")).toEqual({
      vault: "Team",
      item: "Dev Keys",
      field: "X_PWD",
    });
    expect(namedSecretRef("flat", { refs }, "1password")).toBeNull();
    expect(namedSecretRef("flat", { refs }, "doppler")).toEqual({
      vault: "",
      item: "",
      field: "X_PWD",
      key: "X_PWD",
    });
    expect(namedSecretRef("flat", { refs }, "env")).not.toBeNull();
    expect(namedSecretRef("sudo", { refs }, "none")).toBeNull();
  });
});

describe("OP_ACCOUNT", () => {
  const clean = { PATH: "/usr/bin", HOME: "/tmp" };
  it.each([
    ["unset", {}],
    ["none", { provider: "none" }],
    ["doppler", { provider: "doppler" }],
    ["env", { provider: "env" }],
  ])("the web server env has none for %s", (_n, cfg) => {
    expect(webServerEnv(7999, clean, cfg).OP_ACCOUNT).toBeUndefined();
    expect(secretsProcessEnv(cfg, clean)).toEqual({});
  });

  it("1password: only from the distribution's config or the caller's own, never a default", () => {
    const op = { provider: "1password" as const };
    expect(webServerEnv(7999, clean, op).OP_ACCOUNT).toBeUndefined();
    expect(
      webServerEnv(7999, clean, {
        ...op,
        onepassword: { account: "team.example.test" },
      }).OP_ACCOUNT,
    ).toBe("team.example.test");
    expect(
      webServerEnv(7999, { ...clean, OP_ACCOUNT: "mine.example.test" }, op)
        .OP_ACCOUNT,
    ).toBe("mine.example.test");
    expect(webServerEnv(7999, clean, op).PORT).toBe("7999");
  });
});

describe("the implicit doppler default", () => {
  it("an unset provider still resolves to doppler, marked implicit", () => {
    expect(resolveProvider({}, {})).toEqual({
      name: "doppler",
      implicit: true,
    });
    expect(resolveProvider({ provider: "doppler" }, {})).toEqual({
      name: "doppler",
      implicit: false,
    });
  });

  it("is lazy: no detect, no preflight probe, no wrapper, no warning until a secret is resolved; then warns once", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const p = getSecretsProvider();
      expect(p.name).toBe("doppler");
      await expect(p.preflight()).resolves.toEqual({ ok: true });
      expect(p.runPrefix()).toEqual([]);
      expect(secretsConfigWarnings()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(mockExecFileAsync).not.toHaveBeenCalled();

      mockExecFileAsync.mockResolvedValue({ stdout: "v\n", stderr: "" });
      const ref = { vault: "", item: "", field: "SOME_KEY" };
      await p.tryGet(ref);
      await p.tryGet(ref);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(
        IMPLICIT_PROVIDER_WARNING,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("1password with no refs", () => {
  it("warns once (for the startup log and validate), generically, with the YAML to add", () => {
    const w = secretsConfigWarnings({ provider: "1password" }, {});
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/no longer assumes a default vault, item or field/);
    expect(w[0]).toMatch(
      /sudo: \{ vault: <vault>, item: <item>, field: <field> \}/,
    );
    expect(w[0]).toMatch(/stay off until then/);
    expect(
      secretsConfigWarnings(
        {
          provider: "1password",
          refs: { sudo: { vault: "a", item: "b", field: "c" } },
        },
        {},
      ),
    ).toEqual([]);
    expect(secretsConfigWarnings({ provider: "doppler" }, {})).toEqual([]);
  });

  it("status reports the strategy and detect()", () => {
    const st = secretsStatus({ provider: "none" }, {});
    expect(st).toEqual({
      backend: "none",
      label: "none",
      implicit: false,
      detect: { available: true, reason: "no secrets backend configured" },
    });
  });
});
