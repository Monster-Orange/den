import { describe, expect, it } from "@jest/globals";
import {
  mergeOverride,
  overrideKeyErrors,
} from "../../../src/shared/manifest/merge-override.js";

const base = {
  name: "shop",
  entrypoint: "web",
  services: {
    web: {
      depends_on: ["shop/api"],
      commands: { local: { up: "make up", down: "make down" } },
      urls: { local: "https://shop.example.com" },
    },
    api: {
      commands: { local: { up: "make api" } },
    },
  },
};

describe("mergeOverride", () => {
  it("merges maps by key, recursively", () => {
    const merged = mergeOverride(base, {
      services: { web: { commands: { local: { up: "make up-fast" } } } },
    });
    expect(merged.services).toEqual({
      web: {
        depends_on: ["shop/api"],
        commands: { local: { up: "make up-fast", down: "make down" } },
        urls: { local: "https://shop.example.com" },
      },
      api: { commands: { local: { up: "make api" } } },
    });
  });

  it("replaces lists whole", () => {
    const merged = mergeOverride(base, {
      services: { web: { depends_on: [] } },
    });
    expect(
      (merged.services as Record<string, { depends_on: unknown }>).web
        .depends_on,
    ).toEqual([]);
  });

  it("replaces scalars", () => {
    expect(mergeOverride(base, { entrypoint: "api" }).entrypoint).toBe("api");
  });

  it("deletes a key the override sets to null", () => {
    const merged = mergeOverride(base, {
      entrypoint: null,
      services: { web: { urls: null } },
    });
    expect("entrypoint" in merged).toBe(false);
    expect("urls" in (merged.services as Record<string, object>).web).toBe(
      false,
    );
  });

  it("never changes its inputs", () => {
    const snapshot = JSON.stringify(base);
    mergeOverride(base, { services: { web: { urls: null } } });
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe("overrideKeyErrors", () => {
  it("accepts an override that only names keys the base has", () => {
    expect(
      overrideKeyErrors(base, {
        services: { web: { commands: { local: { up: "x" } }, urls: null } },
      }),
    ).toEqual([]);
  });

  it("names an unknown service by its path", () => {
    expect(overrideKeyErrors(base, { services: { worker: {} } })).toEqual([
      expect.objectContaining({ path: "services.worker" }),
    ]);
  });

  it("names an unknown key by its full path", () => {
    expect(
      overrideKeyErrors(base, {
        services: { api: { commands: { local: { down: "make stop" } } } },
      }),
    ).toEqual([
      expect.objectContaining({ path: "services.api.commands.local.down" }),
    ]);
  });
});
