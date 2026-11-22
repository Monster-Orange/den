/**
 * Issue 394, review point 1: browsers refuse a keepalive fetch or a beacon
 * whose body is over 64 KB, while the server's cap is higher. A save that
 * big goes as a plain fetch (as it did before saveShell), never keepalive
 * or a beacon; a small one still uses keepalive.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  KEEPALIVE_MAX_BYTES,
  saveShell,
} from "../../../packages/den-ui/src/save-shell.js";

type Call = { url: string; init: RequestInit };
const g = globalThis as unknown as {
  fetch?: unknown;
  navigator?: unknown;
};
const was = { fetch: g.fetch, navigator: g.navigator };

afterEach(() => {
  g.fetch = was.fetch;
  Object.defineProperty(globalThis, "navigator", {
    value: was.navigator,
    configurable: true,
    writable: true,
  });
});

function stub(): { calls: Call[]; beacons: number } {
  const seen = { calls: [] as Call[], beacons: 0 };
  g.fetch = (url: string, init: RequestInit) => {
    // A browser throws on a keepalive body over 64 KB.
    const size = new TextEncoder().encode(String(init.body)).length;
    if (init.keepalive && size > 64 * 1024)
      return Promise.reject(new TypeError("Failed to fetch"));
    seen.calls.push({ url, init });
    return Promise.resolve({ ok: true });
  };
  Object.defineProperty(globalThis, "navigator", {
    value: {
      sendBeacon: () => {
        seen.beacons += 1;
        return true;
      },
    },
    configurable: true,
    writable: true,
  });
  return seen;
}

describe("saveShell's body size", () => {
  it("keeps keepalive's limit: 64 KB", () => {
    expect(KEEPALIVE_MAX_BYTES).toBe(64 * 1024);
  });

  it("a save over 64 KB goes as a plain fetch, and is saved", async () => {
    const seen = stub();
    const order = Array.from({ length: 9000 }, (_, i) => `project-${i}`);
    expect(await saveShell("/api/settings/shell", { order })).toBe(true);
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].init.keepalive).not.toBe(true);
    expect(seen.beacons).toBe(0);
  });

  it("a small save still goes with keepalive", async () => {
    const seen = stub();
    expect(await saveShell("/api/settings/shell", { pins: ["shop"] })).toBe(
      true,
    );
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].init.keepalive).toBe(true);
  });
});
