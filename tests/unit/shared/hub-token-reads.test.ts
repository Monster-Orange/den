/**
 * 0.4.47: Den reads the Hub token from its secrets store once, not on
 * every Hub call. With many agents, a read per call ran the store's rate
 * limit dry, and then every agent lost Hub and kept asking, so it never
 * came back.
 *
 *   - 100 Hub calls, 1 read.
 *   - The store failing (rate-limited, signed out) keeps the last good
 *     token, and Den waits before it asks again: never a read per call.
 *   - With no good token yet, the failure is said plainly, with the
 *     store's own words and when Den tries again.
 *   - Hub turning the token down (401) lets Den read it again, at most once
 *     a minute; a person connecting again reads at once.
 *
 * A fake store that counts reads. Invented values only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  forgetHubToken,
  hubTokenProblem,
  newHubTokenCache,
  readHubToken,
  type HubConfig,
} from "../../../src/shared/hub.js";
import type { SecretsProvider } from "../../../src/shared/secrets/index.js";

const TOKEN = "hubi_TESTONLYcount123";
const cfg: HubConfig = {
  url: "https://hub.example.test",
  tokenRef: { vault: "v", item: "i", field: "HUB_T", key: "HUB_T" },
  tokenFrom: "hub.token",
  allowTools: true,
};

/** A store that answers from `answers` in turn (the last one repeats). */
function counting(...answers: (string | Error)[]) {
  const s = { reads: 0 };
  const next = () => answers[Math.min(s.reads - 1, answers.length - 1)];
  const read = async () => {
    s.reads++;
    const a = next();
    if (a instanceof Error) throw a;
    return a;
  };
  const provider = (() =>
    ({
      get: read,
      tryGet: read,
    }) as unknown as SecretsProvider) as () => SecretsProvider;
  return { s, provider };
}

const RATE = new Error(
  "[ERROR] Too many requests. Your client has been rate-limited.",
);

describe("the Hub token is read once, not per call", () => {
  it("100 Hub calls make 1 read", async () => {
    const { s, provider } = counting(TOKEN);
    const cache = newHubTokenCache();
    for (let i = 0; i < 100; i++)
      expect(await readHubToken(cfg, provider, cache)).toBe(TOKEN);
    expect(s.reads).toBe(1);
  });

  it("a store failure keeps the last good token and never reads per call", async () => {
    const { s, provider } = counting(TOKEN, RATE);
    const cache = newHubTokenCache();
    let now = 1_000_000;
    expect(await readHubToken(cfg, provider, cache, now)).toBe(TOKEN);
    // Hub turned it down: Den may read again.
    expect(forgetHubToken(cache, now)).toBe(true);
    for (let i = 0; i < 50; i++) {
      now += 100;
      expect(await readHubToken(cfg, provider, cache, now)).toBe(TOKEN);
    }
    expect(s.reads).toBe(2);
  });

  it("no good token yet: the store's own words, and when Den tries again; it backs off", async () => {
    const { s, provider } = counting(RATE);
    const cache = newHubTokenCache();
    let now = 2_000_000;
    for (let i = 0; i < 50; i++) {
      now += 100;
      expect(await readHubToken(cfg, provider, cache, now)).toBeNull();
    }
    expect(s.reads).toBe(1);
    const p = hubTokenProblem(cache, now);
    expect(p).toMatch(/Den can't read the Hub token from its secrets store/);
    expect(p).toMatch(/rate-limited/);
    expect(p).toMatch(/trying again in \d+ (min|s)/);
    // After the wait, one more try.
    now += 10 * 60_000;
    await readHubToken(cfg, provider, cache, now);
    expect(s.reads).toBe(2);
  });

  it("401s let it read again at most once a minute; connecting again reads at once", async () => {
    const { s, provider } = counting(TOKEN);
    const cache = newHubTokenCache();
    const now = 3_000_000;
    await readHubToken(cfg, provider, cache, now);
    expect(forgetHubToken(cache, now)).toBe(true);
    await readHubToken(cfg, provider, cache, now);
    expect(forgetHubToken(cache, now + 5_000)).toBe(false);
    await readHubToken(cfg, provider, cache, now + 5_000);
    expect(s.reads).toBe(2);
    forgetHubToken(cache, now + 6_000, { now: true });
    await readHubToken(cfg, provider, cache, now + 6_000);
    expect(s.reads).toBe(3);
  });
});
