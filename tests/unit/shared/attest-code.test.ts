/**
 * D17 fix A: the "This is my computer" code. Bound to its edge host and to
 * web.secret, short-lived, its own context (never a login or claim code);
 * `return` only to this server's own edge hosts.
 */
import { describe, expect, it } from "@jest/globals";
import { randomBytes } from "crypto";
import {
  ATTEST_CODE_TTL_MS,
  attestRedirect,
  attestReturn,
  checkAttestCode,
  mintAttestCode,
} from "../../../src/shared/attest-code.js";
import { checkClaimCode } from "../../../src/shared/claim-code.js";
import { checkLoginCode } from "../../../src/shared/web-session.js";

const secret = randomBytes(32);
const T0 = 1_800_000_000_000;
const HOST = "den.local.example.com";

describe("the attest code", () => {
  it("checks for its own host and secret, inside its time", () => {
    const c = mintAttestCode(secret, HOST, T0);
    expect(checkAttestCode(c, secret, HOST, T0 + 1000)).toMatchObject({
      ok: true,
      expiresAt: T0 + ATTEST_CODE_TTL_MS,
    });
    // The host is compared case-insensitively.
    expect(checkAttestCode(c, secret, HOST.toUpperCase(), T0).ok).toBe(true);
  });

  it("fails on another host, another secret, after its time, or far ahead of the clock", () => {
    const c = mintAttestCode(secret, HOST, T0);
    expect(checkAttestCode(c, secret, "den.other.example.com", T0)).toEqual({
      ok: false,
      reason: "bad_mac",
    });
    expect(checkAttestCode(c, randomBytes(32), HOST, T0)).toEqual({
      ok: false,
      reason: "bad_mac",
    });
    expect(checkAttestCode(c, secret, HOST, T0 + ATTEST_CODE_TTL_MS)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(checkAttestCode(c, secret, HOST, T0 - 60 * 60_000)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(checkAttestCode("a1.x", secret, HOST, T0)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("is never a login or a claim code", () => {
    const c = mintAttestCode(secret, HOST, T0);
    expect(checkLoginCode(c, secret, T0).ok).toBe(false);
    expect(checkClaimCode(c, secret, T0).ok).toBe(false);
  });
});

describe("return", () => {
  const hosts = [HOST, "den.vpn.example.net"];
  it("is one of the edge hosts: its origin, host and path", () => {
    expect(attestReturn(`https://${HOST}/settings?x=1#frag`, hosts)).toEqual({
      origin: `https://${HOST}`,
      host: HOST,
      next: "/settings?x=1",
    });
    expect(attestReturn(`https://${HOST}:8443/`, hosts)?.origin).toBe(
      `https://${HOST}:8443`,
    );
    // Back to /auth would loop: the page goes to / instead.
    expect(attestReturn(`https://${HOST}/auth?c=x`, hosts)?.next).toBe("/");
  });

  it.each([
    "https://evil.example/",
    `https://${HOST}.evil.example/`,
    `https://u:p@${HOST}/`,
    `ftp://${HOST}/`,
    "/settings",
    "not a url",
    null,
  ])("refuses %s", (raw) => {
    expect(attestReturn(raw, hosts)).toBeNull();
  });

  it("the redirect carries the code in the fragment only", () => {
    expect(
      attestRedirect(
        { origin: `https://${HOST}`, next: "/settings" },
        "a1.b.c.d",
      ),
    ).toBe(`https://${HOST}/settings#den-attest=a1.b.c.d`);
  });
});
