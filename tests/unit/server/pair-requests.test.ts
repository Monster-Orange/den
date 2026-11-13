/**
 * SEC-2a's approve-with-a-code requests (pair-requests.ts), with a fake
 * clock: the code's format and how a typed code is read, the poll id
 * apart from the code, the 10-minute expiry, single use, the cap (the
 * oldest drops) and the rate limit on approve attempts.
 */
import { describe, expect, it } from "@jest/globals";
import {
  formatPairCode,
  MAX_PENDING_PAIRS,
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
    const pairs = new PairRequests({ now: c.now });
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
    expect(left).toEqual(made.slice(2).map((m) => m.code));
    expect(pairs.get(made[0].id)).toBeNull();
    expect(pairs.approve(made[0].code)).toEqual({
      ok: false,
      error: "unknown",
    });
  });

  it("past 10 attempts a minute, every attempt is refused (a right code too) until the minute passes", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const r = pairs.create({ userAgent: UA });
    const wrong = r.code === "000-000" ? "000-001" : "000-000";
    for (let i = 0; i < 10; i++)
      expect(pairs.approve(wrong)).toEqual({ ok: false, error: "unknown" });
    expect(pairs.approve(r.code)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(pairs.get(r.id)?.state).toBe("pending");
    c.advance(60_000);
    expect(pairs.approve(r.code)).toMatchObject({ ok: true });
  });
});

describe("D67: only codes a page still waits on", () => {
  it("a page that stops asking (its tab closed) drops off the waiting list; asking again brings it back", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const kept = pairs.create({ userAgent: UA });
    const left = pairs.create({ userAgent: UA });
    c.advance(PAIR_UNSEEN_MS - 1000);
    pairs.get(kept.id);
    c.advance(2000);
    expect(pairs.waiting().map((w) => w.code)).toEqual([kept.code]);
    // It still approves by code (the CLI's `web approve`), and a poll shows it again.
    expect(pairs.get(left.id)?.state).toBe("pending");
    expect(pairs.waiting().map((w) => w.code)).toEqual([kept.code, left.code]);
  });

  it("withdraw ends a pending request by its poll id at once; not one already approved", () => {
    const c = clock();
    const pairs = new PairRequests({ now: c.now });
    const r = pairs.create({ userAgent: UA });
    expect(pairs.withdraw(r.id)).toBe(true);
    expect(pairs.waiting()).toEqual([]);
    expect(pairs.get(r.id)).toBeNull();
    expect(pairs.withdraw(r.id)).toBe(false);
    const ok = pairs.create({ userAgent: UA });
    expect(pairs.approve(ok.code)).toMatchObject({ ok: true });
    expect(pairs.withdraw(ok.id)).toBe(false);
    expect(pairs.claim(ok.id)?.state).toBe("approved");
  });
});
