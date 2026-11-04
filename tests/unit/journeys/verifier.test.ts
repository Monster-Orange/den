/**
 * Unit tests for the journeys deterministic assertion engine + verdict
 * composition (src/pillars/journeys/verify/).
 *
 * Contract under test (plan: jrn-verifier packet, Approach §Assertion
 * contract + §Verdict discipline):
 * - every JourneyAssertion kind of the schema union evaluates against
 *   stubbed HTTP responses — http_status, json_path_exists,
 *   json_path_equals, json_path_contains, array_min_length,
 *   array_contains_match;
 * - probe requests support method + body (POST probes like folders
 *   browse are first-class);
 * - {placeholder} binding from ledger entries regardless of feed source
 *   (http-tool or browser interception); a missing binding is an assertion
 *   FAILURE with a clear message, never a crash;
 * - all-must-pass semantics; failures carry structured
 *   {assertion, expected, actual} diagnostics;
 * - the verifier is plain code — zero LLM involvement;
 * - verdict composition: a RunOutcome with any failure_kind can NEVER
 *   compose to pass; assertions all passing + no failure_kind => passed;
 * - the probe client mirrors the http-tool contract: allowlisted base URLs
 *   only, Authorization injected harness-side, the credential never in
 *   errors or results.
 */

import { describe, expect, it, jest } from "@jest/globals";
import type { JourneyAssertion } from "../../../src/pillars/journeys/spec/schema.js";
import { RunLedger } from "../../../src/pillars/journeys/tools/ledger.js";
import { testLedgerRegistry } from "./fixtures/test-app.js";
import {
  bindPlaceholders,
  buildVerifierProbeClient,
  evaluateJsonPath,
  runAssertions,
  type ProbeResponse,
  type VerifierProbeClient,
} from "../../../src/pillars/journeys/verify/assertions.js";
import {
  composeVerdict,
  verifyJourney,
} from "../../../src/pillars/journeys/verify/verdict.js";
import type { FailureKind } from "../../../src/pillars/journeys/runner.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Ledger seeded with one item (http-tool feed) + one folder (browser). */
function seededLedger(): RunLedger {
  const ledger = new RunLedger(testLedgerRegistry());
  ledger.record(
    {
      method: "POST",
      pathOrUrl: "/api/v1/items",
      status: 201,
      body: { id: "item-42" },
    },
    "http-tool",
  );
  ledger.record(
    {
      method: "POST",
      pathOrUrl: "http://localhost:8000/api/v1/folders",
      status: 200,
      body: { id: "fold-7" },
    },
    "browser",
  );
  return ledger;
}

/** Probe client stub answering from a path-keyed response table. */
function stubClient(
  responses: Record<string, ProbeResponse>,
): VerifierProbeClient & {
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = async (request: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }): Promise<ProbeResponse> => {
    calls.push({
      method: request.method,
      path: request.path,
      body: request.body,
    });
    const response = responses[request.path];
    if (response === undefined) {
      return { status: 404, body: { detail: "not found" } };
    }
    return response;
  };
  return Object.assign(client, { calls });
}

// Realistic pilot shapes (verified against the pilot specs):
// - folders browse response carries the node array under `items`;
// - item messages carry role: "assistant" plus a status lifecycle field.
const BROWSE_RESPONSE: ProbeResponse = {
  status: 200,
  body: {
    items: [
      { name: "ABI-L1b-RadC", node_type: "folder", is_navigable: true },
      { name: "ABI-L1b-RadF", node_type: "folder", is_navigable: true },
    ],
  },
};

const MESSAGES_RESPONSE: ProbeResponse = {
  status: 200,
  body: [
    { role: "user", status: "completed", content: "hi" },
    { role: "assistant", status: "completed", content: "hello!" },
    { role: "user", status: "completed", content: "more?" },
    { role: "assistant", status: "processing", content: "thinking" },
  ],
};

// ── JSONPath evaluator ───────────────────────────────────────────────────────

