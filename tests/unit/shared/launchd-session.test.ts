/**
 * D20: which launchd session a process runs in (`launchctl managername`),
 * and what that means for it: a process in the desktop login session
 * (Aqua) ends when the person logs out; one outside it (Background) keeps
 * running but has no login keychain and no GUI.
 */
import { describe, expect, it } from "@jest/globals";
import {
  endsAtLogout,
  readLaunchdSession,
  sessionWarning,
  webUpWarning,
} from "../../../src/shared/launchd-session.js";

const ran =
  (stdout: string, status = 0) =>
  () => ({ status, stdout });

describe("readLaunchdSession", () => {
  it("is launchctl managername's answer, trimmed", () => {
    expect(readLaunchdSession(ran("Aqua\n"), "darwin")).toBe("Aqua");
    expect(readLaunchdSession(ran("Background\n"), "darwin")).toBe(
      "Background",
    );
  });

  it("is unknown when launchctl fails or says nothing", () => {
    expect(readLaunchdSession(ran("", 127), "darwin")).toBe("unknown");
    expect(readLaunchdSession(ran("  \n"), "darwin")).toBe("unknown");
    expect(
      readLaunchdSession(() => {
        throw new Error("ENOENT");
      }, "darwin"),
    ).toBe("unknown");
  });

  it("is null off macOS, without running anything", () => {
    let calls = 0;
    expect(
      readLaunchdSession(() => {
        calls++;
        return { status: 0, stdout: "Aqua" };
      }, "linux"),
    ).toBeNull();
    expect(calls).toBe(0);
  });

  it("never passes on an odd answer as-is", () => {
    expect(readLaunchdSession(ran("Aqua; rm -rf /\n"), "darwin")).toBe(
      "unknown",
    );
  });
});

describe("endsAtLogout", () => {
  it("is true only in the desktop login session", () => {
    expect(endsAtLogout("Aqua")).toBe(true);
    expect(endsAtLogout("LoginWindow")).toBe(true);
    expect(endsAtLogout("Background")).toBe(false);
    expect(endsAtLogout("System")).toBe(false);
    expect(endsAtLogout("unknown")).toBe(false);
    expect(endsAtLogout(null)).toBe(false);
  });
});

describe("sessionWarning", () => {
  it("names the fix for a session that ends at logout", () => {
    const w = sessionWarning("Aqua", "acme", "host");
    expect(w).toMatch(/stops? when you log out/);
    expect(w).toContain("acme service install --mode always");
  });

  it("says what a session outside the desktop lacks", () => {
    const w = sessionWarning("Background", "acme", "host");
    expect(w).toMatch(/keeps running after logout/);
    expect(w).toMatch(/login keychain/);
  });

  it("says nothing off macOS or when unknown", () => {
    expect(sessionWarning(null, "acme", "host")).toBeNull();
    expect(sessionWarning("unknown", "acme", "host")).toBeNull();
  });
});

describe("webUpWarning", () => {
  it("warns from a shell outside the desktop session, naming the service", () => {
    const w = webUpWarning("Background", "acme");
    expect(w).toMatch(/outside the desktop session \(Background, e\.g\. ssh\)/);
    expect(w).toContain("acme service install --mode always");
  });
  it("says nothing in the desktop session or off macOS", () => {
    expect(webUpWarning("Aqua", "acme")).toBeNull();
    expect(webUpWarning(null, "acme")).toBeNull();
    expect(webUpWarning("unknown", "acme")).toBeNull();
  });
});
