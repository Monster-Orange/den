/**
 * SEC-2a's approve-with-a-code requests (pair-requests.ts), with a fake
 * clock: the code's format and how a typed code is read, the poll id
 * apart from the code, the 10-minute expiry, single use, the cap (the
 * oldest drops) and the rate limit on approve attempts.
 */
import { describe, expect, it } from "@jest/globals";
import {
  APPROVE_WINDOW_MS,
  formatPairCode,
  MAX_PAIRS_PER_CLIENT_MINUTE,
  MAX_PAIRS_PER_UNKNOWN_MINUTE,
  MAX_PENDING_PAIRS,
  MAX_WITHDRAWN_KEPT,
  newPairCode,
  normalizePairCode,
  PAIR_ALPHABET,
  PAIR_TTL_MS,
  PAIR_UNSEEN_MS,
  PairRequests,
} from "../../../src/ui/server/pair-requests.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("the code", () => {
  it("six Crockford base32 characters (30 bits), shown XXX-XXX", () => {
    expect(PAIR_ALPHABET).toHaveLength(32);
    for (const c of "ILOU") expect(PAIR_ALPHABET.includes(c)).toBe(false);
    for (let i = 0; i < 200; i++) {
      const c = newPairCode();
      expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
      expect(formatPairCode(c)).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/,
      );
    }
    expect(formatPairCode("K7Q42M")).toBe("K7Q-42M");
  });

  it("typed in any case, with or without the dash, or with look-alikes, it reads the same", () => {
    for (const typed of ["K7Q-42M", "k7q42m", " k7q - 42m ", "K7Q 42M"])
      expect([typed, normalizePairCode(typed)]).toEqual([typed, "K7Q42M"]);
    // Crockford: O is 0, I and L are 1.
    expect(normalizePairCode("O1I-L00")).toBe("01110" + "0");
    for (const bad of ["", "K7Q-42", "K7Q-42MM", "K7Q-4UM", "K7Q_42M"])
      expect([bad, normalizePairCode(bad)]).toEqual([bad, null]);
  });
});

describe("a request", () => {
  it("has a poll id of 128 bits or more, never the code, and records the browser and OS, the address and when", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const r = pairs.create({ userAgent: UA, client: "203.0.113.7" });
    expect(Buffer.from(r.id, "base64url").length * 8).toBeGreaterThanOrEqual(
      128,
    );
    expect(r.id.toUpperCase().includes(r.code.replace("-", ""))).toBe(false);
    expect(r.expiresAt).toBe(c.now() + PAIR_TTL_MS);
    expect(PAIR_TTL_MS).toBe(10 * 60_000);
    expect(pairs.waiting()).toEqual([
      {
        code: r.code,
        ref: r.ref,
        state: "pending",
        device: "Chrome on macOS",
        client: "203.0.113.7",
        createdAt: c.now(),
        expiresAt: c.now() + PAIR_TTL_MS,
      },
    ]);
    // The code doesn't poll: only the id does.
    expect(pairs.get(r.code)).toBeNull();
    expect(pairs.claim(r.code)).toBeNull();
  });

  it("approved, its poll claims it once: a second claim, or approving the code again, fails", () => {
    const pairs = new PairRequests({ now: clock().now });
    const r = pairs.create({ userAgent: UA });
    expect(pairs.claim(r.id)).toBeNull(); // not approved yet
    expect(pairs.approve(r.code.toLowerCase())).toMatchObject({ ok: true });
    expect(pairs.get(r.id)?.state).toBe("approved");
    expect(pairs.claim(r.id)).toMatchObject({ device: "Chrome on macOS" });
    expect(pairs.claim(r.id)).toBeNull();
    expect(pairs.get(r.id)).toBeNull();
    expect(pairs.approve(r.code)).toEqual({ ok: false, error: "unknown" });
  });

  it("a wrong code is unknown; a malformed one says so; nothing is approved", () => {
    const pairs = new PairRequests({ now: clock().now });
    const r = pairs.create({ userAgent: UA });
    const other = r.code === "000-000" ? "000-001" : "000-000";
    expect(pairs.approve(other)).toEqual({ ok: false, error: "unknown" });
    expect(pairs.approve("nope")).toEqual({ ok: false, error: "malformed" });
    expect(pairs.get(r.id)?.state).toBe("pending");
  });

  it("expires after 10 minutes: its page is told, approving it says expired, then it is forgotten", () => {
    const c = clock();
    // Its page polls all along (issue 320: else it ends unseen first).
    const pairs = new PairRequests({ now: c.now, unseenMs: Infinity });
    const r = pairs.create({ userAgent: UA });
    c.advance(PAIR_TTL_MS - 1);
    expect(pairs.get(r.id)?.state).toBe("pending");
    c.advance(1);
    expect(pairs.get(r.id)?.state).toBe("expired");
    expect(pairs.waiting()).toEqual([]);
    expect(pairs.approve(r.code)).toEqual({ ok: false, error: "expired" });
    c.advance(5 * 60_000);
    expect(pairs.get(r.id)).toBeNull();
  });

  it("an approval not claimed in time expires too", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const r = pairs.create({ userAgent: UA });
    pairs.approve(r.code);
    c.advance(PAIR_TTL_MS);
    expect(pairs.claim(r.id)).toBeNull();
    expect(pairs.get(r.id)?.state).toBe("expired");
  });

  it("denied: its page is told, and it can't be approved", () => {
    const pairs = new PairRequests({ now: clock().now });
    const r = pairs.create({ userAgent: UA });
    expect(pairs.deny(r.code)).toMatchObject({ ok: true });
    expect(pairs.get(r.id)?.state).toBe("denied");
    expect(pairs.approve(r.code)).toEqual({ ok: false, error: "unknown" });
    expect(pairs.claim(r.id)).toBeNull();
  });
});

