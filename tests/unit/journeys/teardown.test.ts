/**
 * Unit tests for the journeys teardown executor
 * (src/pillars/journeys/teardown.ts).
 *
 * Contract under test (plan: jrn-runner packet, Approach §Isolation and
 * teardown for Phase-1 pilots):
 * - pure executor over the ledger — deletes recognized resources from BOTH
 *   feeds (http-tool and browser) in REVERSE creation order using each
 *   entry's explicit cleanup descriptor;
 * - deletion failures surface in the TeardownReport, never swallowed;
 * - unmanaged-mutation warnings pass through into the report (reported,
 *   never guessed-deleted — no HTTP call is made for them);
 * - caller-invoked only: the executor takes the ledger and a client — it
 *   never reaches into runJourney.
 */

import { describe, expect, it, jest } from "@jest/globals";
import { teardownLedger } from "../../../src/pillars/journeys/teardown.js";
import type { TeardownHttpClient } from "../../../src/pillars/journeys/teardown.js";
import { RunLedger } from "../../../src/pillars/journeys/tools/ledger.js";
import { testLedgerRegistry } from "./fixtures/test-app.js";

function seededLedger(): RunLedger {
  const ledger = new RunLedger(testLedgerRegistry());
  // Recognized creation via the HTTP tool feed.
  ledger.record(
    {
      method: "POST",
      pathOrUrl: "/api/v1/items",
      status: 201,
      body: { id: "item-1" },
    },
    "http-tool",
  );
  // Recognized creation via the browser interception feed.
  ledger.record(
    {
      method: "POST",
      pathOrUrl: "http://localhost:8000/api/v1/folders",
      status: 200,
      body: { id: "fold-1" },
    },
    "browser",
  );
  // Unmanaged mutation — must surface as a warning, never be deleted.
  ledger.record(
    {
      method: "POST",
      pathOrUrl: "/api/v1/widgets",
      status: 201,
      body: { id: "widget-1" },
    },
    "browser",
  );
  return ledger;
}

describe("teardownLedger", () => {
  it("deletes recognized resources from BOTH feeds in reverse creation order", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client: TeardownHttpClient = async (request) => {
      calls.push(request);
      return { status: 204 };
    };

    const report = await teardownLedger(seededLedger(), client);

    expect(calls).toEqual([
      { method: "DELETE", path: "/api/v1/folders/fold-1" },
      { method: "DELETE", path: "/api/v1/items/item-1" },
    ]);
    expect(report.results).toHaveLength(2);
    expect(report.results.every((result) => result.ok)).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("uses each entry's explicit cleanup descriptor — no guessed paths", async () => {
    const client = jest.fn(async () => ({ status: 200 }));

    await teardownLedger(seededLedger(), client as TeardownHttpClient);

    // Only the two registered cleanups; the unmanaged widget POST never
    // triggers a delete.
    expect(client).toHaveBeenCalledTimes(2);
    const paths = (client.mock.calls as Array<[{ path: string }]>).map(
      ([request]) => request.path,
    );
    expect(paths).not.toContainEqual(expect.stringContaining("widget"));
  });

  it("surfaces non-2xx deletions as failures — never swallowed", async () => {
    const client: TeardownHttpClient = async (request) =>
      request.path.includes("fold-1") ? { status: 500 } : { status: 204 };

    const report = await teardownLedger(seededLedger(), client);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].entry.id).toBe("fold-1");
    expect(report.failures[0].status).toBe(500);
    expect(report.failures[0].ok).toBe(false);
  });

  it("surfaces thrown client errors as failures and continues with remaining entries", async () => {
    const calls: string[] = [];
    const client: TeardownHttpClient = async (request) => {
      calls.push(request.path);
      if (request.path.includes("fold-1")) {
        throw new Error("network down");
      }
      return { status: 204 };
    };

    const report = await teardownLedger(seededLedger(), client);

    // The item delete still ran after the folder delete threw.
    expect(calls).toEqual(["/api/v1/folders/fold-1", "/api/v1/items/item-1"]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].error).toMatch(/network down/);
  });

  it("passes unmanaged-mutation warnings through into the report", async () => {
    const client: TeardownHttpClient = async () => ({ status: 204 });

    const report = await teardownLedger(seededLedger(), client);

    expect(report.unmanagedWarnings).toHaveLength(1);
    expect(report.unmanagedWarnings[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/widgets",
      source: "browser",
    });
  });

  it("passes ledger interception errors through into the report (review finding 7)", async () => {
    const client: TeardownHttpClient = async () => ({ status: 204 });
    const ledger = seededLedger();
    ledger.recordInterceptionError("response handler exploded");

    const report = await teardownLedger(ledger, client);

    expect(report.interceptionErrors).toEqual(["response handler exploded"]);
  });

  it("handles an empty ledger without any client calls", async () => {
    const client = jest.fn(async () => ({ status: 204 }));

    const report = await teardownLedger(
      new RunLedger(testLedgerRegistry()),
      client as TeardownHttpClient,
    );

    expect(client).not.toHaveBeenCalled();
    expect(report.results).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.unmanagedWarnings).toEqual([]);
  });
});
