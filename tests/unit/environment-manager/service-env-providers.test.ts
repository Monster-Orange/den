import { describe, it, expect } from "@jest/globals";
import { serviceEnvProviderRepos } from "../../../src/shared/environment-manager/service-env.js";

describe("serviceEnvProviderRepos", () => {
  it("has no built-in providers", () => {
    expect([...serviceEnvProviderRepos(() => ({}))]).toEqual([]);
  });

  it("derives providers from config", () => {
    const providers = serviceEnvProviderRepos(() => ({
      service_env: {
        SHARED_SECRETS_FILE: "{repo:infra}/.secrets.yml",
        OTHER_FILE: "{repo:some-repo}/x.yml",
      },
    }));
    expect([...providers].sort()).toEqual(["infra", "some-repo"]);
  });

  it("ignores an entry with an empty template", () => {
    expect([
      ...serviceEnvProviderRepos(() => ({
        service_env: { SHARED_SECRETS_FILE: "" },
      })),
    ]).toEqual([]);
  });

  it("handles multiple tokens in one template", () => {
    const providers = serviceEnvProviderRepos(() => ({
      service_env: { X: "{repo:a}/{repo:b}/f" },
    }));
    expect([...providers].sort()).toEqual(["a", "b"]);
  });

  it("degrades to empty when config cannot be read", () => {
    expect([
      ...serviceEnvProviderRepos(() => {
        throw new Error("boom");
      }),
    ]).toEqual([]);
  });
});