describe("the cap and the rate limit", () => {
  it(`at most ${MAX_PENDING_PAIRS} pending: a new one drops the oldest`, () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const made = [];
    for (let i = 0; i < MAX_PENDING_PAIRS + 2; i++) {
      made.push(pairs.create({ userAgent: UA }));
      c.advance(1);
    }
    const left = pairs.waiting().map((w) => w.code);
    expect(left).toHaveLength(MAX_PENDING_PAIRS);
    // Issue 819: the newest first.
    expect(left).toEqual(
      made
        .slice(2)
        .map((m) => m.code)
        .reverse(),
    );
    expect(pairs.get(made[0].id)).toBeNull();
    expect(pairs.approve(made[0].code)).toEqual({
      ok: false,
      error: "unknown",
    });
  });

  it("past 10 attempts in the window, every attempt is refused (a right code too) until the window passes", () => {
    const c = clock();
    // Its page polls all along (issue 320: else it ends unseen first).
    const pairs = new PairRequests({ now: c.now, unseenMs: Infinity });
    const r = pairs.create({ userAgent: UA });
    const wrong = r.code === "000-000" ? "000-001" : "000-000";
    for (let i = 0; i < 10; i++)
      expect(pairs.approve(wrong)).toEqual({ ok: false, error: "unknown" });
    expect(pairs.approve(r.code)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(pairs.get(r.id)?.state).toBe("pending");
    c.advance(APPROVE_WINDOW_MS);
    expect(pairs.approve(r.code)).toMatchObject({ ok: true });
  });
});

