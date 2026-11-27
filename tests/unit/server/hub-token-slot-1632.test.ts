import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { HubConfig } from "../../../src/shared/hub.js";
import { stateDirDenyRules } from "../../../src/shared/agents/den-claude.js";
import { sharedUserLines } from "../../../src/ui/cli/doctor-command.js";
import {
  HubConnect,
  hubTokenFile,
  hubTokenRotation,
  hubTokenSlot,
  isDensOwnRef,
  storeRefFor,
  type HubConnectDeps,
  type StoredToken,
} from "../../../src/ui/server/hub-connect.js";

const OLD_HUB = "https://old-hub.example.test";
const NEW_HUB = "https://new-hub.example.test";
const TOKEN = "hubi_TESTONLY_slot_new";
const ORIGIN = "http://localhost:7300";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-slot-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("issue 1632 part 4: each install and Hub has its own token slot", () => {
  it("the slot differs per Hub and per install, and is stable for the same pair", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    expect(hubTokenSlot(OLD_HUB, a)).toMatch(/^[0-9a-f]{10}$/);
    expect(hubTokenSlot(OLD_HUB, a)).toBe(hubTokenSlot(`${OLD_HUB}/x/y`, a));
    expect(hubTokenSlot(OLD_HUB, a)).not.toBe(hubTokenSlot(NEW_HUB, a));
    expect(hubTokenSlot(OLD_HUB, a)).not.toBe(hubTokenSlot(OLD_HUB, b));
  });

  it("the file, the 1Password item and the Doppler key each carry the slot", () => {
    expect(hubTokenFile(tmp, "0123456789")).toBe(
      path.join(tmp, "hub", "token-0123456789"),
    );
    expect(storeRefFor("1password", "0123456789")).toEqual({
      item: expect.stringMatching(/ Hub token 0123456789$/),
      field: "token",
    });
    expect(storeRefFor("doppler", "0123456789")).toEqual({
      key: expect.stringMatching(/_HUB_TOKEN_0123456789$/),
    });
  });

  it("a store item is Den's own only in the default vault: the same name in a vault a distribution chose is not", () => {
    const ours = storeRefFor("1password")!;
    const slotted = `${ours.item} 0123456789`;
    expect(isDensOwnRef({ item: slotted, field: "token" }, ours)).toBe(true);
    expect(isDensOwnRef({ item: ours.item, vault: "" }, ours)).toBe(true);
    expect(
      isDensOwnRef(
        { item: slotted, vault: "Distribution", field: "token" },
        ours,
      ),
    ).toBe(false);
    expect(isDensOwnRef({ item: `${ours.item} not-a-slot` }, ours)).toBe(false);
    const doppler = storeRefFor("doppler")!;
    expect(isDensOwnRef({ key: `${doppler.key}_0123456789` }, doppler)).toBe(
      true,
    );
  });

  it("rotation still owns a token kept in the old shared file, and one in a slot", () => {
    const own = hubTokenRotation({ file: hubTokenFile(tmp) });
    const at = (p: string) =>
      ({
        url: OLD_HUB,
        tokenRef: null,
        tokenSource: { kind: "file", path: p },
      }) as unknown as HubConfig;
    expect(own.owns(at(hubTokenFile(tmp)))).toBe(true);
    expect(own.owns(at(hubTokenFile(tmp, "0123456789")))).toBe(true);
    expect(own.owns(at(path.join(tmp, "elsewhere", "token")))).toBe(false);
  });
});

