/**
 * Unit tests for the journeys resource ledger
 * (src/pillars/journeys/tools/ledger.ts).
 *
 * Contract under test (plan: jrn-http-tool packet):
 * - Only calls matching a registered ResourceDescriptor are recorded as
 *   resources, with the extracted id and the descriptor's exact cleanup
 *   {method, path} bound to the entry.
 * - Action POSTs (/test, /browse, /messages/stream) are NEVER recorded —
 *   neither as resources nor as warnings.
 * - Successful mutations on endpoints with no registered descriptor become
 *   unmanaged-mutation warnings (reported, never guessed-deleted).
 * - The matcher is a pure exported function (browser interception reuses it).
 * - Multi-feed: records carry a source tag (http-tool | browser).
 * - Data minimization: entries/warnings retain only method + sanitized path
 *   (query stripped) + status + extracted id + source — never bodies,
 *   headers, or credential material.
 */

import {
  RunLedger,
  matchResourceCreation,
  sanitizePath,
  type LedgerRegistry,
  type ObservedCall,
} from "../../../src/pillars/journeys/tools/ledger.js";
import { testLedgerRegistry } from "./fixtures/test-app.js";

const ITEM_ID = "11111111-2222-3333-4444-555555555555";
const FOLDER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function itemCreation(overrides: Partial<ObservedCall> = {}): ObservedCall {
  return {
    method: "POST",
    pathOrUrl: "/api/v1/items",
    status: 201,
    body: { id: ITEM_ID, title: "hello" },
    ...overrides,
  };
}

function folderCreation(overrides: Partial<ObservedCall> = {}): ObservedCall {
  return {
    method: "POST",
    pathOrUrl: "/api/v1/folders",
    status: 201,
    body: { id: FOLDER_ID, name: "docs" },
    ...overrides,
  };
}

describe("sanitizePath", () => {
  it("strips the origin from absolute URLs", () => {
    expect(sanitizePath("http://localhost:8000/api/v1/items")).toBe(
      "/api/v1/items",
    );
  });

  it("strips query strings and fragments", () => {
    expect(sanitizePath("/api/v1/items?token=secret-qs#frag")).toBe(
      "/api/v1/items",
    );
    expect(
      sanitizePath("https://api.example.com/api/v1/folders?force=true"),
    ).toBe("/api/v1/folders");
  });
});

describe("matchResourceCreation (pure matcher)", () => {
  const registry = testLedgerRegistry();

  it("matches an item creation and binds the items DELETE cleanup", () => {
    const match = matchResourceCreation(registry, itemCreation());
    expect(match).toEqual({
      kind: "resource",
      resourceType: "item",
      id: ITEM_ID,
      cleanup: { method: "DELETE", path: `/api/v1/items/${ITEM_ID}` },
    });
  });

  it("matches a folder creation and binds the folders DELETE cleanup", () => {
    const match = matchResourceCreation(registry, folderCreation());
    expect(match).toEqual({
      kind: "resource",
      resourceType: "folder",
      id: FOLDER_ID,
      cleanup: {
        method: "DELETE",
        path: `/api/v1/folders/${FOLDER_ID}`,
      },
    });
  });

  it.each([
    ["folder test", `/api/v1/folders/${FOLDER_ID}/test`],
    ["folder browse", `/api/v1/folders/${FOLDER_ID}/browse`],
    ["item message stream", `/api/v1/items/${ITEM_ID}/messages/stream`],
  ])("ignores the %s action POST", (_label, path) => {
    const match = matchResourceCreation(registry, {
      method: "POST",
      pathOrUrl: path,
      status: 200,
      body: { id: "should-not-be-extracted" },
    });
    expect(match).toEqual({ kind: "ignored" });
  });

  it("ignores non-mutating methods entirely", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"] as const) {
      const match = matchResourceCreation(registry, {
        method,
        pathOrUrl: "/api/v1/items",
        status: 200,
        body: { id: ITEM_ID },
      });
      expect(match).toEqual({ kind: "ignored" });
    }
  });

  it("ignores failed (non-2xx) creation calls", () => {
    const match = matchResourceCreation(
      registry,
      itemCreation({ status: 422 }),
    );
    expect(match).toEqual({ kind: "ignored" });
  });

  it("flags an unrecognized successful mutation as unmanaged", () => {
    const match = matchResourceCreation(registry, {
      method: "POST",
      pathOrUrl: "/api/v1/datasets",
      status: 201,
      body: { id: "ds-1" },
    });
    expect(match).toEqual({ kind: "unmanaged-mutation" });
  });

  it("flags a recognized creation whose id cannot be extracted as unmanaged", () => {
    const match = matchResourceCreation(
      registry,
      itemCreation({ body: { title: "no id field" } }),
    );
    expect(match).toEqual({ kind: "unmanaged-mutation" });
  });

  it("does not match a creation pattern against subpaths", () => {
    const match = matchResourceCreation(registry, {
      method: "POST",
      pathOrUrl: `/api/v1/items/${ITEM_ID}/messages`,
      status: 201,
      body: { id: "msg-1" },
    });
    expect(match).toEqual({ kind: "unmanaged-mutation" });
  });
});

