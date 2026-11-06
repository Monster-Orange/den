/**
 * WS-6.3: whether a service runs, so stopped and down differ: a failing
 * check alone is stopped; with a daemon record, or compose containers
 * found, it is down.
 */
import { describe, expect, it } from "@jest/globals";
import {
  isRunning,
  trackedAddresses,
} from "../../../src/shared/environment-manager/running.js";

describe("isRunning (WS-6.3)", () => {
  const tracked = trackedAddresses([
    { address: "notes", repoName: "notes", subsystem: "web" },
  ]);

  it("runs when its check answers up", () => {
    expect(isRunning({ repo: "a", service: "a", ok: true }, new Set())).toBe(
      true,
    );
  });

  it("a failing check with no record is stopped", () => {
    expect(
      isRunning(
        { repo: "a", service: "a", ok: false, error: "ECONNREFUSED" },
        tracked,
      ),
    ).toBe(false);
    expect(isRunning({ repo: "a", service: "a", ok: null }, tracked)).toBe(
      false,
    );
  });

  it("a failing check Den still tracks is running (down), in either spelling", () => {
    expect(
      isRunning({ repo: "notes", service: "web", ok: false }, tracked),
    ).toBe(true);
    expect(
      isRunning({ repo: "notes", service: "notes", ok: false }, tracked),
    ).toBe(true);
  });

  it("compose containers found but unhealthy run; none found is stopped", () => {
    expect(
      isRunning(
        {
          repo: "db",
          service: "db",
          ok: false,
          error: "db\texited\tExited (1)",
        },
        new Set(),
      ),
    ).toBe(true);
    expect(
      isRunning(
        { repo: "db", service: "db", ok: false, error: "not running" },
        new Set(),
      ),
    ).toBe(false);
  });
});