describe("issue 1632 part 4: a switch never overwrites the old Hub's token", () => {
  const oldCfg = {
    url: OLD_HUB,
    tokenRef: null,
    tokenSource: { kind: "file", path: "/state/hub/token-aaaaaaaaaa" },
    tokenFrom: "hub.token",
    allowTools: true,
  } as unknown as HubConfig;

  function harness(over: Partial<HubConnectDeps> = {}) {
    const order: string[] = [];
    let user: Record<string, unknown> = {
      hub: { url: OLD_HUB, token: "file:/state/hub/token-aaaaaaaaaa" },
    };
    const deps: HubConnectDeps = {
      now: () => 1_000_000,
      config: () => oldCfg,
      exchange: async () => ({
        token: TOKEN,
        company: { slug: "two" },
        hubUrl: NEW_HUB,
      }),
      revoke: async (url) => {
        order.push(`revoke ${url}`);
        return true;
      },
      store: async (_t, hubUrl): Promise<StoredToken> => {
        order.push(`store ${hubUrl}`);
        return {
          kind: "file",
          source: "file:/state/hub/token-bbbbbbbbbb",
          where: "/state/hub/token-bbbbbbbbbb",
        };
      },
      forget: async (c) =>
        void order.push(
          `forget ${c.tokenSource?.kind === "file" ? c.tokenSource.path : "ref"}`,
        ),
      readToken: async () => "hubi_TESTONLY_slot_old",
      readUser: () => structuredClone(user),
      writeUser: (u) => {
        order.push("write user.yml");
        user = structuredClone(u);
      },
      installLabel: () => "den on box",
      ...over,
    };
    const hc = new HubConnect(deps);
    const r = hc.start(ORIGIN, NEW_HUB);
    if (!r.ok) throw new Error(r.error);
    const state = new URL(r.location).searchParams.get("state")!;
    return { hc, order, state, user: () => user };
  }

  it("stores the new token for the new Hub, writes user.yml, then forgets the old slot", async () => {
    const h = harness();
    const r = await h.hc.finish(
      new URLSearchParams({ code: "c", state: h.state }),
    );
    expect(r.ok).toBe(true);
    expect(h.order).toEqual([
      `store ${NEW_HUB}`,
      "write user.yml",
      `revoke ${OLD_HUB}`,
      "forget /state/hub/token-aaaaaaaaaa",
    ]);
    expect(h.user().hub).toMatchObject({
      url: NEW_HUB,
      token: "file:/state/hub/token-bbbbbbbbbb",
    });
  });

  it("a crash before user.yml is written leaves the old Hub and its token as they were", async () => {
    const h = harness({
      writeUser: () => {
        h.order.push("write user.yml");
        throw new Error("crash");
      },
    });
    await h.hc
      .finish(new URLSearchParams({ code: "c", state: h.state }))
      .catch(() => undefined);
    expect(h.user().hub).toEqual({
      url: OLD_HUB,
      token: "file:/state/hub/token-aaaaaaaaaa",
    });
    expect(h.order).not.toContain("forget /state/hub/token-aaaaaaaaaa");
    expect(h.order).not.toContain(`revoke ${OLD_HUB}`);
  });

  it("the same slot back (same Hub, same install) is not forgotten", async () => {
    const h = harness({
      store: async (): Promise<StoredToken> => ({
        kind: "file",
        source: "file:/state/hub/token-aaaaaaaaaa",
        where: "/state/hub/token-aaaaaaaaaa",
      }),
    });
    await h.hc.finish(new URLSearchParams({ code: "c", state: h.state }));
    expect(h.order.some((s) => s.startsWith("forget"))).toBe(false);
  });
});

describe("issue 1632 part 4: a slot's token file is a credential like the old one", () => {
  it("agents' Read rules cover it", () => {
    const state = path.join(tmp, "deny-state");
    const rules = stateDirDenyRules(state, tmp);
    expect(rules).toContain(`Read(/${path.join(state, "hub")}/**)`);
  });

  it("doctor's sandbox-off row names the Hub token when only a slot holds it", () => {
    const state = fs.mkdtempSync(path.join(tmp, "doc-"));
    fs.mkdirSync(path.join(state, "hub"), { mode: 0o700 });
    fs.writeFileSync(path.join(state, "hub", "token-0123456789"), "x\n", {
      mode: 0o600,
    });
    const r = sharedUserLines("Den", {
      stateDir: state,
      registry: path.join(tmp, "doc-registry"),
      home: tmp,
      serverRunning: () => false,
      trailReadable: true,
      unsandboxed: () => [{ id: "a1", projects: [] }],
      reposOf: () => [],
    });
    const row = r.checks.find((c) => c.id === "agent_unsandboxed:a1")!;
    expect(row.detail).toContain("the Hub token");
  });
});