describe("evaluateJsonPath", () => {
  it("resolves $ to the root value", () => {
    const result = evaluateJsonPath([1, 2], "$");
    expect(result).toEqual({ resolved: true, value: [1, 2] });
  });

  it("resolves dotted property paths like $.items", () => {
    const result = evaluateJsonPath(BROWSE_RESPONSE.body, "$.items");
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(Array.isArray(result.value)).toBe(true);
      expect((result.value as unknown[]).length).toBe(2);
    }
  });

  it("resolves nested properties and numeric indices", () => {
    const result = evaluateJsonPath(BROWSE_RESPONSE.body, "$.items[0].name");
    expect(result).toEqual({ resolved: true, value: "ABI-L1b-RadC" });
  });

  it("resolves filter expressions like $[?(@.role=='assistant')] to the matching array", () => {
    const result = evaluateJsonPath(
      MESSAGES_RESPONSE.body,
      "$[?(@.role=='assistant')]",
    );
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      const items = result.value as Array<{ role: string }>;
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.role === "assistant")).toBe(true);
    }
  });

  it("reports unresolved paths without throwing", () => {
    const result = evaluateJsonPath({ a: 1 }, "$.missing.deeper");
    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.reason).toMatch(/missing/);
    }
  });

  it("rejects malformed path syntax as unresolved, never a crash", () => {
    const result = evaluateJsonPath({ a: 1 }, "$..[[[");
    expect(result.resolved).toBe(false);
  });
});

// ── Placeholder binding ──────────────────────────────────────────────────────

describe("bindPlaceholders", () => {
  it("binds {item_id} from an http-tool-fed ledger entry", () => {
    const bound = bindPlaceholders("/api/v1/items/{item_id}", seededLedger());
    expect(bound).toEqual({ ok: true, path: "/api/v1/items/item-42" });
  });

  it("binds {folder_id} from a browser-interception-fed ledger entry", () => {
    const bound = bindPlaceholders(
      "/api/v1/folders/{folder_id}/browse",
      seededLedger(),
    );
    expect(bound).toEqual({
      ok: true,
      path: "/api/v1/folders/fold-7/browse",
    });
  });

  it("binds the MOST RECENT entry when several resources of one type exist", () => {
    const ledger = seededLedger();
    ledger.record(
      {
        method: "POST",
        pathOrUrl: "/api/v1/items",
        status: 201,
        body: { id: "item-99" },
      },
      "http-tool",
    );
    const bound = bindPlaceholders("/api/v1/items/{item_id}", ledger);
    expect(bound).toEqual({ ok: true, path: "/api/v1/items/item-99" });
  });

  it("reports missing bindings with the placeholder names — no crash", () => {
    const bound = bindPlaceholders(
      "/api/v1/datasets/{dataset_id}",
      seededLedger(),
    );
    expect(bound.ok).toBe(false);
    if (!bound.ok) {
      expect(bound.missing).toEqual(["dataset_id"]);
    }
  });

  it("passes through paths without placeholders untouched", () => {
    const bound = bindPlaceholders("/api/v1/health", seededLedger());
    expect(bound).toEqual({ ok: true, path: "/api/v1/health" });
  });
});

// ── Assertion kinds ──────────────────────────────────────────────────────────

