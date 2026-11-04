import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  envName,
  loadProfile,
  profileFrom,
  readEnv,
  resetProfileCache,
} from "../../../src/shared/profile.js";

const home = os.homedir();

describe("profileFrom", () => {
  it("derives every product name from the name alone", () => {
    expect(profileFrom({ name: "den" })).toEqual({
      name: "den",
      cli: "den",
      envPrefix: "DEN",
      configFile: "config/den.yml",
      manifestFiles: [".den.yml", ".den.json"],
      stateDir: path.join(home, ".den"),
      servicesDir: ".den-services",
      workspacesDir: "den-workspaces",
    });
  });

  it("runs under Den's own name with no profile", () => {
    const p = profileFrom();
    expect([p.name, p.cli, p.envPrefix, p.configFile]).toEqual([
      "den",
      "den",
      "DEN",
      "config/den.yml",
    ]);
    expect(p.manifestFiles).toEqual([".den.yml", ".den.json"]);
  });

  it("takes explicit fields over the derived ones", () => {
    const p = profileFrom({
      name: "acme",
      env_prefix: "ACME_DEV",
      state_dir: "~/.local/state/acme",
      manifest: ".acme.yaml",
    });
    expect(p.envPrefix).toBe("ACME_DEV");
    expect(p.stateDir).toBe(path.join(home, ".local/state/acme"));
    expect(p.manifestFiles).toEqual([".acme.yaml", ".acme.json"]);
    expect(p.servicesDir).toBe(".acme-services");
  });

  it("refuses names that cannot be a slug or an env prefix", () => {
    expect(() => profileFrom({ name: "Field Kit" })).toThrow(/product\.name/);
    expect(() => profileFrom({ name: "x", env_prefix: "x-y" })).toThrow(
      /env_prefix/,
    );
  });
});

describe("loadProfile", () => {
  const tmp: string[] = [];
  const OLD = process.env.DEN_PROFILE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.DEN_PROFILE;
    else process.env.DEN_PROFILE = OLD;
    resetProfileCache();
    while (tmp.length) fs.rmSync(tmp.pop()!, { recursive: true, force: true });
  });
  const dir = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-profile-"));
    tmp.push(d);
    return d;
  };

  it("reads den.yml at the distribution root, else Den's own", () => {
    delete process.env.DEN_PROFILE;
    const root = dir();
    expect(loadProfile(root).name).toBe("den");
    resetProfileCache();
    fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: acme\n");
    expect(loadProfile(root).name).toBe("acme");
  });

  it("DEN_PROFILE points at another profile file", () => {
    const root = dir();
    const other = path.join(dir(), "p.yml");
    fs.writeFileSync(other, "product:\n  name: den\n");
    process.env.DEN_PROFILE = other;
    expect(loadProfile(root).name).toBe("den");
  });
});

describe("env helpers", () => {
  it("prefix the key with the profile's env prefix", () => {
    const p = profileFrom({ name: "acme" });
    expect(envName(p, "ALLOW_PROD")).toBe("ACME_ALLOW_PROD");
    expect(readEnv(p, "ALLOW_PROD", { ACME_ALLOW_PROD: "1" })).toBe("1");
    expect(readEnv(p, "ALLOW_PROD", { DEN_ALLOW_PROD: "1" })).toBeUndefined();
  });
});