describe("issue 819: approving needs the code from the device's screen", () => {
  it("a request has a public handle apart from its code and poll id", () => {
    const pairs = new PairRequests({ now: clock().now });
    const r = pairs.create({ userAgent: UA });
    expect(r.ref.length).toBeGreaterThanOrEqual(16);
    expect([r.ref === r.id, r.ref.includes(r.code.replace("-", ""))]).toEqual([
      false,
      false,
    ]);
    expect(pairs.waiting()[0].ref).toBe(r.ref);
  });

  it("by its handle, only its own code approves it, typed in any case, with spaces or a dash", () => {
    const pairs = new PairRequests({ now: clock().now, unseenMs: Infinity });
    const a = pairs.create({ userAgent: UA });
    const b = pairs.create({ userAgent: UA });
    expect(pairs.approve({ ref: a.ref })).toEqual({
      ok: false,
      error: "malformed",
    });
    // Another request's code is wrong for this one.
    expect(pairs.approve({ ref: a.ref, code: b.code })).toEqual({
      ok: false,
      error: "wrong",
    });
    expect(pairs.get(b.id)?.state).toBe("pending");
    const typed = ` ${a.code.toLowerCase().replace("-", " ")} `;
    expect(pairs.approve({ ref: a.ref, code: typed })).toMatchObject({
      ok: true,
    });
    expect(pairs.get(a.id)?.state).toBe("approved");
  });

  it("deny by its handle needs no code", () => {
    const pairs = new PairRequests({ now: clock().now });
    const a = pairs.create({ userAgent: UA });
    expect(pairs.deny({ ref: a.ref })).toMatchObject({ ok: true });
    expect(pairs.get(a.id)?.state).toBe("denied");
  });

  it("past its 10 minutes it can't be approved at all, by handle or code, and drops off the list", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now, unseenMs: Infinity });
    const a = pairs.create({ userAgent: UA });
    c.advance(PAIR_TTL_MS);
    expect(pairs.waiting()).toEqual([]);
    expect(pairs.approve({ ref: a.ref, code: a.code })).toEqual({
      ok: false,
      error: "expired",
    });
    expect(pairs.approve(a.code)).toEqual({ ok: false, error: "expired" });
  });

  it("a wrong code counts toward the limit; a request that ended or a handle that names none doesn't", () => {
    const c = clock();
    const pairs = new PairRequests({
      now: c.now,
      unseenMs: Infinity,
      maxAttempts: 3,
    });
    const a = pairs.create({ userAgent: UA });
    const gone = pairs.create({ userAgent: UA });
    pairs.withdraw(gone.id);
    const wrong = a.code === "000-000" ? "000-001" : "000-000";
    for (let i = 0; i < 10; i++) {
      expect(pairs.approve({ ref: gone.ref, code: gone.code })).toEqual({
        ok: false,
        error: "ended",
      });
      expect(
        pairs.approve({ ref: "nothing-by-that-name", code: wrong }),
      ).toEqual({ ok: false, error: "unknown" });
    }
    for (let i = 0; i < 3; i++)
      expect(pairs.approve({ ref: a.ref, code: wrong })).toEqual({
        ok: false,
        error: "wrong",
      });
    expect(pairs.approve({ ref: a.ref, code: a.code })).toEqual({
      ok: false,
      error: "rate_limited",
    });
  });

  it("the limit and its window are read when used (Settings); the default window is short", () => {
    expect(APPROVE_WINDOW_MS).toBeLessThanOrEqual(30_000);
    const c = clock();
    let max = 1;
    let windowMs = 5_000;
    const pairs = new PairRequests({
      now: c.now,
      unseenMs: Infinity,
      maxAttempts: () => max,
      windowMs: () => windowMs,
    });
    const a = pairs.create({ userAgent: UA });
    const wrong = a.code === "000-000" ? "000-001" : "000-000";
    pairs.approve({ ref: a.ref, code: wrong });
    expect(pairs.approve({ ref: a.ref, code: a.code })).toMatchObject({
      error: "rate_limited",
    });
    max = 5;
    expect(pairs.approve({ ref: a.ref, code: wrong })).toMatchObject({
      error: "wrong",
    });
    windowMs = 1;
    c.advance(2);
    max = 1;
    expect(pairs.approve({ ref: a.ref, code: a.code })).toMatchObject({
      ok: true,
    });
  });

  it("the waiting list shows a sign-in link's request first, then the newest", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now, unseenMs: Infinity });
    const old = pairs.create({ userAgent: UA });
    c.advance(10);
    const linked = pairs.create({
      userAgent: UA,
      link: "n".repeat(22),
      linkAt: 123,
    });
    c.advance(10);
    const newest = pairs.create({ userAgent: UA });
    expect(pairs.waiting().map((w) => w.ref)).toEqual([
      linked.ref,
      newest.ref,
      old.ref,
    ]);
    expect(pairs.waiting()[0].linkAt).toBe(123);
  });
});

describe("issue 819: who may make requests", () => {
  it(`one client address makes at most ${MAX_PAIRS_PER_CLIENT_MINUTE} a minute (a Setting); another isn't held up`, () => {
    const c = clock();
    let per = 3;
    const pairs = new PairRequests({
      now: c.now,
      unseenMs: Infinity,
      perClient: () => per,
    });
    for (let i = 0; i < 3; i++)
      expect(pairs.tryCreate({ userAgent: UA, client: "203.0.113.7" }).ok).toBe(
        true,
      );
    expect(pairs.tryCreate({ userAgent: UA, client: "203.0.113.7" })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(pairs.tryCreate({ userAgent: UA, client: "198.51.100.2" }).ok).toBe(
      true,
    );
    per = 10;
    expect(pairs.tryCreate({ userAgent: UA, client: "203.0.113.7" }).ok).toBe(
      true,
    );
    c.advance(60_000);
    per = 3;
    expect(pairs.tryCreate({ userAgent: UA, client: "203.0.113.7" }).ok).toBe(
      true,
    );
  });

  it("past the cap, a request without a link never drops one a sign-in link opened", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now, unseenMs: Infinity, max: 2 });
    const l1 = pairs.create({ userAgent: UA, link: "a".repeat(22) });
    c.advance(1);
    const plain = pairs.create({ userAgent: UA });
    c.advance(1);
    // The plain one goes, not the older link's.
    const l2 = pairs.create({ userAgent: UA, link: "b".repeat(22) });
    expect(pairs.get(plain.id)).toBeNull();
    expect(pairs.get(l1.id)?.state).toBe("pending");
    // Full of links: a plain one is refused, and nothing is dropped.
    expect(pairs.tryCreate({ userAgent: UA })).toEqual({
      ok: false,
      error: "full",
    });
    expect([pairs.get(l1.id)?.state, pairs.get(l2.id)?.state]).toEqual([
      "pending",
      "pending",
    ]);
  });
});

