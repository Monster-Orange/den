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
  it("over https: the __Host- one first, else the plain one a browser signed in before kept", () => {
    expect(readSessionCookie(both, PORT, true)).toBe("new");
    expect(readSessionCookie(`den_session_${PORT}=old`, PORT, true)).toBe(
      "old",
    );
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
    predict?: boolean;
    answer?: NamedAnswer;
    cacheMs?: number;
  }) {
    let now = 1_000_000;
    let probes = 0;
    let answer: NamedAnswer = o.answer ?? "unknown";
    let resolveProbe: (() => void) | null = null;
    const w = new NamedAddressWatch({
      webUrl: () => o.url,
      predict: () => o.predict ?? false,
      probe: () => {
        probes++;
        return new Promise<NamedAnswer>((r) => {
          resolveProbe = () => r(answer);
        });
      },
      cacheMs: () => o.cacheMs ?? 60_000,
      now: () => now,
    });
    return {
      w,
      tick: (ms: number) => (now += ms),
      probes: () => probes,
      setAnswer: (a: NamedAnswer) => (answer = a),
      settle: async () => {
        resolveProbe?.();
        resolveProbe = null;
        await new Promise((r) => setImmediate(r));
      },
    };
  }

  it("no address, or an http one: never (sign-in keeps working where the person is)", () => {
    expect(watch({ url: null, predict: true }).w.works()).toBe(false);
    expect(
      watch({ url: "http://den.acme.test", predict: true }).w.works(),
    ).toBe(false);
  });

  it("an https address: its prediction until the first check, then the check", async () => {
    const t = watch({ url: "https://den.acme.test", predict: true });
    expect(t.w.works()).toBe(true);
    expect(t.probes()).toBe(1);
    await t.settle(); // unknown: it doesn't reach this Den
    expect(t.w.works()).toBe(false);
    t.setAnswer("den");
    t.tick(61_000);
    t.w.works(); // stale: checks again
    await t.settle();
    expect(t.w.works()).toBe(true);
  });

  it("the edge's proven https request on the address's host counts at once, for the check's lifetime", async () => {
    const t = watch({ url: "https://den.acme.test", predict: false });
    expect(t.w.works()).toBe(false);
    await t.settle();
    t.w.saw("den.acme.test");
    expect(t.w.works()).toBe(true);
    t.w.saw("other.acme.test"); // another host: no change
    t.tick(59_000);
    expect(t.w.works()).toBe(true);
    t.tick(2_000);
    t.w.works();
    await t.settle(); // the check, unknown: not any more
    expect(t.w.works()).toBe(false);
  });

  it("checks one at a time", () => {
    const t = watch({ url: "https://den.acme.test" });
    t.w.works();
    t.w.works();
    expect(t.probes()).toBe(1);
  });
});