describe("runAssertions — assertion kinds", () => {
  it("http_status passes on an exact status match", async () => {
    const assertion: JourneyAssertion = {
      kind: "http_status",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      equals: 200,
    };
    const client = stubClient({
      "/api/v1/items/item-42": { status: 200, body: { id: "item-42" } },
    });

    const [result] = await runAssertions([assertion], seededLedger(), client);

    expect(result.passed).toBe(true);
    expect(client.calls).toEqual([
      { method: "GET", path: "/api/v1/items/item-42", body: undefined },
    ]);
  });

  it("http_status failure carries structured expected/actual diagnostics", async () => {
    const assertion: JourneyAssertion = {
      kind: "http_status",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      equals: 200,
    };
    const client = stubClient({
      "/api/v1/items/item-42": { status: 404, body: { detail: "gone" } },
    });

    const [result] = await runAssertions([assertion], seededLedger(), client);

    expect(result.passed).toBe(false);
    expect(result.assertion).toBe(assertion);
    expect(result.expected).toBe(200);
    expect(result.actual).toBe(404);
  });

  it("json_path_exists passes when the path resolves and fails with a message when it does not", async () => {
    const exists: JourneyAssertion = {
      kind: "json_path_exists",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      path: "$.id",
    };
    const missing: JourneyAssertion = {
      kind: "json_path_exists",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      path: "$.nope",
    };
    const client = stubClient({
      "/api/v1/items/item-42": { status: 200, body: { id: "item-42" } },
    });

    const results = await runAssertions(
      [exists, missing],
      seededLedger(),
      client,
    );

    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[1].message).toMatch(/\$\.nope/);
  });

  it("json_path_equals compares the resolved value against the literal", async () => {
    const pass: JourneyAssertion = {
      kind: "json_path_equals",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      path: "$.state",
      equals: "active",
    };
    const fail: JourneyAssertion = {
      kind: "json_path_equals",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      path: "$.state",
      equals: "archived",
    };
    const client = stubClient({
      "/api/v1/items/item-42": { status: 200, body: { state: "active" } },
    });

    const results = await runAssertions([pass, fail], seededLedger(), client);

    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[1].expected).toBe("archived");
    expect(results[1].actual).toBe("active");
  });

  it("json_path_contains handles string containment", async () => {
    const assertion: JourneyAssertion = {
      kind: "json_path_contains",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      path: "$.title",
      contains: "first item",
    };
    const client = stubClient({
      "/api/v1/items/item-42": {
        status: 200,
        body: { title: "my very first item" },
      },
    });

    const [result] = await runAssertions([assertion], seededLedger(), client);

    expect(result.passed).toBe(true);
  });

  it("json_path_contains handles array containment and fails with diagnostics", async () => {
    const pass: JourneyAssertion = {
      kind: "json_path_contains",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      path: "$.tags",
      contains: "pilot",
    };
    const fail: JourneyAssertion = {
      kind: "json_path_contains",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      path: "$.tags",
      contains: "absent",
    };
    const client = stubClient({
      "/api/v1/items/item-42": {
        status: 200,
        body: { tags: ["pilot", "journey"] },
      },
    });

    const results = await runAssertions([pass, fail], seededLedger(), client);

    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[1].expected).toBe("absent");
  });

  it("array_min_length counts the array at a plain path — pilot $.items shape", async () => {
    const assertion: JourneyAssertion = {
      kind: "array_min_length",
      request: {
        method: "POST",
        path: "/api/v1/folders/{folder_id}/browse",
        body: { container: "example-bucket" },
      },
      path: "$.items",
      min: 1,
    };
    const client = stubClient({
      "/api/v1/folders/fold-7/browse": BROWSE_RESPONSE,
    });

    const [result] = await runAssertions([assertion], seededLedger(), client);

    expect(result.passed).toBe(true);
    // The POST probe body was forwarded verbatim.
    expect(client.calls[0]).toEqual({
      method: "POST",
      path: "/api/v1/folders/fold-7/browse",
      body: { container: "example-bucket" },
    });
  });

  it("array_min_length counts filter-expression matches — pilot assistant-role shape", async () => {
    const assertion: JourneyAssertion = {
      kind: "array_min_length",
      request: { method: "GET", path: "/api/v1/items/{item_id}/messages" },
      path: "$[?(@.role=='assistant')]",
      min: 2,
    };
    const client = stubClient({
      "/api/v1/items/item-42/messages": MESSAGES_RESPONSE,
    });

    const [result] = await runAssertions([assertion], seededLedger(), client);

    expect(result.passed).toBe(true);
    expect(result.actual).toBe(2);
  });

  it("array_min_length fails when the value at the path is not an array", async () => {
    const assertion: JourneyAssertion = {
      kind: "array_min_length",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      path: "$.id",
      min: 1,
    };
    const client = stubClient({
      "/api/v1/items/item-42": { status: 200, body: { id: "item-42" } },
    });

    const [result] = await runAssertions([assertion], seededLedger(), client);

    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/not an array/i);
  });

  it("array_min_length fails below the minimum with expected/actual counts", async () => {
    const assertion: JourneyAssertion = {
      kind: "array_min_length",
      request: { method: "GET", path: "/api/v1/items/{item_id}/messages" },
      path: "$[?(@.role=='assistant')]",
      min: 5,
    };
    const client = stubClient({
      "/api/v1/items/item-42/messages": MESSAGES_RESPONSE,
    });

    const [result] = await runAssertions([assertion], seededLedger(), client);

    expect(result.passed).toBe(false);
    expect(result.expected).toBe(5);
    expect(result.actual).toBe(2);
  });

  it("array_contains_match passes when one item satisfies every field predicate — pilot role+status shape", async () => {
    const assertion: JourneyAssertion = {
      kind: "array_contains_match",
      request: { method: "GET", path: "/api/v1/items/{item_id}/messages" },
      path: "$",
      match: { role: "assistant", status: "completed" },
    };
    const client = stubClient({
      "/api/v1/items/item-42/messages": MESSAGES_RESPONSE,
    });

    const [result] = await runAssertions([assertion], seededLedger(), client);

    expect(result.passed).toBe(true);
  });

  it("array_contains_match requires ALL predicates on a single item", async () => {
    const assertion: JourneyAssertion = {
      kind: "array_contains_match",
      request: { method: "GET", path: "/api/v1/items/{item_id}/messages" },
      path: "$",
      match: { role: "assistant", status: "failed" },
    };
    const client = stubClient({
      "/api/v1/items/item-42/messages": MESSAGES_RESPONSE,
    });

    const [result] = await runAssertions([assertion], seededLedger(), client);

    expect(result.passed).toBe(false);
    expect(result.expected).toEqual({ role: "assistant", status: "failed" });
  });
});

