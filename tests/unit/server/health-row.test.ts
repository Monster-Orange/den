/**
 * A /api/health row's `url` is a URL or null: a shell health check (a compose
 * stack's `<cli> stack health …`, or any declared shell check) goes in
 * `check`, so agents never read a command as a URL.
 */
import { describe, expect, it } from "@jest/globals";
import { healthCheckFields } from "../../../src/ui/server/health-row.js";

describe("healthCheckFields", () => {
  it("an HTTP check's target is the row's url", () => {
    expect(healthCheckFields("http", "http://shop-api/healthz")).toEqual({
      url: "http://shop-api/healthz",
    });
  });

  it("a shell check's command goes in check, never url", () => {
    const cmd = `"/opt/acme/bin/acme" stack health shop -w default --service "backend"`;
    expect(healthCheckFields("shell", cmd)).toEqual({ url: null, check: cmd });
  });

  it("no check: no url", () => {
    expect(healthCheckFields("none", "")).toEqual({ url: null });
  });
});
