/**
 * Tests for the shared service-command env injection (buildServiceEnv).
 * The config reader and repo-path resolver are injected so these stay hermetic.
 */

import { describe, it, expect } from "@jest/globals";
import {
  buildServiceEnv,
  expandServiceEnvTemplate,
  DEFAULT_SERVICE_ENV,
} from "../../../src/shared/environment-manager/service-env.js";

const resolveTo = (map: Record<string, string>) => (name: string) =>
  map[name] ?? null;

describe("expandServiceEnvTemplate", () => {
  it("expands a {repo:<name>} placeholder to the resolved path", () => {
    const out = expandServiceEnvTemplate(
      "{repo:infra}/.secrets.yml",
      resolveTo({ infra: "/abs/infra" }),
    );
    expect(out).toBe("/abs/infra/.secrets.yml");
  });

  it("returns null when a placeholder can't be resolved", () => {
    const out = expandServiceEnvTemplate("{repo:missing}/x", resolveTo({}));
    expect(out).toBeNull();
  });

  it("passes through a template with no placeholders", () => {
    expect(expandServiceEnvTemplate("/literal/path", resolveTo({}))).toBe(
      "/literal/path",
    );
  });

  it("expands multiple placeholders", () => {
    const out = expandServiceEnvTemplate(
      "{repo:a}:{repo:b}",
      resolveTo({ a: "/A", b: "/B" }),
    );
    expect(out).toBe("/A:/B");
  });
});

describe("buildServiceEnv", () => {
  const resolve = resolveTo({ infra: "/repos/infra" });
  const config = () => ({
    service_env: { SHARED_SECRETS_FILE: "{repo:infra}/.secrets.yml" },
  });

  it("has no built-in entries", () => {
    expect(DEFAULT_SERVICE_ENV).toEqual({});
    expect(buildServiceEnv({}, resolve, () => ({}))).toEqual({});
  });

  it("resolves a config entry to the repo's path", () => {
    const env = buildServiceEnv({}, resolve, config);
    expect(env.SHARED_SECRETS_FILE).toBe("/repos/infra/.secrets.yml");
  });

  it("never overrides a value already set in the caller's env", () => {
    const env = buildServiceEnv(
      { SHARED_SECRETS_FILE: "/user/override" },
      resolve,
      config,
    );
    expect(env.SHARED_SECRETS_FILE).toBeUndefined();
  });

  it("skips a variable whose template can't be resolved", () => {
    const env = buildServiceEnv({}, resolveTo({}), config);
    expect(env.SHARED_SECRETS_FILE).toBeUndefined();
  });

  it("skips an entry with an empty template", () => {
    const env = buildServiceEnv({}, resolve, () => ({
      service_env: { SHARED_SECRETS_FILE: "" },
    }));
    expect(env.SHARED_SECRETS_FILE).toBeUndefined();
  });

  it("is best-effort — returns {} instead of throwing when config read fails", () => {
    const env = buildServiceEnv({}, resolve, () => {
      throw new Error("boom");
    });
    expect(env).toEqual({});
  });
});
