import { describe, expect, it } from "@jest/globals";
import { HubCallError } from "../../../src/shared/hub.js";
import {
  HubConnect,
  type HubConnectDeps,
  type StoredToken,
} from "../../../src/ui/server/hub-connect.js";

const ORIGIN = "http://localhost:7300";
const OLD = "https://hub-one.example.test";
const NEW = "https://hub-two.example.test";
const OLD_TOKEN = "hubi_TESTONLY_old_tell";
const NEW_TOKEN = "hubi_TESTONLY_new_tell";

function harness(over: Partial<HubConnectDeps> = {}) {
  let user: Record<string, unknown> = {
    hub: { url: OLD, token: { kind: "file" } },
  };
  const told: string[] = [];
  const deps: HubConnectDeps = {
    now: () => 1_000_000,
    config: () => null,
    exchange: async () => ({
      token: NEW_TOKEN,
      install: "den on box",
      role: "member",
      company: { name: "Two", url: `${NEW}/c/two` },
      hubUrl: NEW,
      mcpUrl: `${NEW}/mcp`,
    }),
    revoke: async () => true,
    store: async (): Promise<StoredToken> => ({
      kind: "file",
      source: "file:/state/hub/token",
      where: "/state/hub/token",
    }),
    forget: async () => undefined,
    readToken: async () => OLD_TOKEN,
    readUser: () => structuredClone(user),
    writeUser: (u) => void (user = structuredClone(u)),
    installLabel: () => "den on box",
    tellDenUrl: async (url, token) => {
      told.push(
        `${url} ${token === NEW_TOKEN ? "NEW" : token === OLD_TOKEN ? "OLD" : token}`,
      );
    },
    ...over,
  };
  return { hc: new HubConnect(deps), told, user: () => user };
}

async function signIn(h: ReturnType<typeof harness>, url = NEW) {
  const r = h.hc.start(ORIGIN, url);
  if (!r.ok) throw new Error(r.error);
  const state = new URL(r.location).searchParams.get("state") ?? "";
  return h.hc.finish(new URLSearchParams({ state, code: "c1" }));
}

describe("issue 1632: the new Hub learns this Den's address at Connect", () => {
  it("after a good exchange, the new Hub is told once, with its own token; the old Hub never", async () => {
    const h = harness();
    const r = await signIn(h);
    expect(r.ok).toBe(true);
    expect(h.told).toEqual([`${NEW} NEW`]);
  });

  it("a failed exchange tells no Hub", async () => {
    const h = harness({
      exchange: async () => {
        throw new HubCallError("unreachable", "Hub is down", undefined, 503);
      },
    });
    const r = await signIn(h);
    expect(r.ok).toBe(false);
    expect(h.told).toEqual([]);
  });

  it("a failed tell doesn't fail the Connect", async () => {
    const h = harness({
      tellDenUrl: async () => {
        throw new Error("Hub refused");
      },
    });
    const r = await signIn(h);
    expect(r.ok).toBe(true);
    expect((h.user().hub as { url?: string }).url).toBe(NEW);
  });
});
