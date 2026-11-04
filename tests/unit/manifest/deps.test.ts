import { describe, expect, it } from "@jest/globals";
import { depService, normalizeDep } from "../../../src/shared/manifest/deps.js";

describe("depService", () => {
  it("returns the bare string for the string form", () => {
    expect(depService("shop/db")).toBe("shop/db");
  });

  it("returns the service field for the object form", () => {
    expect(depService({ service: "shop/db", wait: true })).toBe("shop/db");
  });

  it("returns the service field when wait is omitted", () => {
    expect(depService({ service: "tasks-runner" })).toBe("tasks-runner");
  });
});

describe("normalizeDep", () => {
  it("defaults wait to false for string form", () => {
    expect(normalizeDep("shop/db")).toEqual({
      service: "shop/db",
      wait: false,
    });
  });

  it("defaults wait to false when object omits it", () => {
    expect(normalizeDep({ service: "shop/db" })).toEqual({
      service: "shop/db",
      wait: false,
    });
  });

  it("preserves wait: true", () => {
    expect(normalizeDep({ service: "shop/db", wait: true })).toEqual({
      service: "shop/db",
      wait: true,
    });
  });

  it("preserves explicit wait: false", () => {
    expect(normalizeDep({ service: "shop/db", wait: false })).toEqual({
      service: "shop/db",
      wait: false,
    });
  });
});
