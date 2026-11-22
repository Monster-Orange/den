/**
 * Issue 991: a box run may declare a loopback host with any port
 * (`http://127.0.0.1:*`), because Den's own browser suites start their
 * server on a free port. Ports 80 and 443 stay refused, written out or
 * implied by the scheme, wildcard or not.
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

  it("allowedUrl: any port on that host but 80 and 443; no other host", () => {
    const allow = ["127.0.0.1:*"];
    expect(allowedUrl("http://127.0.0.1:4100/a", allow)).toBe(true);
    expect(allowedUrl("ws://127.0.0.1:51234/ws", allow)).toBe(true);
    for (const url of [
      "http://127.0.0.1:80/",
      "https://127.0.0.1:443/",
      "http://127.0.0.1/",
      "https://127.0.0.1/",
      "ws://127.0.0.1/",
      "http://localhost:4100/",
      "http://127.0.0.2:4100/",
    ])
      expect([url, allowedUrl(url, allow)]).toEqual([url, false]);
  });
});