describe("D67: only codes a page still waits on", () => {
  it("a page that stops asking (its tab closed) drops off the waiting list; issue 320: it has ended, so asking again gets nothing", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const kept = pairs.create({ userAgent: UA });
    const left = pairs.create({ userAgent: UA });
    c.advance(PAIR_UNSEEN_MS - 1000);
    pairs.get(kept.id);
    c.advance(2000);
    expect(pairs.waiting().map((w) => w.code)).toEqual([kept.code]);
    // Issue 320: ended, not just hidden: `web approve` says so, and a late
    // poll (a background tab) gets nothing, so its page makes a new code.
    expect(pairs.approve(left.code)).toEqual({ ok: false, error: "ended" });
    expect(pairs.get(left.id)).toBeNull();
    expect(pairs.waiting().map((w) => w.code)).toEqual([kept.code]);
  });

  it("withdraw ends a pending request by its poll id at once; not one already approved", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const r = pairs.create({ userAgent: UA });
    expect(pairs.withdraw(r.id)).toBe(true);
    expect(pairs.waiting()).toEqual([]);
    expect(pairs.get(r.id)).toBeNull();
    expect(pairs.withdraw(r.id)).toBe(false);
    // #320: approving it after does nothing, and says it ended.
    expect(pairs.approve(r.code)).toEqual({ ok: false, error: "ended" });
    expect(pairs.deny(r.code)).toEqual({ ok: false, error: "ended" });
    expect(pairs.claim(r.id)).toBeNull();
    const ok = pairs.create({ userAgent: UA });
    expect(pairs.approve(ok.code)).toMatchObject({ ok: true });
    expect(pairs.withdraw(ok.id)).toBe(false);
    expect(pairs.claim(ok.id)?.state).toBe("approved");
  });

  it("#320: a withdrawn request says ended for a minute, then is forgotten; only so many are kept", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const r = pairs.create({ userAgent: UA });
    pairs.withdraw(r.id);
    c.advance(59_000);
    expect(pairs.approve(r.code)).toEqual({ ok: false, error: "ended" });
    c.advance(1000);
    expect(pairs.approve(r.code)).toEqual({ ok: false, error: "unknown" });
    const made = Array.from({ length: MAX_WITHDRAWN_KEPT + 3 }, () => {
      const x = pairs.create({ userAgent: UA });
      pairs.withdraw(x.id);
      c.advance(1);
      return x;
    });
    expect(pairs.approve(made[0].code)).toEqual({
      ok: false,
      error: "unknown",
    });
    expect(pairs.approve(made[made.length - 1].code)).toEqual({
      ok: false,
      error: "ended",
    });
  });
});

describe("issue 320: a request its page stopped asking for has ended", () => {
  it("unseen past PAIR_UNSEEN_MS (a closed page whose withdraw never came): approve and deny say ended, nothing is allowed, and its page's next poll gets nothing", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const r = pairs.create({ userAgent: UA });
    c.advance(PAIR_UNSEEN_MS);
    expect(pairs.approve(r.code)).toEqual({ ok: false, error: "ended" });
    expect(pairs.deny(r.code)).toEqual({ ok: false, error: "ended" });
    expect(pairs.waiting()).toEqual([]);
    // A background tab that polls late: gone, so its page makes a new code.
    expect(pairs.get(r.id)).toBeNull();
    expect(pairs.claim(r.id)).toBeNull();
    // Like a withdrawn one: it says ended for a minute, then is forgotten.
    c.advance(60_000);
    expect(pairs.approve(r.code)).toEqual({ ok: false, error: "unknown" });
  });

  it("waiting() and approve() draw the same line: one ms short of the bound it is listed and approves", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const r = pairs.create({ userAgent: UA });
    c.advance(PAIR_UNSEEN_MS - 1);
    expect(pairs.waiting().map((w) => w.code)).toEqual([r.code]);
    expect(pairs.approve(r.code)).toMatchObject({ ok: true });
    expect(pairs.claim(r.id)?.state).toBe("approved");
  });

  it("a page that keeps polling keeps its request: approving it still works long after", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const r = pairs.create({ userAgent: UA });
    for (let t = 0; t < 5 * 60_000; t += 1500) {
      c.advance(1500);
      expect(pairs.get(r.id)?.state).toBe("pending");
    }
    expect(pairs.approve(r.code)).toMatchObject({ ok: true });
  });

  it("the bound is injectable (unseenMs)", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now, unseenMs: 2000 });
    const r = pairs.create({ userAgent: UA });
    c.advance(2000);
    expect(pairs.approve(r.code)).toEqual({ ok: false, error: "ended" });
  });
});

