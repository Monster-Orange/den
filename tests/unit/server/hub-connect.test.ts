/**
 * HUB-1.7: Connect to Hub, the server half (src/ui/server/hub-connect.ts).
 * PKCE and a single-use state; what comes back from Hub (approved,
 * declined, too old, replayed, a refused code); where the token is kept
 * (the install's store, else Den's own 0600 file) and what user.yml says;
 * a token that can't be kept is revoked; Disconnect revokes, then removes;
 * the callback page and the last result never carry the token.
 *
 * Fakes for Hub and the store; a temp state dir. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HubCallError, type HubConfig } from "../../../src/shared/hub.js";
import {
  CONNECT_TTL_MS,
  HubConnect,
  callbackOriginProblem,
  callbackPage,
  defaultInstallLabel,
  hubTokenFile,
  storeRefFor,
  type HubConnectDeps,
  type StoredToken,
} from "../../../src/ui/server/hub-connect.js";

const TOKEN = "hubi_TESTONLY_hc_42d9";
const ORIGIN = "http://localhost:7300";
const HUB = "https://hub.example.test";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-connect-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function harness(over: Partial<HubConnectDeps> = {}) {
  let now = 1_000_000;
  let user: Record<string, unknown> = {};
  const exchanged: {
    url: string;
    code: string;
    verifier: string;
    redirectUri: string;
  }[] = [];
  const revoked: string[] = [];
  const forgot: HubConfig[] = [];
  const deps: HubConnectDeps = {
    now: () => now,
    config: () => null,
    exchange: async (url, g) => {
      exchanged.push({ url, ...g });
      return {
        token: TOKEN,
        install: "den on box",
        role: "member",
        company: { name: "Acme Co", url: `${HUB}/c/acme` },
        hubUrl: HUB,
        mcpUrl: `${HUB}/mcp`,
      };
    },
    revoke: async (url, t) => {
      revoked.push(`${url} ${t === TOKEN ? "TOKEN" : t}`);
      return true;
    },
    store: async (): Promise<StoredToken> => ({
      kind: "file",
      source: "file:/state/hub/token",
      where: "/state/hub/token",
    }),
    forget: async (c) => void forgot.push(c),
    readToken: async () => TOKEN,
    readUser: () => structuredClone(user),
    writeUser: (u) => void (user = structuredClone(u)),
    installLabel: () => "den on box",
    ...over,
  };
  return {
    hc: new HubConnect(deps),
    exchanged,
    revoked,
    forgot,
    user: () => user,
    setUser: (u: Record<string, unknown>) => void (user = u),
    tick: (ms: number) => void (now += ms),
  };
}

/** Start, then read back what Den sent Hub. */
function start(h: ReturnType<typeof harness>, url: unknown = HUB) {
  const r = h.hc.start(ORIGIN, url);
  if (!r.ok) throw new Error(r.error);
  const u = new URL(r.location);
  return { u, q: Object.fromEntries(u.searchParams) };
}
const back = (q: Record<string, string>) => new URLSearchParams(q);

describe("start: Hub's /connect URL", () => {
  it("names this install, the callback, a fresh state and an S256 challenge", () => {
    const h = harness();
    const { u, q } = start(h);
    expect(`${u.origin}${u.pathname}`).toBe(`${HUB}/connect`);
    expect(q).toMatchObject({
      install: "den on box",
      redirect_uri: `${ORIGIN}/hub/callback`,
      code_challenge_method: "S256",
    });
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.state.length).toBeGreaterThanOrEqual(8);
    expect(start(h).q.state).not.toBe(q.state);
  });

  it("the typed address, else hub.url; none, a bad one, or a foreign page origin is refused in words", () => {
    const h = harness({
      config: () =>
        ({ url: "https://preset.example.test" }) as unknown as HubConfig,
    });
    expect(start(h, "").u.origin).toBe("https://preset.example.test");
    expect(start(h, `${HUB}/`).u.origin).toBe(HUB);
    expect(harness().hc.start(ORIGIN, "")).toEqual({
      ok: false,
      error: "type Hub's address first",
    });
    expect(harness().hc.start(ORIGIN, "http://hub.example.test")).toMatchObject(
      {
        ok: false,
        error: /Hub's address/,
      },
    );
    expect(harness().hc.start("http://den.example.test", HUB)).toMatchObject({
      ok: false,
      error: /https or to localhost/,
    });
  });
});