// ── Engine-level semantics ───────────────────────────────────────────────────

describe("runAssertions — engine semantics", () => {
  it("a missing placeholder binding fails THAT assertion with a clear message and no probe call", async () => {
    const assertion: JourneyAssertion = {
      kind: "http_status",
      request: { method: "GET", path: "/api/v1/datasets/{dataset_id}" },
      equals: 200,
    };
    const client = stubClient({});

    const [result] = await runAssertions([assertion], seededLedger(), client);

    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/dataset_id/);
    expect(result.message).toMatch(/ledger/i);
    expect(client.calls).toEqual([]);
  });

  it("a thrown probe-client error becomes a structured failure, never a crash", async () => {
    const assertion: JourneyAssertion = {
      kind: "http_status",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      equals: 200,
    };
    const client: VerifierProbeClient = async () => {
      throw new Error("connection refused");
    };

    const [result] = await runAssertions([assertion], seededLedger(), client);

    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/connection refused/);
  });

  it("evaluates every assertion (all-must-pass input for the verdict) — later assertions still run after a failure", async () => {
    const failing: JourneyAssertion = {
      kind: "http_status",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      equals: 204,
    };
    const passing: JourneyAssertion = {
      kind: "json_path_exists",
      request: { method: "GET", path: "/api/v1/items/{item_id}" },
      path: "$.id",
    };
    const client = stubClient({
      "/api/v1/items/item-42": { status: 200, body: { id: "item-42" } },
    });

    const results = await runAssertions(
      [failing, passing],
      seededLedger(),
      client,
    );

    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(false);
    expect(results[1].passed).toBe(true);
  });
});

// ── Verdict composition ──────────────────────────────────────────────────────

describe("composeVerdict", () => {
  const passResult = {
    assertion: {
      kind: "http_status",
      request: { method: "GET", path: "/x" },
      equals: 200,
    } as JourneyAssertion,
    passed: true,
  };
  const failResult = { ...passResult, passed: false };

  it("passes only when ALL assertions pass and failure_kind is absent", () => {
    const verdict = composeVerdict({}, [passResult, passResult]);
    expect(verdict.passed).toBe(true);
    expect(verdict.failure_kind).toBeUndefined();
  });

  it("any failing assertion fails the verdict", () => {
    const verdict = composeVerdict({}, [passResult, failResult]);
    expect(verdict.passed).toBe(false);
  });

  it.each([
    "budget_exceeded",
    "budget_unverifiable",
    "infra_error",
    "agent_error",
  ] as FailureKind[])(
    "failure_kind=%s can NEVER compose to pass, even with all assertions green",
    (failureKind) => {
      const verdict = composeVerdict({ failure_kind: failureKind }, [
        passResult,
      ]);
      expect(verdict.passed).toBe(false);
      expect(verdict.failure_kind).toBe(failureKind);
    },
  );

  it("carries the assertion results for reporting", () => {
    const verdict = composeVerdict({}, [passResult, failResult]);
    expect(verdict.results).toEqual([passResult, failResult]);
  });
});

