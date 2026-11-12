/**
 * AG-DROP-2: agents.files.deny, globs below an agent's roots that are never
 * a link or a download. A glob without `/` matches any one part; with `/`
 * the whole path below the root. The list replaces the defaults.
 */
import { describe, expect, it } from "@jest/globals";
import {
  denied,
  filesBlock,
  FILE_DENY_DEFAULTS,
} from "../../../src/shared/agents/file-deny.js";
import { readAgentsConfig } from "../../../src/shared/den-config.js";

describe("agents.files.deny (AG-DROP-2)", () => {
  it("the defaults: env files and keys, anywhere below the root", () => {
    for (const rel of [
      ".env",
      "app/.env",
      "app/.env.production",
      "certs/a.pem",
      "tls.key",
      "store.p12",
      "deploy/id_rsa",
      "deploy/id_ed25519.pub",
      ".env/inner.txt",
      // Any case: macOS opens .ENV as .env.
      "APP/.ENV",
      "certs/A.PEM",
      "ID_RSA",
    ])
      expect([rel, denied(rel, FILE_DENY_DEFAULTS)]).toEqual([rel, true]);
    for (const rel of [
      "env.ts",
      "src/id_utils.ts",
      "keys.md",
      "a.pem.md",
      "docs/environment.md",
    ])
      expect([rel, denied(rel, FILE_DENY_DEFAULTS)]).toEqual([rel, false]);
  });

  it("a glob with / is the whole path; * stays in one part; ** spans parts", () => {
    expect(denied("config/secrets/db.yml", ["config/secrets/**"])).toBe(true);
    expect(denied("config/secrets", ["config/secrets/**"])).toBe(false);
    expect(denied("x/config/secrets/db.yml", ["config/secrets/**"])).toBe(
      false,
    );
    expect(denied("a/b/c.txt", ["a/*.txt"])).toBe(false);
    expect(denied("a/c.txt", ["a/*.txt"])).toBe(true);
    expect(denied("a/b/c.txt", ["a/**/c.txt"])).toBe(true);
    expect(denied("a/c.txt", ["a/**/c.txt"])).toBe(true);
    expect(denied("a.b", ["a?b"])).toBe(true);
    expect(denied("a/b", ["a?b"])).toBe(false);
    expect(denied("x+y(1).txt", ["x+y(1).txt"])).toBe(true);
    expect(denied("anything", [])).toBe(false);
  });

  it("config: unset is the defaults; a list replaces them; [] turns it off; a bad value names its key", () => {
    expect(filesBlock(undefined).deny).toEqual([...FILE_DENY_DEFAULTS]);
    expect(filesBlock({ deny: ["*.secret"] }).deny).toEqual(["*.secret"]);
    expect(filesBlock({ deny: [] }).deny).toEqual([]);
    expect(() => filesBlock({ deny: "*.pem" })).toThrow(/agents\.files\.deny/);
    expect(() => filesBlock({ deny: [""] })).toThrow(/agents\.files\.deny/);
    expect(() => filesBlock({ allow: [] })).toThrow(/agents\.files\.allow/);
    expect(() => filesBlock(["x"])).toThrow(/agents\.files:/);
    const c = readAgentsConfig({
      environments: [],
      agents: { files: { deny: [".env", "*.pem", "vault/**"] } },
    } as never);
    expect(c.files?.deny).toEqual([".env", "*.pem", "vault/**"]);
    expect(c.agents).not.toHaveProperty("files");
    expect(readAgentsConfig({ environments: [] } as never).files?.deny).toEqual(
      [...FILE_DENY_DEFAULTS],
    );
  });
});
