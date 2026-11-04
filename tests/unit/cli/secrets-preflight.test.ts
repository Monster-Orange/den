import { describe, it, expect, jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
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

  it("runs the engine's setup-secrets gate with tsx, from the distribution root", () => {
    // A distribution: Den installed under node_modules, tsx hoisted beside it.
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "den-preflight-"));
    const engine = path.join(dist, "node_modules", "@monster-orange", "den");
    const bin = path.join(dist, "node_modules", ".bin");
    fs.mkdirSync(engine, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "tsx"), "");
    fs.writeFileSync(path.join(bin, "tsx.cmd"), "");
    try {
      const inv = buildSecretsPreflightInvocation(dist, "darwin", engine);
      expect(inv.command).toBe(path.join(bin, "tsx"));
      expect(inv.args).toEqual([
        path.join(engine, "scripts", "setup-secrets.ts"),
        "--gate",
      ]);
      expect(inv.cwd).toBe(dist);
      expect(
        buildSecretsPreflightInvocation(dist, "win32", engine).command,
      ).toMatch(/tsx\.cmd$/);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
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
