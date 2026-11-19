/**
 * Where the session cookie lives (session-cookie.ts, named-address.ts).
 *
 * Browsers share a host's cookies across its ports: a cookie set on
 * localhost reaches every other app the person opens on localhost. So the
 * session cookie lives on Den's own named https address when one works:
 * host-only (no Domain), Secure, `__Host-` prefixed. A loopback name gets
 * no session then. An install with no working https address keeps a
 * host-only cookie on the one host the person uses (no lockout).
 */
import { describe, expect, it } from "@jest/globals";
import {
  clearSessionCookies,
  readSessionCookie,
  sessionCookieNames,
  sessionSetCookie,
} from "../../../src/ui/server/session-cookie.js";
import {
  NamedAddressWatch,
  type NamedAnswer,
} from "../../../src/ui/server/named-address.js";
import {
  ADDRESS_CHECK_LIMITS,
  addressCheckSettings,
} from "../../../src/shared/edge/address-check.js";

const PORT = 41236;
const flags = (line: string) =>
  line
    .split(";")
    .slice(1)
    .map((f) => f.trim().split("=")[0].toLowerCase())
    .sort();

describe("the Set-Cookie line", () => {
  it("on the named https address: __Host- prefixed, host-only, Secure, Path=/", () => {
    const line = sessionSetCookie(PORT, "id1", true);
    expect(line.startsWith(`__Host-den_session_${PORT}=id1;`)).toBe(true);
    expect(flags(line)).toEqual([
      "httponly",
      "max-age",
      "path",
      "samesite",
      "secure",
    ]);
    expect(line).toMatch(/; Path=\/;/);
    expect(line.toLowerCase()).not.toContain("domain=");
  });

  it("over plain http (an install with no https address): host-only, no Secure, no prefix", () => {
    const line = sessionSetCookie(PORT, "id1", false);
    expect(line.startsWith(`den_session_${PORT}=id1;`)).toBe(true);
    expect(flags(line)).toEqual(["httponly", "max-age", "path", "samesite"]);
    expect(line.toLowerCase()).not.toContain("domain=");
  });

  it("signing out clears both names over https, the plain one over http", () => {
    const https = clearSessionCookies(PORT, true);
    expect(https.map((l) => l.split("=")[0]).sort()).toEqual([
      `__Host-den_session_${PORT}`,
      `den_session_${PORT}`,
    ]);
    for (const l of https) expect(l).toMatch(/Max-Age=0/);
    expect(
      clearSessionCookies(PORT, false).map((l) => l.split("=")[0]),
    ).toEqual([`den_session_${PORT}`]);
  });

  it("names: the __Host- one and the plain one", () => {
    expect(sessionCookieNames(PORT)).toEqual({
      secure: `__Host-den_session_${PORT}`,
      plain: `den_session_${PORT}`,
    });
  });
});

describe("reading the cookie", () => {
  const both = `den_session_${PORT}=old; __Host-den_session_${PORT}=new`;
  it("over https: only the __Host- one; a plain-named cookie there doesn't count (a sibling host could plant one)", () => {
    expect(readSessionCookie(both, PORT, true)).toBe("new");
    expect(
      readSessionCookie(`den_session_${PORT}=old`, PORT, true),
    ).toBeUndefined();
  });
  it("over http: only the plain one (a __Host- cookie never rides plain http)", () => {
    expect(readSessionCookie(both, PORT, false)).toBe("old");
    expect(
      readSessionCookie(`__Host-den_session_${PORT}=new`, PORT, false),
    ).toBeUndefined();
  });
  it("another port's cookie is not this server's", () => {
    expect(readSessionCookie(`den_session_1=x`, PORT, false)).toBeUndefined();
    expect(readSessionCookie(undefined, PORT, true)).toBeUndefined();
  });
});

