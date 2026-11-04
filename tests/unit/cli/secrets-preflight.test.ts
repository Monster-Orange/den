import { describe, it, expect, jest } from "@jest/globals";
import * as path from "path";
import {
  buildSecretsPreflightInvocation,
  preflightSecrets,
  shouldSkipSecretsPreflight,
} from "../../../src/ui/cli/secrets-preflight.js";

describe("secrets preflight", () => {
  it("skips only when DEN_SKIP_SECRETS is truthy", () => {
    expect(shouldSkipSecretsPreflight({ DEN_SKIP_SECRETS: "1" })).toBe(true);
    expect(shouldSkipSecretsPreflight({ DEN_SKIP_SECRETS: "true" })).toBe(true);
    expect(shouldSkipSecretsPreflight({ DEN_SKIP_SECRETS: "0" })).toBe(false);
    expect(shouldSkipSecretsPreflight({})).toBe(false);
  });

  it("invokes the backend-agnostic setup-secrets gate via local tsx", () => {
    const inv = buildSecretsPreflightInvocation("/den", "darwin");
    expect(inv.command).toBe(path.join("/den", "node_modules", ".bin", "tsx"));
    expect(inv.args).toEqual([
      path.join("/den", "scripts", "setup-secrets.ts"),
      "--gate",
    ]);
    expect(buildSecretsPreflightInvocation("/den", "win32").command).toMatch(
      /tsx\.cmd$/,
    );
  });

  it("returns on status 0 and throws a remediation on failure", () => {
    const ok = jest.fn(() => ({ status: 0 })) as never;
    expect(() =>
      preflightSecrets({ root: "/den", env: {}, spawnSyncImpl: ok }),
    ).not.toThrow();
    const bad = jest.fn(() => ({ status: 1 })) as never;
    expect(() =>
      preflightSecrets({ root: "/den", env: {}, spawnSyncImpl: bad }),
    ).toThrow(/make den-setup-secrets/);
  });

  it("does not spawn when skipped", () => {
    const spy = jest.fn(() => ({ status: 1 })) as never;
    preflightSecrets({
      env: { DEN_SKIP_SECRETS: "1" },
      spawnSyncImpl: spy,
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
