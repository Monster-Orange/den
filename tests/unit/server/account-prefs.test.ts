/**
 * Issue 784: a person's own settings, in areas (attention, sounds, keys,
 * layout), each holding only that person's overrides. One record per
 * person; a write names the rev it read, and a stale one is refused with
 * what is there now, so two Dens or tabs never overwrite each other
 * unseen. A person's request only: an agent's is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  accountPrefsFile,
  handleAccountPrefsRoute,
  readAccountPrefs,
  registerAccountArea,
  resetAccountAreasForTest,
  writeAccountArea,
  type AccountPrefsDeps,
} from "../../../src/ui/server/account-prefs.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-prefs-"));
  resetAccountAreasForTest();
  registerAccountArea("keys", (v) =>
    typeof (v as { bindings?: unknown }).bindings === "object"
      ? null
      : "keys: bindings must be an object",
  );
  registerAccountArea("layout", () => null);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the store (issue 784)", () => {
  it("a person with nothing saved reads no areas and no revs", () => {
    expect(readAccountPrefs(dir, "gh:ana")).toEqual({ areas: {}, revs: {} });
  });

  it("a write at the rev it read is saved, and the rev goes up", () => {
    const r = writeAccountArea(dir, "gh:ana", "keys", {
      value: { v: 1, bindings: { "open-palette": "Mod+K" } },
      rev: 0,
    });
    expect(r).toEqual({ ok: true, rev: 1 });
    expect(readAccountPrefs(dir, "gh:ana")).toEqual({
      areas: { keys: { v: 1, bindings: { "open-palette": "Mod+K" } } },
      revs: { keys: 1 },
    });
  });

  it("a stale rev is refused with what is there now", () => {
    writeAccountArea(dir, "gh:ana", "keys", {
      value: { v: 1, bindings: { a: "Mod+A" } },
      rev: 0,
    });
    const r = writeAccountArea(dir, "gh:ana", "keys", {
      value: { v: 1, bindings: {} },
      rev: 0,
    });
    expect(r).toEqual({
      ok: false,
      status: 409,
      error: expect.stringMatching(/changed elsewhere/),
      current: { value: { v: 1, bindings: { a: "Mod+A" } }, rev: 1 },
    });
  });

  it("each area has its own rev: a change to one never refuses another", () => {
    writeAccountArea(dir, "gh:ana", "keys", {
      value: { v: 1, bindings: {} },
      rev: 0,
    });
    expect(
      writeAccountArea(dir, "gh:ana", "layout", { value: { v: 1 }, rev: 0 }),
    ).toEqual({ ok: true, rev: 1 });
    expect(readAccountPrefs(dir, "gh:ana").revs).toEqual({
      keys: 1,
      layout: 1,
    });
  });

  it("null clears an area back to its defaults", () => {
    writeAccountArea(dir, "gh:ana", "keys", {
      value: { v: 1, bindings: {} },
      rev: 0,
    });
    expect(
      writeAccountArea(dir, "gh:ana", "keys", { value: null, rev: 1 }),
    ).toEqual({ ok: true, rev: 2 });
    // Cleared, and its rev kept going, so a stale write still is refused.
    expect(readAccountPrefs(dir, "gh:ana")).toEqual({
      areas: {},
      revs: { keys: 2 },
    });
    expect(
      writeAccountArea(dir, "gh:ana", "keys", { value: null, rev: 1 }),
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("one person's areas never touch another's", () => {
    writeAccountArea(dir, "gh:ana", "keys", {
      value: { v: 1, bindings: {} },
      rev: 0,
    });
    expect(readAccountPrefs(dir, "gh:bo")).toEqual({ areas: {}, revs: {} });
  });

  it("an unknown area, a bad value, a missing version or one too big is refused", () => {
    const w = (area: string, value: unknown, maxKb = 64) =>
      writeAccountArea(dir, "gh:ana", area, { value, rev: 0 }, maxKb);
    expect(w("colours", { v: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(w("keys", { v: 1, bindings: 3 })).toMatchObject({
      ok: false,
      status: 400,
      error: "keys: bindings must be an object",
    });
    expect(w("keys", { bindings: {} })).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringMatching(/version/),
    });
    expect(w("layout", { v: 1, pad: "x".repeat(2048) }, 1)).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(fs.existsSync(accountPrefsFile(dir, "gh:ana"))).toBe(false);
  });

  it("a person's key can't name a path", () => {
    expect(() => accountPrefsFile(dir, "../x")).toThrow();
    expect(path.dirname(accountPrefsFile(dir, "gh:ana"))).toBe(
      path.join(dir, "account-prefs"),
    );
  });
});

describe("the API (issue 784)", () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    await new Promise((r) => (server ? server.close(r) : r(undefined)));
    server = null;
  });

  async function serve(who: string | null): Promise<string> {
    const deps: AccountPrefsDeps = {
      stateDir: () => dir,
      personKey: () => who,
      maxKb: () => 64,
    };
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      void handleAccountPrefsRoute(req, res, url.pathname, deps).then(
        (done) => {
          if (!done) res.writeHead(404).end();
        },
      );
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("GET reads the person's areas; PUT saves one at its rev", async () => {
    const base = await serve("gh:ana");
    expect(await (await fetch(`${base}/api/account/prefs`)).json()).toEqual({
      areas: {},
      revs: {},
    });
    const put = await fetch(`${base}/api/account/prefs/keys`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: { v: 1, bindings: {} }, rev: 0 }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true, rev: 1 });
    const stale = await fetch(`${base}/api/account/prefs/keys`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: { v: 1, bindings: {} }, rev: 0 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      current: { value: { v: 1, bindings: {} }, rev: 1 },
    });
  });

  it("an agent (no person) is refused, and nothing is saved", async () => {
    const base = await serve(null);
    expect((await fetch(`${base}/api/account/prefs`)).status).toBe(403);
    const put = await fetch(`${base}/api/account/prefs/keys`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: { v: 1, bindings: {} }, rev: 0 }),
    });
    expect(put.status).toBe(403);
    expect(fs.existsSync(path.join(dir, "account-prefs"))).toBe(false);
  });

  it("a body that isn't JSON, or a rev that isn't a whole number, is 400", async () => {
    const base = await serve("gh:ana");
    const bad = (body: string) =>
      fetch(`${base}/api/account/prefs/keys`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      }).then((r) => r.status);
    expect(await bad("{")).toBe(400);
    expect(await bad(JSON.stringify({ value: null, rev: "1" }))).toBe(400);
  });

  it("other paths are not this route's", async () => {
    const base = await serve("gh:ana");
    expect((await fetch(`${base}/api/account/other`)).status).toBe(404);
  });
});