describe("RunLedger", () => {
  it("records recognized creations with id, cleanup, and source tag", () => {
    const ledger = new RunLedger(testLedgerRegistry());
    ledger.record(itemCreation(), "http-tool");
    ledger.record(folderCreation(), "browser");

    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries[0]).toEqual({
      resourceType: "item",
      id: ITEM_ID,
      method: "POST",
      path: "/api/v1/items",
      status: 201,
      source: "http-tool",
      cleanup: { method: "DELETE", path: `/api/v1/items/${ITEM_ID}` },
    });
    expect(ledger.entries[1]).toEqual({
      resourceType: "folder",
      id: FOLDER_ID,
      method: "POST",
      path: "/api/v1/folders",
      status: 201,
      source: "browser",
      cleanup: {
        method: "DELETE",
        path: `/api/v1/folders/${FOLDER_ID}`,
      },
    });
    expect(ledger.warnings).toHaveLength(0);
  });

  it("never records action POSTs — no entries, no warnings", () => {
    const ledger = new RunLedger(testLedgerRegistry());
    ledger.record(
      {
        method: "POST",
        pathOrUrl: `/api/v1/folders/${FOLDER_ID}/test`,
        status: 200,
        body: { status: "ok" },
      },
      "http-tool",
    );
    ledger.record(
      {
        method: "POST",
        pathOrUrl: `/api/v1/folders/${FOLDER_ID}/browse`,
        status: 200,
        body: { nodes: [{ id: "n1" }] },
      },
      "http-tool",
    );
    ledger.record(
      {
        method: "POST",
        pathOrUrl: `/api/v1/items/${ITEM_ID}/messages/stream`,
        status: 200,
        body: { id: "stream-chunk" },
      },
      "browser",
    );

    expect(ledger.entries).toHaveLength(0);
    expect(ledger.warnings).toHaveLength(0);
  });

  it("records unrecognized successful mutations as unmanaged warnings", () => {
    const ledger = new RunLedger(testLedgerRegistry());
    ledger.record(
      {
        method: "POST",
        pathOrUrl: "/api/v1/datasets",
        status: 201,
        body: { id: "ds-1" },
      },
      "browser",
    );

    expect(ledger.entries).toHaveLength(0);
    expect(ledger.warnings).toEqual([
      {
        method: "POST",
        path: "/api/v1/datasets",
        status: 201,
        source: "browser",
      },
    ]);
  });

  it("minimizes data: query stripped, bodies and secrets never retained", () => {
    const ledger = new RunLedger(testLedgerRegistry());
    const sentinelSecret = "sentinel-super-secret-jwt-value";
    ledger.record(
      itemCreation({
        pathOrUrl: `http://localhost:8000/api/v1/items?access_token=${sentinelSecret}`,
        body: {
          id: ITEM_ID,
          password: sentinelSecret,
          authorization: `Bearer ${sentinelSecret}`,
        },
      }),
      "http-tool",
    );
    ledger.record(
      {
        method: "PUT",
        pathOrUrl: `/api/v1/unknown?apikey=${sentinelSecret}`,
        status: 200,
        body: { secret: sentinelSecret },
      },
      "browser",
    );

    expect(ledger.entries[0].path).toBe("/api/v1/items");
    expect(ledger.warnings[0].path).toBe("/api/v1/unknown");

    const serialized = JSON.stringify({
      entries: ledger.entries,
      warnings: ledger.warnings,
    });
    expect(serialized).not.toContain(sentinelSecret);
    expect(serialized).not.toContain("body");
  });

  it("supports custom registries via the same pure matcher", () => {
    const registry: LedgerRegistry = {
      descriptors: [
        {
          resourceType: "widget",
          creation: { method: "POST", pathPattern: /^\/api\/v1\/widgets$/ },
          extractId: (call) => {
            const body = call.body as { widget_id?: string } | undefined;
            return body?.widget_id;
          },
          cleanup: (id) => ({
            method: "DELETE",
            path: `/api/v1/widgets/${id}`,
          }),
        },
      ],
      actionPatterns: [],
    };
    const ledger = new RunLedger(registry);
    ledger.record(
      {
        method: "POST",
        pathOrUrl: "/api/v1/widgets",
        status: 200,
        body: { widget_id: "w-42" },
      },
      "http-tool",
    );

    expect(ledger.entries).toEqual([
      {
        resourceType: "widget",
        id: "w-42",
        method: "POST",
        path: "/api/v1/widgets",
        status: 200,
        source: "http-tool",
        cleanup: { method: "DELETE", path: "/api/v1/widgets/w-42" },
      },
    ]);
  });
});