describe("whether the named https address works (sessions live only there)", () => {
  function watch(o: {
    url: string | null;
    answer?: NamedAnswer;
    cacheMs?: number;
    dropAfter?: number;
    unknownKeepMs?: number;
  }) {
    let now = 1_000_000;
    let probes = 0;
    let proven = 0;
    let answer: NamedAnswer = o.answer ?? "unknown";
    let resolveProbe: (() => void) | null = null;
    const w = new NamedAddressWatch({
      webUrl: () => o.url,
      probe: () => {
        probes++;
        return new Promise<NamedAnswer>((r) => {
          resolveProbe = () => r(answer);
        });
      },
      cacheMs: () => o.cacheMs ?? 60_000,
      dropAfter: () => o.dropAfter ?? 2,
      unknownKeepMs: () => o.unknownKeepMs ?? 300_000,
      onProven: () => proven++,
      now: () => now,
    });
    const settle = async () => {
      resolveProbe?.();
      resolveProbe = null;
      await new Promise((r) => setImmediate(r));
    };
    return {
      w,
      probes: () => probes,
      proven: () => proven,
      settle,
      /** Let the cached answer go stale, check again with `a`, and settle. */
      recheck: async (a: NamedAnswer) => {
        answer = a;
        now += (o.cacheMs ?? 60_000) + 1;
        w.works();
        await settle();
      },
    };
  }

  it("no address, or an http one: never (sign-in keeps working where the person is)", () => {
    expect(watch({ url: null }).w.works()).toBe(false);
    expect(watch({ url: "http://den.acme.test" }).w.works()).toBe(false);
  });

  // Not until it is proven (no prediction from the config): a fresh
  // install's sign-in works at once; what it signs in on loopback ends at
  // the proof.
  it("an https address: not working until a check proves it", async () => {
    const t = watch({ url: "https://den.acme.test" });
    expect(t.w.works()).toBe(false);
    expect(t.probes()).toBe(1);
    await t.settle(); // unknown, never proven: it doesn't work
    expect(t.w.works()).toBe(false);
    await t.recheck("den");
    expect(t.w.works()).toBe(true);
  });

  it("the edge's proven https request on the address's host proves it at once; another host doesn't", async () => {
    const t = watch({ url: "https://den.acme.test" });
    expect(t.w.works()).toBe(false);
    await t.settle();
    t.w.saw("other.acme.test");
    expect(t.w.works()).toBe(false);
    t.w.saw("den.acme.test");
    expect(t.w.works()).toBe(true);
  });

  it("a check that can't tell keeps it proven, within web.address_unknown_keep_seconds of the last answer as this Den", async () => {
    const t = watch({ url: "https://den.acme.test" });
    t.w.saw("den.acme.test");
    for (let i = 0; i < 4; i++) await t.recheck("unknown"); // 244 s
    expect(t.w.works()).toBe(true);
  });

  it("past that window, can't-tell counts as a failure: sign-in comes back where the browser is", async () => {
    const t = watch({ url: "https://den.acme.test", dropAfter: 2 });
    t.w.saw("den.acme.test");
    for (let i = 0; i < 5; i++) await t.recheck("unknown"); // 305 s
    expect(t.w.works()).toBe(true); // the first failure
    await t.recheck("unknown"); // the second
    expect(t.w.works()).toBe(false);
  });

  it("an answer as this Den starts the window again", async () => {
    const t = watch({ url: "https://den.acme.test", dropAfter: 1 });
    t.w.saw("den.acme.test");
    for (let i = 0; i < 4; i++) await t.recheck("unknown");
    await t.recheck("den");
    for (let i = 0; i < 4; i++) await t.recheck("unknown");
    expect(t.w.works()).toBe(true);
  });

  it("says when it last answered as this Den", async () => {
    const t = watch({ url: "https://den.acme.test" });
    expect(t.w.lastAnswered()).toBeNull();
    t.w.saw("den.acme.test");
    expect(typeof t.w.lastAnswered()).toBe("number");
  });

  it("only a definite failure, seen dropAfter times in a row, moves it back", async () => {
    const t = watch({ url: "https://den.acme.test", dropAfter: 2 });
    t.w.saw("den.acme.test");
    await t.recheck("nothing");
    expect(t.w.works()).toBe(true);
    await t.recheck("unknown"); // can't tell: neither counts nor resets
    expect(t.w.works()).toBe(true);
    await t.recheck("den"); // proven again: the count starts over
    await t.recheck("other");
    expect(t.w.works()).toBe(true);
    await t.recheck("nothing");
    expect(t.w.works()).toBe(false);
  });

  it("onProven runs once each time it becomes proven (to end the sessions made on loopback)", async () => {
    const t = watch({ url: "https://den.acme.test", dropAfter: 1 });
    t.w.works();
    await t.settle();
    expect(t.proven()).toBe(0);
    t.w.saw("den.acme.test");
    t.w.saw("den.acme.test");
    await t.recheck("den");
    expect(t.proven()).toBe(1);
    await t.recheck("nothing");
    expect(t.w.works()).toBe(false);
    await t.recheck("den");
    expect(t.proven()).toBe(2);
  });

  it("checks one at a time", () => {
    const t = watch({ url: "https://den.acme.test" });
    t.w.works();
    t.w.works();
    expect(t.probes()).toBe(1);
  });
});

describe("how long can't-tell keeps a proven address: a Setting", () => {
  it("web.address_unknown_keep_seconds, default 300 (minutes, not hours), 0 to 3600", () => {
    const read = (v: unknown) =>
      addressCheckSettings(() => ({ web: { address_unknown_keep_seconds: v } }))
        .unknownKeepMs;
    expect(read(undefined)).toBe(300_000);
    expect(read(60)).toBe(60_000);
    expect(read(0)).toBe(0);
    expect(read(7200)).toBe(300_000);
    expect(ADDRESS_CHECK_LIMITS.unknown_keep_seconds).toEqual({
      min: 0,
      max: 3600,
      default: 300,
    });
  });
});

describe("how many definite failures move a proven address back: a Setting", () => {
  it("web.address_check_drop_after, permissive default 2, 1 to 100", () => {
    const read = (v: unknown) =>
      addressCheckSettings(() => ({ web: { address_check_drop_after: v } }))
        .dropAfter;
    expect(read(undefined)).toBe(2);
    expect(read(5)).toBe(5);
    expect(read(0)).toBe(2);
    expect(ADDRESS_CHECK_LIMITS.drop_after).toEqual({
      min: 1,
      max: 100,
      default: 2,
    });
  });
});