describe("issue 1146: a link's request and callers of unknown address", () => {
  it("a request a sign-in or setup link opened isn't counted against, or refused by, the address's per-minute limit", () => {
    const c = clock();
    const pairs = new PairRequests({
      now: c.now,
      unseenMs: Infinity,
      perClient: () => 1,
    });
    for (const n of ["a", "b", "c"])
      expect(
        pairs.tryCreate({ userAgent: UA, client: "203.0.113.7", link: n.repeat(22) })
          .ok,
      ).toBe(true);
    // The links used none of the address's minute.
    expect(pairs.tryCreate({ userAgent: UA, client: "203.0.113.7" }).ok).toBe(
      true,
    );
    expect(pairs.tryCreate({ userAgent: UA, client: "203.0.113.7" })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    // A link's request still goes through once the address is limited.
    expect(
      pairs.tryCreate({ userAgent: UA, client: "203.0.113.7", link: "d".repeat(22) })
        .ok,
    ).toBe(true);
  });

  it(`callers whose address is unknown are their own, stricter case (default ${MAX_PAIRS_PER_UNKNOWN_MINUTE} a minute, a Setting), never an empty key a known address shares`, () => {
    expect(MAX_PAIRS_PER_UNKNOWN_MINUTE).toBeLessThan(
      MAX_PAIRS_PER_CLIENT_MINUTE,
    );
    const c = clock();
    let unknown = 2;
    const pairs = new PairRequests({
      now: c.now,
      unseenMs: Infinity,
      perClient: () => 5,
      perUnknown: () => unknown,
    });
    expect(pairs.tryCreate({ userAgent: UA }).ok).toBe(true);
    expect(pairs.tryCreate({ userAgent: UA, client: "" }).ok).toBe(true);
    expect(pairs.tryCreate({ userAgent: UA })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    // A known address isn't held up by them.
    expect(pairs.tryCreate({ userAgent: UA, client: "203.0.113.7" }).ok).toBe(
      true,
    );
    unknown = 3;
    expect(pairs.tryCreate({ userAgent: UA }).ok).toBe(true);
    c.advance(60_000);
    unknown = 2;
    expect(pairs.tryCreate({ userAgent: UA }).ok).toBe(true);
  });

  it("past the cap, a request of unknown address drops only another of unknown address, never a known address's", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now, unseenMs: Infinity, max: 2 });
    const k1 = pairs.create({ userAgent: UA, client: "203.0.113.7" });
    c.advance(1);
    const k2 = pairs.create({ userAgent: UA, client: "198.51.100.2" });
    c.advance(1);
    expect(pairs.tryCreate({ userAgent: UA })).toEqual({
      ok: false,
      error: "full",
    });
    expect([pairs.get(k1.id)?.state, pairs.get(k2.id)?.state]).toEqual([
      "pending",
      "pending",
    ]);
    // A known address's new one drops the oldest plain one, as before.
    const k3 = pairs.create({ userAgent: UA, client: "192.0.2.9" });
    expect(pairs.get(k1.id)).toBeNull();
    c.advance(1);
    // With one of unknown address waiting, a known one drops it first.
    const pk = new PairRequests({ now: c.now, unseenMs: Infinity, max: 2 });
    const kk = pk.create({ userAgent: UA, client: "203.0.113.7" });
    c.advance(1);
    const u1 = pk.create({ userAgent: UA });
    c.advance(1);
    const u2 = pk.create({ userAgent: UA });
    expect([pk.get(kk.id)?.state, pk.get(u1.id), pk.get(u2.id)?.state]).toEqual(
      ["pending", null, "pending"],
    );
    pk.create({ userAgent: UA, client: "198.51.100.2" });
    expect([pk.get(kk.id)?.state, pk.get(u2.id)]).toEqual(["pending", null]);
    expect(pairs.get(k3.id)?.state).toBe("pending");
  });
});