describe("verifyJourney", () => {
  it("runs the spec's assertions against the outcome's ledger and composes the verdict", async () => {
    const assertions: JourneyAssertion[] = [
      {
        kind: "http_status",
        request: { method: "GET", path: "/api/v1/items/{item_id}" },
        equals: 200,
      },
      {
        kind: "array_min_length",
        request: { method: "GET", path: "/api/v1/items/{item_id}/messages" },
        path: "$[?(@.role=='assistant')]",
        min: 2,
      },
    ];
    const client = stubClient({
      "/api/v1/items/item-42": { status: 200, body: { id: "item-42" } },
      "/api/v1/items/item-42/messages": MESSAGES_RESPONSE,
    });

    const verdict = await verifyJourney(
      assertions,
      { ledger: seededLedger() },
      client,
    );

    expect(verdict.passed).toBe(true);
    expect(verdict.results).toHaveLength(2);
  });

  it("still runs the probes for diagnostics but fails when the run carried a failure_kind", async () => {
    const assertions: JourneyAssertion[] = [
      {
        kind: "http_status",
        request: { method: "GET", path: "/api/v1/items/{item_id}" },
        equals: 200,
      },
    ];
    const client = stubClient({
      "/api/v1/items/item-42": { status: 200, body: { id: "item-42" } },
    });

    const verdict = await verifyJourney(
      assertions,
      { ledger: seededLedger(), failure_kind: "budget_exceeded" },
      client,
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.failure_kind).toBe("budget_exceeded");
    expect(verdict.results[0].passed).toBe(true);
    expect(client.calls).toHaveLength(1);
  });
});

// ── Probe client (http-tool contract mirror) ─────────────────────────────────

describe("buildVerifierProbeClient", () => {
  const TOKEN = "verifier-secret-jwt";

  function fetchStub(
    status = 200,
    body: unknown = { ok: true },
  ): jest.Mock<typeof fetch> {
    return jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("resolves relative probe paths against the primary base URL and injects the Bearer token harness-side", async () => {
    const fetchImpl = fetchStub();
    const client = buildVerifierProbeClient({
      allowedBaseUrls: ["http://localhost:8000"],
      tokenProvider: async () => TOKEN,
      fetchImpl,
    });

    const response = await client({ method: "GET", path: "/api/v1/health" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8000/api/v1/health");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("sends JSON bodies on POST probes", async () => {
    const fetchImpl = fetchStub();
    const client = buildVerifierProbeClient({
      allowedBaseUrls: ["http://localhost:8000"],
      tokenProvider: async () => TOKEN,
      fetchImpl,
    });

    await client({
      method: "POST",
      path: "/api/v1/folders/fold-7/browse",
      body: { container: "example-bucket" },
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ container: "example-bucket" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("bounds every probe fetch with an abort signal — per-request timeout even absent a deadline (review finding 6)", async () => {
    const fetchImpl = fetchStub();
    const client = buildVerifierProbeClient({
      allowedBaseUrls: ["http://localhost:8000"],
      tokenProvider: async () => TOKEN,
      fetchImpl,
    });

    await client({ method: "GET", path: "/api/v1/health" });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("combines a caller-provided deadline signal into the probe fetch", async () => {
    const fetchImpl = fetchStub();
    const controller = new AbortController();
    const client = buildVerifierProbeClient({
      allowedBaseUrls: ["http://localhost:8000"],
      tokenProvider: async () => TOKEN,
      fetchImpl,
      signal: controller.signal,
    });
    controller.abort();

    await client({ method: "GET", path: "/api/v1/health" });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });

  it("rejects non-allowlisted absolute URLs without making a request", async () => {
    const fetchImpl = fetchStub();
    const client = buildVerifierProbeClient({
      allowedBaseUrls: ["http://localhost:8000"],
      tokenProvider: async () => TOKEN,
      fetchImpl,
    });

    await expect(
      client({ method: "GET", path: "http://evil.example.com/api/v1/x" }),
    ).rejects.toThrow(/allowlist/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never leaks the credential in transport-error messages", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`socket hang up for Bearer ${TOKEN}`));
    const client = buildVerifierProbeClient({
      allowedBaseUrls: ["http://localhost:8000"],
      tokenProvider: async () => TOKEN,
      fetchImpl,
    });

    let thrown: Error | undefined;
    try {
      await client({ method: "GET", path: "/api/v1/health" });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain(TOKEN);
    expect(thrown?.message).toContain("[REDACTED]");
  });

  it("returns non-JSON bodies as raw text", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      new Response("plain text", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );
    const client = buildVerifierProbeClient({
      allowedBaseUrls: ["http://localhost:8000"],
      tokenProvider: async () => TOKEN,
      fetchImpl,
    });

    const response = await client({ method: "GET", path: "/api/v1/health" });

    expect(response.status).toBe(500);
    expect(response.body).toBe("plain text");
  });

  it("requires at least one allowlisted base URL", () => {
    expect(() =>
      buildVerifierProbeClient({
        allowedBaseUrls: [],
        tokenProvider: async () => TOKEN,
      }),
    ).toThrow(/base URL/);
  });
});
