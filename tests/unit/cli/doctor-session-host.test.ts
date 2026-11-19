/**
 * Doctor says where the browser sign-in lives. With a working https
 * address (web.url, through the edge) the session cookie lives only there.
 * Without one, it lives on the host the person uses, and browsers share a
 * host's cookies across ports: doctor says other apps on that host could
 * see it, and to set up the https address. So does the web row, where the
 * address is shown. Invented addresses only.
 */
import { describe, expect, it } from "@jest/globals";
import { sessionHostLines } from "../../../src/ui/cli/doctor-command.js";
import {
  onboardingChecks,
  type OnboardDeps,
} from "../../../src/ui/cli/doctor-onboard.js";

const RISK = /other apps .*could see/;

describe("doctor: where the sign-in lives", () => {
  it("a working https address: ok, and named", () => {
    const r = sessionHostLines(
      { url: "https://den.example.com", confirmed: true },
      true,
      "Acme",
      "acme",
    );
    expect(r.check).toMatchObject({ id: "signin_host", status: "ok" });
    expect(r.check.detail).toContain("https://den.example.com");
    expect(r.check.detail).not.toMatch(RISK);
    expect(r.lines.join("\n")).toContain(r.check.detail);
  });

  it("no address, an http one, or an https one that doesn't work yet: a warning naming the risk and the fix", () => {
    for (const [w, works] of [
      [null, false],
      [{ url: "http://den.example.com", confirmed: true }, false],
      [{ url: "https://den.example.com", confirmed: true }, false],
    ] as const) {
      const r = sessionHostLines(w, works, "Acme", "acme");
      expect(r.check).toMatchObject({ id: "signin_host", status: "warn" });
      expect(r.check.detail).toMatch(RISK);
      expect(r.check.detail).toMatch(/https address/);
      expect(r.check.detail).toMatch(/acme web url https:\/\//);
      expect(r.lines.join("\n")).toContain(r.check.detail);
    }
  });
});

describe("the web row, where the address is shown", () => {
  const deps = (address: string | null): OnboardDeps => ({
    nodeVersion: "24.1.0",
    platform: "linux",
    which: () => true,
    dockerRepos: () => [],
    dockerUp: () => true,
    webUrl: "http://localhost:4100",
    address: () => address,
    probeWeb: async () => ({ kind: "up", version: "0.0.0" }),
    mcpCall: () => ({ ok: true }),
    approvals: () => true,
    bin: "./bin/acme",
  });
  const web = async (address: string | null) =>
    (await onboardingChecks(deps(address))).find((c) => c.id === "web")!;

  it("an http address, or none: the row names the risk", async () => {
    for (const a of [null, "http://den.example.com"])
      expect((await web(a)).detail).toMatch(RISK);
  });
  it("an https address: no such words", async () => {
    expect((await web("https://den.example.com")).detail).not.toMatch(RISK);
  });
});
