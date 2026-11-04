/**
 * Secret redaction (src/shared/redact.ts): the literal-value helpers the
 * journeys and security pillars use, and the secret-SHAPED patterns the MCP
 * server applies to every log line it returns. One case per pattern.
 */
import { describe, expect, it } from "@jest/globals";
import {
  REDACTED,
  containsValue,
  redactSecrets,
  redactValues,
} from "../../../src/shared/redact.js";

describe("redactValues / containsValue (known live values)", () => {
  it("replaces every occurrence of each value", () => {
    expect(redactValues("a s3cr3t b s3cr3t", ["s3cr3t"])).toBe(
      `a ${REDACTED} b ${REDACTED}`,
    );
  });
  it("ignores empty and undefined values (they would match everything)", () => {
    expect(redactValues("abc", ["", undefined])).toBe("abc");
    expect(containsValue("abc", ["", undefined])).toBe(false);
  });
  it("reports whether any value is present", () => {
    expect(containsValue("xx tok yy", ["tok"])).toBe(true);
    expect(containsValue("xx yy", ["tok"])).toBe(false);
  });
});

describe("redactSecrets (secret-shaped values)", () => {
  it("bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abcDEF123456.xyz-_~+/=");
    expect(out).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it("JWTs anywhere in text", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzYW0ifQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU";
    const out = redactSecrets(`got cookie id=${jwt}; path=/`);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toContain(REDACTED);
  });

  it("AWS access key ids", () => {
    const out = redactSecrets("using AKIAIOSFODNN7EXAMPLE for s3");
    expect(out).toBe(`using ${REDACTED} for s3`);
    expect(redactSecrets("ASIAABCDEFGHIJKLMNOP")).toBe(REDACTED);
  });

  it("AWS secret keys in key=value form", () => {
    const out = redactSecrets(
      "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );
    expect(out).toBe(`aws_secret_access_key=${REDACTED}`);
  });

  it("DSNs and URLs with credentials keep the user, drop the password", () => {
    expect(
      redactSecrets("db at postgres://app:hunter2@db.example.com:5432/shop"),
    ).toBe(`db at postgres://app:${REDACTED}@db.example.com:5432/shop`);
    expect(redactSecrets("GET https://user:pa55@api.example.com/x")).toBe(
      `GET https://user:${REDACTED}@api.example.com/x`,
    );
    // A URL with no credentials is untouched.
    expect(redactSecrets("https://api.example.com/x?y=1")).toBe(
      "https://api.example.com/x?y=1",
    );
  });

  it("key=value and key: value secrets, quoted or not", () => {
    expect(redactSecrets("PASSWORD=hunter2 next")).toBe(
      `PASSWORD=${REDACTED} next`,
    );
    expect(redactSecrets("client_secret: abc123")).toBe(
      `client_secret: ${REDACTED}`,
    );
    expect(redactSecrets('{"api_key": "abc123", "n": 1}')).toBe(
      `{"api_key": "${REDACTED}", "n": 1}`,
    );
    expect(redactSecrets("x-api-key: k-123")).toBe(`x-api-key: ${REDACTED}`);
    expect(redactSecrets("?access_token=abc&x=1")).toBe(
      `?access_token=${REDACTED}&x=1`,
    );
    // Ordinary key=value pairs survive.
    expect(redactSecrets("status=200 user=sam")).toBe("status=200 user=sam");
  });

  it("well-known token prefixes", () => {
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(REDACTED);
    expect(redactSecrets("token xoxb-1234567890-abcdefghij")).toContain(
      REDACTED,
    );
    expect(redactSecrets("sk_live_abcdefghijklmnop1234")).toBe(REDACTED);
  });

  it("private-key blocks, whole or cut off", () => {
    const block = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA1234",
      "abcd",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactSecrets(`before\n${block}\nafter`);
    expect(out).toBe(
      `before\n-----BEGIN RSA PRIVATE KEY-----${REDACTED}-----END RSA PRIVATE KEY-----\nafter`,
    );
    const cut = redactSecrets("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN");
    expect(cut).toBe(`-----BEGIN PRIVATE KEY-----${REDACTED}`);
  });

  it("is idempotent", () => {
    const once = redactSecrets("PASSWORD=x Bearer abcdefghijkl");
    expect(redactSecrets(once)).toBe(once);
  });
});
