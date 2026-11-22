/**
 * Issue 991: a box run may declare a loopback host with any port
 * (`http://127.0.0.1:*`), because Den's own browser suites start their
 * server on a free port. The wildcard covers only the ports the run opened
 * itself (`ownPorts`); with none known it covers nothing. Ports 80 and 443
 * stay refused, written out or implied by the scheme, wildcard or not.
 */
import { describe, expect, it } from "@jest/globals";
import {
  allowOf,
  allowedUrl,
  checkBaseUrl,
} from "../../../src/shared/gates/pw-guard.js";

describe("issue 991: a loopback host with any port", () => {
  it("checkBaseUrl takes host:* on loopback only", () => {
    expect(checkBaseUrl("http://127.0.0.1:*")).toBeNull();
    expect(checkBaseUrl("http://localhost:*")).toBeNull();
    expect(checkBaseUrl("http://den.localhost:*/")).toBeNull();
    expect(checkBaseUrl("http://example.com:*")).toMatch(/loopback/);
    expect(checkBaseUrl("ftp://127.0.0.1:*")).toMatch(/http or https/);
    expect(checkBaseUrl("http://127.0.0.1:*80")).not.toBeNull();
  });

  it("allowOf keeps the wildcard", () => {
    expect(allowOf("http://127.0.0.1:*")).toBe("127.0.0.1:*");
    expect(allowOf("http://Den.localhost:*/x")).toBe("den.localhost:*");
  });

  it("allowedUrl: host:* covers only the run's own ports, never 80 or 443; no other host", () => {
    const allow = ["127.0.0.1:*"];
    const own = new Set([4100, 51234, 80, 443]);
    expect(allowedUrl("http://127.0.0.1:4100/a", allow, own)).toBe(true);
    expect(allowedUrl("ws://127.0.0.1:51234/ws", allow, own)).toBe(true);
    // A loopback port the run didn't open: another service on this machine.
    expect(allowedUrl("http://127.0.0.1:5432/", allow, own)).toBe(false);
    // No own ports known: the wildcard covers nothing.
    expect(allowedUrl("http://127.0.0.1:4100/a", allow)).toBe(false);
    expect(allowedUrl("http://127.0.0.1:4100/a", allow, new Set())).toBe(false);
    // An explicit host:port needs no own ports.
    expect(allowedUrl("http://127.0.0.1:4100/a", ["127.0.0.1:4100"])).toBe(
      true,
    );
    for (const url of [
      "http://127.0.0.1:80/",
      "https://127.0.0.1:443/",
      "http://127.0.0.1/",
      "https://127.0.0.1/",
      "ws://127.0.0.1/",
      "http://localhost:4100/",
      "http://127.0.0.2:4100/",
    ])
      expect([url, allowedUrl(url, allow, own)]).toEqual([url, false]);
  });
});
