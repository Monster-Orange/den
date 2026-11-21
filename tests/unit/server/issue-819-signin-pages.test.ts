/**
 * Issue 819, without a browser: the page helpers the sign-in and Settings
 * pages use.
 *  - After a sign-in, the page lands only on a path of its own origin, by
 *    the server's own rules (web-session.ts safeNext): a `next` with a
 *    control character (`/%09/…` decodes to a tab, which a browser drops,
 *    leaving `//…`) never leaves the site.
 *  - Settings › Access never shows a waiting device's code: the person
 *    types the code that device's screen shows (one field: any case,
 *    spaces and dashes ignored; Approve at six characters), and a wrong
 *    code says so in the page's words.
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  landingAfterSignIn,
  safeLanding,
} from "../../../src/ui/server/public/error-page.js";
import {
  approveRefusal,
  pairCodeReady,
  typedPairCode,
  waitingLine,
} from "../../../src/ui/server/public/settings-registry.js";

const ORIGIN = "https://den.example.test";
const at = (pathname: string, search: string) => ({
  origin: ORIGIN,
  pathname,
  search,
  hash: "",
});

describe("item 3: the landing after a sign-in stays on this site", () => {
  it("next=/%09/elsewhere.example lands on /, from /signin and from /auth", () => {
    for (const p of ["/signin", "/auth"])
      expect(landingAfterSignIn(at(p, "?next=/%09/elsewhere.example"))).toBe("/");
  });

  it("other control characters, another origin, a backslash or the sign-in link itself: /", () => {
    for (const raw of [
      "/\t/elsewhere.example",
      "/\n/elsewhere.example",
      "/\r//elsewhere.example",
      "//elsewhere.example",
      "/\\elsewhere.example",
      "https://elsewhere.example/",
      "/auth?c=abc",
      "",
    ])
      expect([raw, safeLanding(raw, ORIGIN)]).toEqual([raw, "/"]);
  });

  it("a path on this site is kept, with its query and fragment", () => {
    expect(
      landingAfterSignIn(at("/signin", "?next=%2Fsettings%3Ftab%3Daccess")),
    ).toBe("/settings?tab=access");
    expect(safeLanding("/agents#north", ORIGIN)).toBe("/agents#north");
  });
});

describe("item 1: Settings › Access asks for the code, never shows it", () => {
  const w = {
    ref: "r".repeat(22),
    device: "Safari on macOS",
    client: "192.0.2.7",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() + 480_000).toISOString(),
    fromLink: true,
    fromLogin: new Date(Date.now() - 180_000).toISOString(),
  };

  it("a waiting line has no code, and says it came from a web login run", () => {
    const l = waitingLine({ ...w, code: "K7Q-42M" });
    expect(JSON.stringify(l)).not.toContain("K7Q");
    expect(l.detail).toMatch(/from the web login run at \d/);
    expect(l.detail).toMatch(/asked/);
  });

  it("the typed code: any case, spaces and dashes ignored; ready at six characters", () => {
    expect(typedPairCode(" k7q-42m ")).toBe("K7Q42M");
    expect(typedPairCode("k7q 42m")).toBe("K7Q42M");
    expect(pairCodeReady("k7q-42m")).toBe(true);
    expect(pairCodeReady("K7Q-42")).toBe(false);
    expect(pairCodeReady("K7Q-42MM")).toBe(false);
  });

  it("a wrong code, too many tries, or a request that ended: said in the page's words", () => {
    expect(approveRefusal({ code: "wrong", message: "x" })).toMatch(
      /doesn't match the one on that computer's screen/,
    );
    expect(approveRefusal({ code: "rate_limited", message: "x" })).toMatch(
      /Too many tries/,
    );
    expect(approveRefusal({ code: "expired", message: "x" })).toMatch(
      /ended or expired/,
    );
  });
});