describe("finish: what comes back from Hub", () => {
  it("approved: trades the code with the verifier, keeps the token, writes hub.* in user.yml", async () => {
    const h = harness();
    h.setUser({ hub: { allow_tools: false }, other: 1 });
    const { q } = start(h);
    const r = await h.hc.finish(back({ state: q.state, code: "c1" }));
    expect(r).toMatchObject({ ok: true, team: "Acme Co" });
    // PKCE: what Den sent Hub at /connect/token matches the challenge.
    const x = h.exchanged[0];
    expect(x).toMatchObject({
      url: HUB,
      code: "c1",
      redirectUri: `${ORIGIN}/hub/callback`,
    });
    expect(
      crypto.createHash("sha256").update(x.verifier).digest("base64url"),
    ).toBe(q.code_challenge);
    expect(h.user()).toEqual({
      other: 1,
      hub: {
        allow_tools: false,
        url: HUB,
        token: "file:/state/hub/token",
        mcp_url: `${HUB}/mcp`,
      },
    });
    expect(JSON.stringify(h.user())).not.toContain(TOKEN);
  });

  it("a store ref goes into hub.token as the ref, never the value", async () => {
    const h = harness({
      store: async () => ({
        kind: "ref",
        ref: { item: "Acme Hub token", field: "token" },
        where: "1Password: Acme Hub token",
      }),
    });
    const { q } = start(h);
    await h.hc.finish(back({ state: q.state, code: "c1" }));
    expect((h.user().hub as Record<string, unknown>).token).toEqual({
      item: "Acme Hub token",
      field: "token",
    });
  });

  it("the state is single use: a replay, an unknown state, or one past 10 minutes changes nothing", async () => {
    const h = harness();
    const { q } = start(h);
    expect((await h.hc.finish(back({ state: q.state, code: "c1" }))).ok).toBe(
      true,
    );
    h.setUser({});
    expect(
      await h.hc.finish(back({ state: q.state, code: "c1" })),
    ).toMatchObject({ ok: false, reason: "expired" });
    expect(
      await h.hc.finish(back({ state: "made-up-state", code: "c1" })),
    ).toMatchObject({ ok: false, reason: "expired" });
    const late = start(h).q;
    h.tick(CONNECT_TTL_MS + 1);
    expect(
      await h.hc.finish(back({ state: late.state, code: "c2" })),
    ).toMatchObject({ ok: false, reason: "expired" });
    expect(h.exchanged).toHaveLength(1);
    expect(h.user()).toEqual({});
  });

  it("declined on Hub: says so, nothing traded or written", async () => {
    const h = harness();
    const { q } = start(h);
    expect(
      await h.hc.finish(back({ state: q.state, error: "access_denied" })),
    ).toEqual({
      ok: false,
      reason: "denied",
      message: "Not connected: the request was declined on Hub.",
    });
    expect(h.exchanged).toEqual([]);
    expect(h.user()).toEqual({});
  });

  it("Hub refuses the code: press Connect again", async () => {
    const h = harness({
      exchange: async () => {
        throw new HubCallError(
          "refused",
          "Hub refused it (400)",
          "invalid_grant",
        );
      },
    });
    const { q } = start(h);
    expect(
      await h.hc.finish(back({ state: q.state, code: "c1" })),
    ).toMatchObject({
      ok: false,
      reason: "failed",
      message: /press Connect again/,
    });
    expect(h.user()).toEqual({});
  });

  it("a token that can't be kept is revoked on Hub, and nothing is written", async () => {
    const h = harness({
      store: async () => {
        throw new Error("disk full");
      },
    });
    const { q } = start(h);
    const r = await h.hc.finish(back({ state: q.state, code: "c1" }));
    expect(r).toMatchObject({ ok: false, message: /disk full.*revoked/ });
    expect(h.revoked).toEqual([`${HUB} TOKEN`]);
    expect(h.user()).toEqual({});
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("the last result is words, read once, and never the token", async () => {
    const h = harness();
    const { q } = start(h);
    await h.hc.finish(back({ state: q.state, code: "c1" }));
    const last = h.hc.lastResult();
    expect(last).toEqual({ ok: true, message: "Connected to Hub (Acme Co)." });
    expect(h.hc.lastResult()).toBeNull();
  });

  it("at most 16 connects wait; the oldest goes first", async () => {
    const h = harness();
    const first = start(h).q.state;
    for (let i = 0; i < 16; i++) start(h);
    expect(await h.hc.finish(back({ state: first, code: "c" }))).toMatchObject({
      reason: "expired",
    });
  });
});

describe("disconnect", () => {
  const cfg = {
    url: HUB,
    tokenRef: null,
    tokenSource: { kind: "file", path: "/state/hub/token" },
    tokenFrom: "hub.token",
    allowTools: true,
  } as unknown as HubConfig;

  it("revokes on Hub, forgets it here, and clears hub.token and hub.mcp_url (hub.url stays)", async () => {
    const h = harness({ config: () => cfg });
    h.setUser({
      hub: { url: HUB, token: "file:/state/hub/token", mcp_url: `${HUB}/mcp` },
    });
    expect(await h.hc.disconnect()).toEqual({
      ok: true,
      revoked: true,
      message: "Disconnected. Hub revoked this install's token.",
    });
    expect(h.revoked).toEqual([`${HUB} TOKEN`]);
    expect(h.forgot).toEqual([cfg]);
    expect(h.user()).toEqual({ hub: { url: HUB } });
  });

  it("Hub unreachable: nothing removed unless forced, and then it says Hub still has it", async () => {
    const h = harness({
      config: () => cfg,
      revoke: async () => {
        throw new HubCallError("unreachable", "Hub did not answer in 5000 ms");
      },
    });
    h.setUser({ hub: { url: HUB, token: "file:/state/hub/token" } });
    expect(await h.hc.disconnect()).toMatchObject({
      ok: false,
      error: /Nothing was removed/,
    });
    expect(h.forgot).toEqual([]);
    expect(h.user()).toEqual({
      hub: { url: HUB, token: "file:/state/hub/token" },
    });
    expect(await h.hc.disconnect(true)).toMatchObject({
      ok: true,
      revoked: false,
      message: /still works there until an admin revokes/,
    });
    expect(h.user()).toEqual({ hub: { url: HUB } });
  });

  it("already revoked on Hub (401): removed here, saying so", async () => {
    const h = harness({ config: () => cfg, revoke: async () => false });
    expect(await h.hc.disconnect()).toMatchObject({
      ok: true,
      revoked: false,
      message: /already revoked/,
    });
  });

  it("not connected: nothing to do", async () => {
    expect(await harness().hc.disconnect()).toEqual({
      ok: true,
      revoked: false,
      message: "Not connected.",
    });
  });
});

describe("the pieces", () => {
  it("the callback page moves on to Settings with the result, escapes its words, keeps no referrer", () => {
    const ok = callbackPage("Acme", { ok: true, message: "Connected <b>" });
    expect(ok).toContain(
      'location.replace("/settings?hub=connected#agents.hub")',
    );
    expect(ok).toContain("&#60;b&#62;");
    expect(ok).toContain('<meta name="referrer" content="no-referrer">');
    expect(
      callbackPage("Acme", { ok: false, reason: "denied", message: "x" }),
    ).toContain("/settings?hub=denied#agents.hub");
  });

  it("Hub can send the person back only to https or this machine", () => {
    expect(callbackOriginProblem("https://den.example.test")).toBeNull();
    expect(callbackOriginProblem("http://localhost:7000")).toBeNull();
    expect(callbackOriginProblem("http://127.0.0.1:7000")).toBeNull();
    expect(callbackOriginProblem("http://den.example.test")).toMatch(/https/);
    expect(callbackOriginProblem("nonsense")).toMatch(/isn't one Hub/);
  });

  it("the install label fits Hub's rule (1–40 of [A-Za-z0-9 ._-], letter or digit first)", () => {
    const rule = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
    expect(defaultInstallLabel("acme", "north-box.local")).toBe(
      "acme on north-box",
    );
    expect(defaultInstallLabel("acme", "Pat's MacBook Pro (2)")).toMatch(rule);
    expect(defaultInstallLabel("_x", "a".repeat(80))).toMatch(rule);
  });

  it("the store a token goes to: 1Password item or Doppler key; env and none keep none", () => {
    expect(storeRefFor("1password")).toEqual({
      item: expect.stringMatching(/ Hub token$/),
      field: "token",
    });
    expect(storeRefFor("doppler")).toEqual({
      key: expect.stringMatching(/_HUB_TOKEN$/),
    });
    expect(storeRefFor("env")).toBeNull();
    expect(storeRefFor("none")).toBeNull();
  });

  it("Den's own token file lives under the state dir", () => {
    expect(hubTokenFile(tmp)).toBe(path.join(tmp, "hub", "token"));
  });
});
