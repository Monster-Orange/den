/**
 * SEC-2a: GitHub's device flow with only a client id, against a fake GitHub
 * on localhost (never github.com). The flow sends no client secret and no
 * scope (never offline_access), honours authorization_pending, slow_down,
 * expired_token and access_denied, and reads only `id` and `login` from
 * GET /user. Sleeps and the clock are injected: nothing waits for real.
 * No code or token is printed: a failure shows booleans and lengths.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import {
  GITHUB_DEVICE_PAGE,
  GITHUB_TEST_BASE_ENV,
  expiringTokenWarning,
  githubClientId,
  githubEndpoints,
  MO_DEN_GITHUB_CLIENT_ID,
} from "../../../src/shared/github-app.js";
import {
  githubDeviceClient,
  githubPrincipal,
  runDeviceFlow,
  type DeviceCode,
} from "../../../src/shared/github-device.js";
import {
  startFakeGithub,
  type FakeGithub,
} from "../server/helpers/fake-github.js";

let gh: FakeGithub;
beforeAll(async () => {
  gh = await startFakeGithub();
});
afterAll(async () => {
  await gh.close();
});

const client = () =>
  githubDeviceClient(githubEndpoints({ [GITHUB_TEST_BASE_ENV]: gh.url }));
const OWNER = { id: 4242, login: "octo-owner" };

/** A sleep that runs `each` (a test's GitHub-side step) and records the wait. */
function steps(each: (n: number) => void) {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      each(waits.length);
    },
  };
}

describe("the endpoints", () => {
  it("are GitHub's own by default, and a fake one only on loopback http", () => {
    expect(githubEndpoints({})).toEqual({
      deviceCode: "https://github.com/login/device/code",
      accessToken: "https://github.com/login/oauth/access_token",
      user: "https://api.github.com/user",
      api: "https://api.github.com",
      fake: false,
    });
    expect(githubEndpoints({ [GITHUB_TEST_BASE_ENV]: gh.url }).fake).toBe(true);
    for (const bad of [
      "https://localhost:1",
      "http://evil.example",
      "http://10.0.0.1:80",
      "nope",
    ])
      expect([
        bad,
        githubEndpoints({ [GITHUB_TEST_BASE_ENV]: bad }).fake,
      ]).toEqual([bad, false]);
  });

  it("the default is the Monster Orange Den app's client id, in one place; web.github_client_id replaces it, and an empty one turns it off", () => {
    expect(MO_DEN_GITHUB_CLIENT_ID).toBe("Iv23liKL12gnN6WvRV5b");
    expect(githubClientId(undefined)).toBe("Iv23liKL12gnN6WvRV5b");
    expect(githubClientId(" Iv23liAcme ")).toBe("Iv23liAcme");
    expect(githubClientId("")).toBe("");
    expect(GITHUB_DEVICE_PAGE).toBe("https://github.com/login/device");
  });
});

