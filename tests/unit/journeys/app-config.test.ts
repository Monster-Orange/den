/**
 * Unit tests for the app-under-test config (src/pillars/journeys/app-config.ts):
 * the `journeys.app` manifest block that replaces any built-in knowledge of
 * one product's API.
 */

import {
  JourneysAppConfigError,
  ledgerRegistryFromApp,
  parseJourneysAppConfig,
  rewriteWebApiPath,
  rewriteWebApiUrl,
  segmentPatternToRegExp,
} from "../../../src/pillars/journeys/app-config.js";
import {
  emptyLedgerRegistry,
  matchResourceCreation,
} from "../../../src/pillars/journeys/tools/ledger.js";
import { TEST_APP } from "./fixtures/test-app.js";

describe("parseJourneysAppConfig", () => {
  it("treats an absent block as an empty app", () => {
    expect(parseJourneysAppConfig(undefined, "repo")).toEqual({});
    expect(parseJourneysAppConfig(null, "repo")).toEqual({});
  });

  it("accepts a full block", () => {
    expect(parseJourneysAppConfig(TEST_APP, "repo")).toEqual(TEST_APP);
  });

  it.each([
    ["an unknown key", { resource: [] }],
    ["a relative session_token path", { session_token: { path: "token" } }],
    [
      "a delete route without {id}",
      { resources: [{ type: "item", create: "/a", delete: "DELETE /a" }] },
    ],
    [
      "an upper-case resource type",
      { resources: [{ type: "Item", create: "/a", delete: "/a/{id}" }] },
    ],
    ["a malformed route", { actions: ["POST no-slash"] }],
  ])("rejects %s, naming the source", (_label, raw) => {
    expect(() => parseJourneysAppConfig(raw, "web-app's manifest")).toThrow(
      JourneysAppConfigError,
    );
    expect(() => parseJourneysAppConfig(raw, "web-app's manifest")).toThrow(
      /web-app's manifest/,
    );
  });
});

describe("segmentPatternToRegExp", () => {
  it("matches exactly one segment per *", () => {
    const re = segmentPatternToRegExp("/api/v1/items/*/archive");
    expect(re.test("/api/v1/items/i-1/archive")).toBe(true);
    expect(re.test("/api/v1/items/a/b/archive")).toBe(false);
    expect(re.test("/api/v1/items//archive")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    const re = segmentPatternToRegExp("/api/v1.0/items");
    expect(re.test("/api/v1.0/items")).toBe(true);
    expect(re.test("/api/v1x0/items")).toBe(false);
  });
});

describe("ledgerRegistryFromApp", () => {
  it("builds descriptors that bind ids and exact cleanup requests", () => {
    const registry = ledgerRegistryFromApp(TEST_APP);
    expect(
      matchResourceCreation(registry, {
        method: "POST",
        pathOrUrl: "http://api.example.com/api/v1/items?x=1",
        status: 201,
        body: { id: "item-1" },
      }),
    ).toEqual({
      kind: "resource",
      resourceType: "item",
      id: "item-1",
      cleanup: { method: "DELETE", path: "/api/v1/items/item-1" },
    });
  });

  it("defaults create to POST and delete to DELETE, and honours id_field", () => {
    const registry = ledgerRegistryFromApp({
      resources: [
        {
          type: "note",
          create: "/api/notes",
          delete: "/api/notes/{id}",
          id_field: "note_id",
        },
      ],
    });
    expect(
      matchResourceCreation(registry, {
        method: "POST",
        pathOrUrl: "/api/notes",
        status: 200,
        body: { note_id: "n/1" },
      }),
    ).toEqual({
      kind: "resource",
      resourceType: "note",
      id: "n/1",
      // The id is path-encoded so it can never add segments to the cleanup.
      cleanup: { method: "DELETE", path: "/api/notes/n%2F1" },
    });
  });

  it("honours an explicit create method", () => {
    const registry = ledgerRegistryFromApp({
      resources: [
        { type: "doc", create: "PUT /api/docs/*", delete: "/api/docs/{id}" },
      ],
    });
    const call = {
      pathOrUrl: "/api/docs/d-1",
      status: 200,
      body: { id: "d-1" },
    };
    expect(
      matchResourceCreation(registry, { ...call, method: "PUT" }).kind,
    ).toBe("resource");
    expect(
      matchResourceCreation(registry, { ...call, method: "POST" }).kind,
    ).toBe("unmanaged-mutation");
  });

  it("never records declared actions", () => {
    const registry = ledgerRegistryFromApp(TEST_APP);
    expect(
      matchResourceCreation(registry, {
        method: "POST",
        pathOrUrl: "/api/v1/folders/f-1/test",
        status: 200,
        body: { id: "x" },
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("an app with no resources reports every mutation as unmanaged", () => {
    for (const registry of [ledgerRegistryFromApp({}), emptyLedgerRegistry()]) {
      expect(
        matchResourceCreation(registry, {
          method: "POST",
          pathOrUrl: "/api/v1/items",
          status: 201,
          body: { id: "i-1" },
        }),
      ).toEqual({ kind: "unmanaged-mutation" });
    }
  });
});

describe("rewriteWebApiPath", () => {
  const webApi = TEST_APP.web_api;

  it("rewrites a declared prefix and keeps the rest of the path", () => {
    expect(rewriteWebApiPath("/api/folders", webApi)).toBe("/api/v1/folders");
    expect(rewriteWebApiPath("/api/folders/f-1/test", webApi)).toBe(
      "/api/v1/folders/f-1/test",
    );
  });

  it("is segment-aware", () => {
    expect(rewriteWebApiPath("/api/folders-old", webApi)).toBe(
      "/api/folders-old",
    );
  });

  it("prefers the longest matching rule", () => {
    expect(
      rewriteWebApiPath("/api/a/b/c", {
        prefix: "/api/",
        rewrites: [
          { from: "/api/a", to: "/x" },
          { from: "/api/a/b", to: "/y" },
        ],
      }),
    ).toBe("/y/c");
  });

  it("leaves unknown paths and absent config alone", () => {
    expect(rewriteWebApiPath("/api/auth/callback", webApi)).toBe(
      "/api/auth/callback",
    );
    expect(rewriteWebApiPath("/api/items", undefined)).toBe("/api/items");
  });

  it("rewrites URLs, keeping origin and query", () => {
    expect(rewriteWebApiUrl("http://web.test/api/items?q=1", webApi)).toBe(
      "http://web.test/api/v1/items?q=1",
    );
  });
});
