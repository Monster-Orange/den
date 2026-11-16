/**
 * Issue 103, framing and the embedded pane's keys:
 *
 *   - an origin is exact: scheme://host[:port] as the browser writes it,
 *     http or https; never `*`, a path, a prefix or a part;
 *   - every page is framed by Den only (frame-ancestors 'self',
 *     X-Frame-Options SAMEORIGIN); the embedded pane only by the listed
 *     origins (none: 'none');
 *   - a key is bound to its project, agent and origin, and expires.
 *
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { EmbedKeys } from "../../../src/ui/server/embed-keys.js";
import {
  checkOrigin,
  embedSettings,
  frameHeaders,
  originListed,
  patchEmbed,
} from "../../../src/ui/server/embed-settings.js";
import { embedConfigJson } from "../../../src/ui/server/embed-routes.js";
import type { UserConfig } from "../../../src/shared/den-config.js";

describe("an origin, exactly", () => {
  it.each([
    "https://app.example.test",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "https://[::1]:8443",
  ])("%s is one", (o) => {
    expect(checkOrigin(o)).toEqual({ ok: true, origin: o });
  });

  it.each([
    "*",
    "https://*.example.test",
    "https://app.example.test/",
    "https://app.example.test/path",
    "https://APP.example.test",
    "https://app.example.test:443",
    "https://me:pw@app.example.test",
    "ftp://app.example.test",
    "javascript:alert(1)",
    "null",
    "app.example.test",
    " https://app.example.test",
    "",
    42,
  ])("%p is not", (o) => {
    expect(checkOrigin(o).ok).toBe(false);
  });

  it("listed means equal: never a prefix, a part or a longer name", () => {
    const list = ["https://app.example.test"];
    expect(originListed("https://app.example.test", list)).toBe(true);
    for (const o of [
      "https://app.example.test.evil.test",
      "https://evil.test?https://app.example.test",
      "https://app.example.tes",
      "http://app.example.test",
      "https://app.example.test:8443",
      "null",
      "",
      undefined,
    ])
      expect([o, originListed(o, list)]).toEqual([o, false]);
  });
});

describe("Settings › Embedding: the list and the key's life", () => {
  it("none listed by default; a list of exact origins is kept; null clears", () => {
    const u: UserConfig = {};
    expect(embedSettings(u).origins).toEqual([]);
    expect(embedSettings(u).key_minutes).toBe(15);
    expect(
      patchEmbed(u, {
        origins: ["https://app.example.test", "https://app.example.test"],
        key_minutes: 5,
      }),
    ).toEqual({ ok: true });
    expect(embedSettings(u)).toMatchObject({
      origins: ["https://app.example.test"],
      key_minutes: 5,
    });
    expect(patchEmbed(u, { origins: null, key_minutes: null })).toEqual({
      ok: true,
    });
    expect(u.embed).toBeUndefined();
  });

  it("refuses a list with one bad origin, and writes nothing", () => {
    const u: UserConfig = {};
    const r = patchEmbed(u, {
      origins: ["https://app.example.test", "https://*.example.test"],
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/wildcard/);
    expect(patchEmbed(u, { origins: "https://app.example.test" }).ok).toBe(
      false,
    );
    expect(patchEmbed(u, { key_minutes: 0 }).ok).toBe(false);
    expect(u.embed).toBeUndefined();
  });

  it("a hand-written bad origin in user.yml is dropped, never matched", () => {
    expect(
      embedSettings({
        embed: { origins: ["*", "https://a.example.test/", "https://b.test"] },
      }).origins,
    ).toEqual(["https://b.test"]);
  });
});

describe("frame headers", () => {
  const none = () => [] as string[];
  it.each([
    "/",
    "/agents",
    "/settings",
    "/p/north/agents/scout",
    "/api/settings",
    "/report/index.html",
    "/no-such-page",
    "/embed/connect",
  ])("%s: Den only", (p) => {
    expect(frameHeaders(p, () => ["https://app.example.test"])).toEqual({
      "Content-Security-Policy": "frame-ancestors 'self'",
      "X-Frame-Options": "SAMEORIGIN",
    });
  });

  it("the embedded pane: nobody when none is listed", () => {
    expect(frameHeaders("/embed/p/north/agents/scout", none)).toEqual({
      "Content-Security-Policy": "frame-ancestors 'none'",
    });
  });

  it("the embedded pane: exactly the listed origins, nothing else", () => {
    expect(
      frameHeaders("/embed/p/north/agents/scout", () => [
        "https://app.example.test",
        "http://127.0.0.1:5173",
        "*",
      ]),
    ).toEqual({
      "Content-Security-Policy":
        "frame-ancestors https://app.example.test http://127.0.0.1:5173",
    });
  });

  it("the pane's config can't close its script tag", () => {
    const j = embedConfigJson({
      project: "north",
      agent: "scout",
      origins: ["https://a.test"],
    });
    expect(j).not.toContain("<");
    expect(
      embedConfigJson({ project: "</script>", agent: "a", origins: [] }),
    ).not.toContain("</script>");
  });
});

describe("the embedded pane's keys", () => {
  const grant = {
    project: "north",
    agent: "scout",
    origin: "https://app.example.test",
  };

  it("a key grants its project, agent and origin until it expires", () => {
    let now = 1_000_000;
    const keys = new EmbedKeys(() => now);
    const { key, expiresAt } = keys.mint(grant, 60_000);
    expect(key).toMatch(/^den_ek_[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(now + 60_000);
    expect(keys.check(key)).toEqual({
      ok: true,
      grant: { ...grant, expiresAt },
    });
    now += 60_000;
    expect(keys.check(key)).toEqual({ ok: false, code: "key_expired" });
    expect(keys.check(key)).toEqual({ ok: false, code: "bad_key" });
  });

  it("another key, a near miss, or none grants nothing", () => {
    const keys = new EmbedKeys();
    const { key } = keys.mint(grant, 60_000);
    for (const k of [
      key.slice(0, -1),
      `${key}x`,
      "den_ek_",
      "den_pt_abc",
      "",
      undefined,
      ["x"],
    ])
      expect(keys.check(k).ok).toBe(false);
    const other = keys.mint(grant, 60_000).key;
    expect(other).not.toBe(key);
  });
});