describe("runDeviceFlow", () => {
  it("shows the code, polls past authorization_pending and slow_down at GitHub's interval, then reads id and login", async () => {
    let shown: DeviceCode | null = null;
    const s = steps((n) => {
      const code = gh.codes[gh.codes.length - 1];
      if (n === 1) gh.slowDown(code.userCode, 1);
      if (n === 3) gh.approve(code.userCode, OWNER);
    });
    const before = gh.requests.length;
    const out = await runDeviceFlow({
      clientId: "Iv23liAcme",
      client: client(),
      onCode: (c) => (shown = c),
      sleep: s.sleep,
      minIntervalMs: 0,
    });
    expect(out).toEqual({ kind: "ok", identity: OWNER });
    expect(githubPrincipal(4242)).toBe("github:4242");
    // The code shown is the one GitHub handed out (its value never printed).
    const c = shown as DeviceCode | null;
    expect(c?.userCode === gh.codes[gh.codes.length - 1].userCode).toBe(true);
    // slow_down (no interval given): +5 s; pending: the same wait again.
    expect(s.waits).toEqual([0, 5000, 5000]);
    const mine = gh.requests.slice(before);
    expect(mine.map((r) => r.path)).toEqual([
      "/login/device/code",
      "/login/oauth/access_token",
      "/login/oauth/access_token",
      "/login/oauth/access_token",
      "/user",
    ]);
    // Only a client id: no secret, no scope (offline_access least of all).
    for (const r of mine) {
      expect(
        Object.keys(r.fields).filter((k) => /secret|scope/i.test(k)),
      ).toEqual([]);
      expect(JSON.stringify(r.fields).includes("offline_access")).toBe(false);
    }
    expect(mine[1].fields.grant_type).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(mine[4].auth).toBe(true);
  });

  it("a token answer without expires_in or a refresh_token: no expiring flag", async () => {
    gh.expiringTokens = false;
    const s = steps((n) => {
      if (n === 1) gh.approve(gh.codes[gh.codes.length - 1].userCode, OWNER);
    });
    const out = await runDeviceFlow({
      clientId: "Iv23liAcme",
      client: client(),
      onCode: () => {},
      sleep: s.sleep,
      minIntervalMs: 0,
    });
    expect(out).toEqual({ kind: "ok", identity: OWNER });
  });

  it("the app has token expiry on (expires_in, refresh_token): sign-in still completes, flagged; no token in the result", async () => {
    gh.expiringTokens = true;
    try {
      const s = steps((n) => {
        if (n === 1) gh.approve(gh.codes[gh.codes.length - 1].userCode, OWNER);
      });
      const out = await runDeviceFlow({
        clientId: "Iv23liAcme",
        client: client(),
        onCode: () => {},
        sleep: s.sleep,
        minIntervalMs: 0,
      });
      expect(out).toEqual({ kind: "ok", identity: OWNER, expiringToken: true });
      const text = JSON.stringify(out);
      for (const t of [...gh.tokens, ...gh.refreshTokens])
        expect(text.includes(t)).toBe(false);
      expect(expiringTokenWarning()).toMatch(
        /switch off .Expire user authorization tokens. in the app's settings/,
      );
    } finally {
      gh.expiringTokens = false;
    }
  });

  it("slow_down raises the wait (GitHub's interval, or +5 s)", async () => {
    const s = steps((n) => {
      const code = gh.codes[gh.codes.length - 1];
      if (n === 1) gh.slowDown(code.userCode, 1);
      if (n === 2) gh.approve(code.userCode, OWNER);
    });
    const c = client();
    const slow = {
      ...c,
      poll: async (id: string, dc: string) => {
        const r = await c.poll(id, dc);
        return r.kind === "slow_down" ? { kind: "slow_down" as const } : r;
      },
    };
    await runDeviceFlow({
      clientId: "x",
      client: slow,
      onCode: () => undefined,
      sleep: s.sleep,
      minIntervalMs: 0,
    });
    expect(s.waits).toEqual([0, 5000]);
  });

  it("access_denied and expired_token end it; so does GitHub's expiry by the clock", async () => {
    for (const [what, act] of [
      ["denied", (u: string) => gh.deny(u)],
      ["expired", (u: string) => gh.expire(u)],
    ] as const) {
      const s = steps(() => act(gh.codes[gh.codes.length - 1].userCode));
      const out = await runDeviceFlow({
        clientId: "x",
        client: client(),
        onCode: () => undefined,
        sleep: s.sleep,
        minIntervalMs: 0,
      });
      expect([what, out.kind]).toEqual([what, what]);
    }
    let now = 0;
    const out = await runDeviceFlow({
      clientId: "x",
      client: client(),
      onCode: () => undefined,
      sleep: async () => {
        now += 901_000;
      },
      now: () => now,
      minIntervalMs: 0,
    });
    expect(out.kind).toBe("expired");
  });

  it("a GitHub error on start names the cause, never a secret", async () => {
    await expect(client().start("")).rejects.toThrow(
      "GitHub doesn't know this client id (web.github_client_id)",
    );
  });

  it("GET /user with a bad token fails without echoing it", async () => {
    const token = "ghu_not_a_real_token_value";
    let msg = "";
    try {
      await client().user(token);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe("GitHub's /user answered 401");
    expect(msg.includes(token)).toBe(false);
  });
});
