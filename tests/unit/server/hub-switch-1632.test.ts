import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HubCallError, type HubConfig } from "../../../src/shared/hub.js";
import {
  checkHubAddress,
  runHubAddress,
} from "../../../src/ui/server/hub-address.js";
import {
  HubConnect,
  type HubConnectDeps,
  type StoredToken,
} from "../../../src/ui/server/hub-connect.js";
import {
  clearHubSwitch,
  hubSwitchFile,
  readHubSwitch,
  saveHubSwitch,
  switchBell,
  type HubSwitch,
} from "../../../src/ui/server/hub-switch.js";

const OLD = "https://old-hub.example.test";
const NEW = "https://new-hub.example.test";
const ORIGIN = "http://localhost:7300";
const OLD_TOKEN = "hubi_TESTONLY_old_1632";
const NEW_TOKEN = "hubi_TESTONLY_new_1632";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-switch-1632-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const connectedUser = () => ({
  hub: { url: OLD, token: "file:/state/hub/token" },
});

function addressDeps(user: Record<string, unknown>) {
  const calls: string[] = [];
  const switches: HubSwitch[] = [];
  let saved = structuredClone(user);
  return {
    calls,
    switches,
    saved: () => saved,
    d: {
      readUser: () => structuredClone(saved),
      writeUser: (u: Record<string, unknown>) => {
        calls.push("write");
        saved = u;
      },
      disconnect: async (force: boolean) => {
        calls.push(force ? "disconnect force" : "disconnect");
        return { ok: true };
      },
      changed: async (url: string | null) => void calls.push(`changed ${url}`),
      restart: async (reason: string) => {
        calls.push(`restart ${reason}`);
        return { ok: true };
      },
      switching: (s: HubSwitch) => void switches.push(s),
    },
  };
}

describe("issue 1632: hub_connect to another Hub keeps the old one until sign-in", () => {
  it("the Review says Den stays on the old Hub until the person signs in to the new one", () => {
    const x = addressDeps(connectedUser());
    const c = checkHubAddress(x.d, { url: NEW });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const keys = (c.detailKeys ?? []).map((k) => k?.key);
    expect(keys).toEqual([
      "ap.det.hub_connect.set",
      "ap.det.hub_connect.keep",
      "ap.det.hub_connect.signin",
    ]);
    expect(c.details?.join(" ")).toContain(OLD);
  });

  it("after the Allow: no disconnect, no write, no restart; a pending switch and the sign-in next", async () => {
    const x = addressDeps(connectedUser());
    const r = await runHubAddress(x.d, { url: NEW });
    expect(r).toMatchObject({ ok: true, url: NEW, connect: true });
    expect(x.calls).toEqual([]);
    expect(x.saved()).toEqual(connectedUser());
    expect(x.switches).toHaveLength(1);
    expect(x.switches[0]).toMatchObject({ to: NEW, from: OLD });
  });

  it("not connected yet, or clearing: as before (nothing to keep)", async () => {
    const x = addressDeps({ hub: { url: OLD } });
    await runHubAddress(x.d, { url: NEW });
    expect(x.switches).toEqual([]);
    expect(x.calls[0]).toBe("write");
    const y = addressDeps(connectedUser());
    await runHubAddress(y.d, { url: "none" });
    expect(y.switches).toEqual([]);
    expect(y.calls[0]).toBe("disconnect");
  });
});

describe("issue 1632: the pending switch on disk", () => {
  it("saves, reads back and clears; a broken or foreign file reads as none", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "s-"));
    expect(readHubSwitch(dir)).toBeNull();
    saveHubSwitch(dir, { to: NEW, from: OLD, at: "2026-11-25T00:00:00.000Z" });
    expect(readHubSwitch(dir)).toEqual({
      to: NEW,
      from: OLD,
      at: "2026-11-25T00:00:00.000Z",
    });
    expect((fs.statSync(hubSwitchFile(dir)).mode & 0o777).toString(8)).toBe(
      "600",
    );
    clearHubSwitch(dir);
    expect(readHubSwitch(dir)).toBeNull();
    fs.writeFileSync(hubSwitchFile(dir), "{not json");
    expect(readHubSwitch(dir)).toBeNull();
    fs.writeFileSync(
      hubSwitchFile(dir),
      JSON.stringify({ to: "http://plain.example.test", from: OLD, at: "x" }),
    );
    expect(readHubSwitch(dir)).toBeNull();
  });

  it("the bell: waiting names both Hubs and links to Settings › Hub; a failure says why, in its own key", () => {
    const s = { to: NEW, from: OLD, at: "2026-11-25T00:00:00.000Z" };
    const w = switchBell(s);
    expect(w.msg).toEqual({
      key: "bell.m.hubSwitchWaits",
      vars: { to: NEW, from: OLD },
    });
    expect(w.link).toBe("/settings#agents.hub");
    expect(w.subject).toMatch(/^record:hub-/);
    const f = switchBell(s, "Hub didn't give a token: 502");
    expect(f.msg).toEqual({
      key: "bell.m.hubSwitchFailed",
      vars: { to: NEW, from: OLD, why: "Hub didn't give a token: 502" },
    });
    expect(f.subject).toBe(w.subject);
  });
});

