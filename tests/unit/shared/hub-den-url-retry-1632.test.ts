import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  denUrlTellDue,
  denUrlTellRow,
  readDenUrlTell,
  retryDenUrlTell,
  tellHubDenUrl,
  type DenUrlTell,
} from "../../../src/shared/hub/hub-den-url.js";
import { HubCallError } from "../../../src/shared/hub.js";
import { setConfigAuditSink } from "../../../src/shared/config-audit.js";
import {
  HubConnect,
  type HubConnectDeps,
} from "../../../src/ui/server/hub-connect.js";

const ADDR = "https://den.example.test";
const OLD = "https://hub-one.example.test";
const NEW = "https://hub-two.example.test";
const TOKEN = "hubi_TESTONLY_retry_1632";

let dir = "";
beforeEach(() => {
  setConfigAuditSink(null);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-url-retry-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const tell = (over: Partial<DenUrlTell>): DenUrlTell => ({
  at: "2026-11-26T00:00:00.000Z",
  url: ADDR,
  outcome: "changed",
  hub: NEW,
  ...over,
});

describe("issue 1632: a tell names its Hub", () => {
  it("the record says which Hub was told", async () => {
    await tellHubDenUrl(ADDR, {
      hub: async () => ({ url: `${NEW}/`, token: TOKEN }),
      put: async () => ({ changed: true }),
      stateDir: dir,
    });
    expect(readDenUrlTell(dir)?.hub).toBe(NEW);
  });
});

describe("issue 1632: when the connected Hub still needs this Den's address", () => {
  it("due: never told, told another Hub or address, or the last try failed", () => {
    expect(denUrlTellDue(null, ADDR, NEW)).toBe(true);
    expect(denUrlTellDue(tell({ hub: OLD }), ADDR, NEW)).toBe(true);
    expect(denUrlTellDue(tell({ hub: undefined }), ADDR, NEW)).toBe(true);
    expect(
      denUrlTellDue(tell({ url: "https://x.example.test" }), ADDR, NEW),
    ).toBe(true);
    for (const outcome of ["refused", "unreachable", "not_connected"] as const)
      expect(denUrlTellDue(tell({ outcome }), ADDR, NEW)).toBe(true);
  });

  it("not due: this Hub has it, this Hub is too old to take it, or nothing to tell", () => {
    expect(denUrlTellDue(tell({}), ADDR, NEW)).toBe(false);
    expect(denUrlTellDue(tell({ outcome: "unchanged" }), ADDR, NEW)).toBe(
      false,
    );
    expect(denUrlTellDue(tell({ outcome: "old_hub" }), ADDR, NEW)).toBe(false);
    expect(denUrlTellDue(null, null, NEW)).toBe(false);
    expect(denUrlTellDue(null, ADDR, null)).toBe(false);
  });
});

describe("issue 1632: a failed tell is sent again at the next sync", () => {
  it("the first tell fails; the next sync sends it; once it lands, syncs send nothing", async () => {
    const puts: string[] = [];
    let up = false;
    const deps = {
      hub: async () => ({ url: NEW, token: TOKEN }),
      put: async (h: string) => {
        puts.push(h);
        if (!up) throw new HubCallError("unreachable", "down", undefined, 503);
        return { changed: true };
      },
      stateDir: dir,
      denUrl: () => ADDR,
    };
    await tellHubDenUrl(ADDR, deps);
    expect(readDenUrlTell(dir)?.outcome).toBe("unreachable");
    up = true;
    expect((await retryDenUrlTell(deps))?.outcome).toBe("changed");
    expect(await retryDenUrlTell(deps)).toBeNull();
    expect(puts).toEqual([NEW, NEW]);
  });

  it("not connected, or no address of its own: nothing is sent", async () => {
    const puts: string[] = [];
    const put = async (h: string) => void puts.push(h);
    expect(
      await retryDenUrlTell({
        hub: async () => null,
        put,
        stateDir: dir,
        denUrl: () => ADDR,
      }),
    ).toBeNull();
    expect(
      await retryDenUrlTell({
        hub: async () => ({ url: NEW, token: TOKEN }),
        put,
        stateDir: dir,
        denUrl: () => null,
      }),
    ).toBeNull();
    expect(puts).toEqual([]);
  });
});

describe("issue 1632: Doctor says while the Hub doesn't know this Den's address", () => {
  it("a row while it's due, with the last try's outcome", () => {
    const r = denUrlTellRow(
      tell({ outcome: "unreachable", status: 503 }),
      ADDR,
      NEW,
    );
    expect(r?.detail).toContain("Hub doesn't know this Den's address yet");
    expect(r?.detail).toContain(ADDR);
    expect(r?.detail).toMatch(/unreachable/);
  });

  it("no row once the Hub has it", () => {
    expect(denUrlTellRow(tell({}), ADDR, NEW)).toBeNull();
  });
});

describe("issue 1632: Connect doesn't wait on the tell", () => {
  it("a tell that never answers doesn't hold the sign-in", async () => {
    let user: Record<string, unknown> = {};
    const deps: HubConnectDeps = {
      now: () => 1_000_000,
      config: () => null,
      exchange: async () => ({
        token: TOKEN,
        install: "den on box",
        role: "member",
        company: { name: "Two", url: `${NEW}/c/two` },
        hubUrl: NEW,
        mcpUrl: `${NEW}/mcp`,
      }),
      revoke: async () => true,
      store: async () => ({
        kind: "file",
        source: "file:/state/hub/token",
        where: "/state/hub/token",
      }),
      forget: async () => undefined,
      readToken: async () => null,
      readUser: () => structuredClone(user),
      writeUser: (u) => void (user = structuredClone(u)),
      installLabel: () => "den on box",
      tellDenUrl: () => new Promise(() => undefined),
    };
    const hc = new HubConnect(deps);
    const r = hc.start("http://localhost:7300", NEW);
    if (!r.ok) throw new Error(r.error);
    const state = new URL(r.location).searchParams.get("state") ?? "";
    const done = await Promise.race([
      hc.finish(new URLSearchParams({ state, code: "c1" })).then((x) => x.ok),
      new Promise((res) => setTimeout(() => res("held"), 2000)),
    ]);
    expect(done).toBe(true);
  });
});

describe("issue 1632: the Hub's words are cleaned before Doctor prints them", () => {
  const nasty =
    "bad\x1b]52;c;ZXZpbA==\x07 \x1b[31mred\x1b[0m\n" + "x".repeat(500);
  const clean = (s: string | undefined) =>
    expect(s ?? "").toMatch(/^[\x20-\x7e]*$/);

  it("a new tell records the error as one printable line, at most 200 characters", async () => {
    await tellHubDenUrl(ADDR, {
      hub: async () => ({ url: NEW, token: TOKEN }),
      put: async () => {
        throw new HubCallError("rejected", nasty, undefined, 401);
      },
      stateDir: dir,
    });
    const t = readDenUrlTell(dir);
    clean(t?.error);
    expect((t?.error ?? "").length).toBeLessThanOrEqual(200);
  });

  it("an older record with raw text is cleaned in Doctor's row", () => {
    const r = denUrlTellRow(
      tell({ outcome: "refused", status: 401, error: nasty }),
      ADDR,
      NEW,
    );
    clean(r?.detail);
    expect(r?.detail).not.toContain("\x1b");
  });

  it("an outcome the file shouldn't hold is cleaned too", () => {
    const r = denUrlTellRow(
      tell({ outcome: "\x1b]0;title\x07" as never, hub: OLD }),
      ADDR,
      NEW,
    );
    clean(r?.detail);
  });
});
