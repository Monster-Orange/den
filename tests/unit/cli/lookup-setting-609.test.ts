/**
 * Issue 609: how long Den's process lookups (lsof, ps) wait is a Setting
 * with a permissive default: user.yml process_lookup.first_seconds (5)
 * and retry_seconds (20), in Settings and `config`. DEN_LOOKUP_TIMEOUTS_MS
 * still overrides both, as before. The server's lookup of an agent's
 * caller and `web down` both use it.
 */
import { describe, expect, it } from "@jest/globals";
import {
  LOOKUP_LIMITS,
  LOOKUP_TIMEOUTS_MS,
  lookupTimeouts,
} from "../../../src/shared/proc-lookup.js";
import { patchCliRows } from "../../../src/shared/settings-cli-rows.js";

describe("issue 609: the lookup's wait is a Setting", () => {
  it("defaults: 5 s, then 20 s, as before", () => {
    expect(LOOKUP_LIMITS.first_seconds.default).toBe(5);
    expect(LOOKUP_LIMITS.retry_seconds.default).toBe(20);
    expect(lookupTimeouts({}, () => ({}))).toEqual([5_000, 20_000]);
    expect([...LOOKUP_TIMEOUTS_MS]).toEqual([5_000, 20_000]);
  });

  it("user.yml process_lookup sets each try", () => {
    expect(
      lookupTimeouts({}, () => ({
        process_lookup: { first_seconds: 10, retry_seconds: 60 },
      })),
    ).toEqual([10_000, 60_000]);
    expect(
      lookupTimeouts({}, () => ({ process_lookup: { retry_seconds: 45 } })),
    ).toEqual([5_000, 45_000]);
  });

  it("a value out of range, or an unreadable file: that try's default", () => {
    expect(
      lookupTimeouts({}, () => ({
        process_lookup: { first_seconds: 0, retry_seconds: "soon" },
      })),
    ).toEqual([5_000, 20_000]);
    expect(
      lookupTimeouts({}, () => {
        throw new Error("unreadable");
      }),
    ).toEqual([5_000, 20_000]);
  });

  it("DEN_LOOKUP_TIMEOUTS_MS still wins", () => {
    expect(
      lookupTimeouts({ DEN_LOOKUP_TIMEOUTS_MS: "200,300" }, () => ({
        process_lookup: { first_seconds: 10 },
      })),
    ).toEqual([200, 300]);
  });

  it("Settings writes user.yml process_lookup, checked first", () => {
    const user: Record<string, unknown> = {};
    expect(
      patchCliRows(user, {
        process_lookup: { first_seconds: 8, retry_seconds: 40 },
      }),
    ).toEqual({ ok: true });
    expect(user.process_lookup).toEqual({
      first_seconds: 8,
      retry_seconds: 40,
    });
    expect(
      patchCliRows(user, { process_lookup: { first_seconds: 0 } }).ok,
    ).toBe(false);
    expect(
      patchCliRows(user, { process_lookup: { retry_seconds: 601 } }).ok,
    ).toBe(false);
    expect(patchCliRows(user, { process_lookup: { other: 1 } }).ok).toBe(false);
    expect(
      patchCliRows(user, {
        process_lookup: { first_seconds: null, retry_seconds: null },
      }),
    ).toEqual({ ok: true });
    expect(user.process_lookup).toBeUndefined();
  });
});