function harness(over: Partial<HubConnectDeps> = {}, pending?: HubSwitch) {
  let user: Record<string, unknown> = connectedUser();
  const revoked: string[] = [];
  const stored: string[] = [];
  const outcomes: { ok: boolean; why?: string }[] = [];
  const deps: HubConnectDeps = {
    now: () => 1_000_000,
    config: () =>
      ({
        url: OLD,
        tokenSource: { kind: "file", path: "/state/hub/token" },
      }) as unknown as HubConfig,
    exchange: async () => ({
      token: NEW_TOKEN,
      install: "den on box",
      role: "member",
      company: { name: "Acme Co", url: `${NEW}/c/acme` },
      hubUrl: NEW,
      mcpUrl: `${NEW}/mcp`,
    }),
    revoke: async (url, t) => {
      revoked.push(`${url} ${t === OLD_TOKEN ? "OLD" : "NEW"}`);
      return true;
    },
    store: async (t): Promise<StoredToken> => {
      stored.push(t === NEW_TOKEN ? "NEW" : "?");
      return {
        kind: "file",
        source: "file:/state/hub/token",
        where: "/state/hub/token",
      };
    },
    forget: async () => undefined,
    readToken: async () => OLD_TOKEN,
    readUser: () => structuredClone(user),
    writeUser: (u) => void (user = structuredClone(u)),
    installLabel: () => "den on box",
    hubSwitch: () => pending ?? null,
    switched: (r) => void outcomes.push(r),
    ...over,
  };
  return {
    hc: new HubConnect(deps),
    revoked,
    stored,
    outcomes,
    user: () => user,
  };
}

const PENDING: HubSwitch = { to: NEW, from: OLD, at: "2026-11-25T00:00:00Z" };

async function signIn(
  h: ReturnType<typeof harness>,
  q: Record<string, string>,
) {
  const r = h.hc.start(ORIGIN, "");
  if (!r.ok) throw new Error(r.error);
  const state = new URL(r.location).searchParams.get("state") ?? "";
  return h.hc.finish(new URLSearchParams({ state, ...q }));
}

describe("issue 1632: the sign-in finishes the switch, or leaves the old Hub", () => {
  it("Connect with no typed address goes to the pending switch's Hub", () => {
    const h = harness({}, PENDING);
    const r = h.hc.start(ORIGIN, "");
    expect(r.ok && new URL(r.location).origin).toBe(NEW);
  });

  it("a new Hub that refuses the code: still on the old Hub, its token unrevoked, and why", async () => {
    const h = harness(
      {
        exchange: async () => {
          throw new HubCallError(
            "unreachable",
            "Hub is down for maintenance",
            undefined,
            503,
          );
        },
      },
      PENDING,
    );
    const r = await signIn(h, { code: "c1" });
    expect(r.ok).toBe(false);
    expect(h.user()).toEqual(connectedUser());
    expect(h.stored).toEqual([]);
    expect(h.revoked).toEqual([]);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0].ok).toBe(false);
    expect(h.outcomes[0].why).toMatch(/maintenance/);
  });

  it("declined on the new Hub: still on the old one, and why", async () => {
    const h = harness({}, PENDING);
    const r = await signIn(h, { error: "access_denied" });
    expect(r.ok).toBe(false);
    expect(h.user()).toEqual(connectedUser());
    expect(h.outcomes).toEqual([
      { ok: false, why: "Not connected: the request was declined on Hub." },
    ]);
  });

  it("the new Hub answers: the address swaps, then the old token is revoked on the old Hub", async () => {
    const h = harness({}, PENDING);
    const r = await signIn(h, { code: "c2" });
    expect(r.ok).toBe(true);
    expect((h.user().hub as Record<string, unknown>).url).toBe(NEW);
    expect(h.stored).toEqual(["NEW"]);
    expect(h.revoked).toEqual([`${OLD} OLD`]);
    expect(h.outcomes).toEqual([{ ok: true }]);
  });

  it("a Connect to the Hub already in use is no switch: nothing is reported", async () => {
    const h = harness();
    const r = h.hc.start(ORIGIN, OLD);
    if (!r.ok) throw new Error(r.error);
    const state = new URL(r.location).searchParams.get("state") ?? "";
    await h.hc.finish(new URLSearchParams({ state, error: "access_denied" }));
    expect(h.outcomes).toEqual([]);
  });
});

describe("issue 1632: Settings › Hub shows a switch waiting for the sign-in", () => {
  type Mod = {
    hubHtml: (
      b: unknown,
      f: unknown,
      t: (k: string, v?: Record<string, unknown>) => string,
    ) => string;
  };
  const t = (k: string, v?: Record<string, unknown>) =>
    v ? `${k} ${JSON.stringify(v)}` : k;
  const load = () =>
    import("../../../src/ui/server/public/settings-registry.js") as unknown as Promise<Mod>;

  it("names both Hubs and offers the sign-in; none waiting, no row", async () => {
    const { hubHtml } = await load();
    const b = {
      configured: true,
      connected: true,
      state: "connected",
      url: OLD,
      team: "Acme Co",
    };
    const waiting = hubHtml(
      { ...b, switching: { to: NEW, from: OLD } },
      null,
      t,
    );
    const row = /<p[^>]*data-hub-switching[^>]*>(.*?)<\/p>/s.exec(waiting)?.[1];
    expect(row).toContain(NEW);
    expect(row).toContain(OLD);
    expect(row).toMatch(/data-hub-action="connect"/);
    expect(hubHtml(b, null, t)).not.toContain("data-hub-switching");
  });
});
