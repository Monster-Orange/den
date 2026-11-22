/**
 * Issue 214 (T19, the guard): a scheduled production run sends only GET,
 * HEAD and OPTIONS, plus the org's write_allow pairs. Anything else is
 * blocked before it leaves, and logged.
 */
import { describe, expect, it } from "@jest/globals";
import {
  methodRules,
  allowedRequest,
  guardProbe,
  type RequestLog,
} from "../../../src/shared/verify/guard.js";

describe("methodRules", () => {
  it("production: GET, HEAD, OPTIONS; others: every method", () => {
    expect(methodRules(undefined, "production")).toEqual({
      methods: ["GET", "HEAD", "OPTIONS"],
      writeAllow: [],
    });
    expect(methodRules(undefined, "staging")).toEqual({ methods: "all", writeAllow: [] });
  });

  it("reads verify.environments.<env>.write_allow and methods", () => {
    const raw = {
      environments: {
        production: { write_allow: ["POST /login", "post  /api/session"] },
        staging: { methods: ["GET"] },
      },
    };
    expect(methodRules(raw, "production").writeAllow).toEqual([
      { method: "POST", path: "/login" },
      { method: "POST", path: "/api/session" },
    ]);
    expect(methodRules(raw, "staging").methods).toEqual(["GET"]);
  });

  it("a list of imported environments (issue 441) is not a map: defaults", () => {
    expect(methodRules({ environments: ["bed"] }, "production").methods).toEqual([
      "GET",
      "HEAD",
      "OPTIONS",
    ]);
  });

  it.each([["POST"], ["POST login"], ["FETCH /x"]])("refuses the pair %j", (p) => {
    expect(() =>
      methodRules({ environments: { production: { write_allow: [p] } } }, "production"),
    ).toThrow(/write_allow/);
  });
});

describe("allowedRequest", () => {
  const prod = methodRules(
    { environments: { production: { write_allow: ["POST /login"] } } },
    "production",
  );
  it.each([
    ["GET", "https://shop.example/health", true],
    ["HEAD", "https://shop.example/", true],
    ["OPTIONS", "https://shop.example/api", true],
    ["POST", "https://shop.example/login", true],
    ["POST", "https://shop.example/login?next=/", true],
    ["POST", "https://shop.example/orders", false],
    ["PUT", "https://shop.example/login", false],
    ["DELETE", "https://shop.example/health", false],
    ["POST", "https://shop.example/login/extra", false],
  ])("%s %s → %s", (method, url, ok) => {
    expect(allowedRequest(prod, method, url)).toBe(ok);
  });
});

describe("guardProbe", () => {
  it("passes allowed requests and logs each; a write is blocked before it leaves", async () => {
    const sent: string[] = [];
    const probe = async (url: string, method = "GET") => {
      sent.push(`${method} ${url}`);
      return 200;
    };
    const log: RequestLog[] = [];
    const g = guardProbe(probe, methodRules(undefined, "production"), log);
    await expect(g("https://shop.example/health")).resolves.toBe(200);
    await expect(g("https://shop.example/orders", "POST")).rejects.toThrow(
      /blocked: POST is not allowed on a read-only run/,
    );
    expect(sent).toEqual(["GET https://shop.example/health"]);
    expect(log).toEqual([
      { method: "GET", url: "https://shop.example/health", status: 200 },
      { method: "POST", url: "https://shop.example/orders", blocked: true },
    ]);
  });
});
