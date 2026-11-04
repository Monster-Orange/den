/**
 * Unit tests for the scoped HTTP custom tool
 * (src/pillars/journeys/tools/http-tool.ts).
 *
 * Contract under test (plan: jrn-http-tool packet):
 * - Only allowlisted base URLs (env baseUrls.api + baseUrls.services values)
 *   are reachable; other hosts are rejected with a typed error result.
 * - Authorization: Bearer <jwt> is injected harness-side from the
 *   tokenProvider — the credential never appears in tool args, results, or
 *   error surfaces.
 * - Responses are truncated at a byte cap.
 * - 4xx/5xx are surfaced as structured results, never thrown.
 * - Successful mutating calls feed the RunLedger with source "http-tool".
 */

import {
  buildScopedHttpTool,
  allowedBaseUrlsFromEnv,
  allowedMethodsForSurface,
  HTTP_TOOL_NAME,
  type HttpCapabilityGrant,
  type HttpToolResult,
  type HttpToolPayload,
} from "../../../src/pillars/journeys/tools/http-tool.js";
import { RunLedger } from "../../../src/pillars/journeys/tools/ledger.js";
import { testLedgerRegistry } from "./fixtures/test-app.js";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";

const TOKEN = "sentinel-jwt-abc123-never-leaks";
const API_BASE = "http://localhost:8000";
const SERVICE_BASE = "http://localhost:8084";

/**
 * Grants used by the shared fixture tool: exactly the resource families
 * the existing tests mutate. Everything else must be denied pre-fetch
 * (review finding R2-1).
 */
const FIXTURE_CAPABILITIES: HttpCapabilityGrant[] = [
  { methods: ["POST"], pathPattern: "/api/v1/items" },
  { methods: ["POST"], pathPattern: "/api/v1/datasets" },
];

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function parsePayload(result: HttpToolResult): HttpToolPayload {
  const first = result.content[0];
  if (first.type !== "text") {
    throw new Error("expected text content");
  }
  return JSON.parse(first.text) as HttpToolPayload;
}

describe("buildScopedHttpTool", () => {
  let fetchMock: jest.Mock;
  let ledger: RunLedger;
  let tool: SDKCustomTool;

  const execute = (args: Record<string, SDKJsonValue>) =>
    tool.execute(args, {}) as Promise<HttpToolResult>;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    ledger = new RunLedger(testLedgerRegistry());
    tool = buildScopedHttpTool({
      allowedBaseUrls: [API_BASE, SERVICE_BASE],
      tokenProvider: async () => TOKEN,
      ledger,
      capabilities: FIXTURE_CAPABILITIES,
    });
  });

  it("exposes an SDK custom-tool surface (description + input schema + execute)", () => {
    expect(HTTP_TOOL_NAME).toBe("http_request");
    expect(typeof tool.description).toBe("string");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      required: ["method", "path_or_url"],
    });
    expect(typeof tool.execute).toBe("function");
  });

  describe("allowlist enforcement", () => {
    it("resolves relative paths against the primary (API) base URL", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
      const payload = parsePayload(
        await execute({ method: "GET", path_or_url: "/api/v1/items" }),
      );

      expect(payload.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/v1/items`);
    });

    it("accepts absolute URLs under any allowlisted base", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
      await execute({
        method: "GET",
        path_or_url: `${SERVICE_BASE}/api/v1/folders`,
      });
      expect(fetchMock.mock.calls[0][0]).toBe(`${SERVICE_BASE}/api/v1/folders`);
    });

    it("rejects non-allowlisted hosts with a typed error and no network call", async () => {
      const result = await execute({
        method: "GET",
        path_or_url: "https://evil.example.com/api/v1/items",
      });

      expect(result.isError).toBe(true);
      expect(parsePayload(result)).toEqual({
        error: {
          code: "HOST_NOT_ALLOWLISTED",
          message: expect.stringContaining("evil.example.com"),
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects allowlisted-host lookalikes (prefix tricks)", async () => {
      const result = await execute({
        method: "GET",
        path_or_url: "http://localhost:8000.evil.example.com/x",
      });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects invalid methods with a typed error", async () => {
      const result = await execute({
        method: "TRACE",
        path_or_url: "/api/v1/items",
      });
      expect(result.isError).toBe(true);
      expect(parsePayload(result)).toEqual({
        error: { code: "INVALID_ARGS", message: expect.any(String) },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("method capabilities (review finding 4)", () => {
    it("refuses DELETE outright — cleanup is harness-only via teardown", async () => {
      const result = await execute({
        method: "DELETE",
        path_or_url: "/api/v1/items/c-1",
      });

      expect(result.isError).toBe(true);
      const payload = parsePayload(result);
      expect(payload.error?.code).toBe("METHOD_NOT_ALLOWED");
      expect(payload.error?.message).toMatch(/teardown|harness/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("throws at build time when a caller tries to allow DELETE", () => {
      expect(() =>
        buildScopedHttpTool({
          allowedBaseUrls: [API_BASE],
          tokenProvider: async () => TOKEN,
          ledger,
          allowedMethods: ["GET", "DELETE"] as never,
        }),
      ).toThrow(/DELETE/);
    });

    it("refuses mutating methods on a read-only (browser-surface) toolset", async () => {
      tool = buildScopedHttpTool({
        allowedBaseUrls: [API_BASE],
        tokenProvider: async () => TOKEN,
        ledger,
        allowedMethods: allowedMethodsForSurface("browser"),
      });

      const post = await execute({
        method: "POST",
        path_or_url: "/api/v1/items",
        body: {},
      });
      expect(post.isError).toBe(true);
      expect(parsePayload(post).error?.code).toBe("METHOD_NOT_ALLOWED");
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
      const get = await execute({
        method: "GET",
        path_or_url: "/api/v1/items",
      });
      expect(get.isError).toBeUndefined();
    });

    it("advertises only the allowed methods in the input schema enum", () => {
      tool = buildScopedHttpTool({
        allowedBaseUrls: [API_BASE],
        tokenProvider: async () => TOKEN,
        ledger,
        allowedMethods: allowedMethodsForSurface("browser"),
      });
      const schema = tool.inputSchema as {
        properties: { method: { enum: string[] } };
      };
      expect(schema.properties.method.enum).toEqual(["GET"]);
    });

    it("derives per-surface method sets: browser read-only, api/mixed mutating without DELETE", () => {
      expect(allowedMethodsForSurface("browser")).toEqual(["GET"]);
      expect(allowedMethodsForSurface("api")).toEqual([
        "GET",
        "POST",
        "PUT",
        "PATCH",
      ]);
      expect(allowedMethodsForSurface("mixed")).toEqual([
        "GET",
        "POST",
        "PUT",
        "PATCH",
      ]);
    });
  });

  describe("journey-scoped path capabilities (review finding R2-1)", () => {
    const buildWith = (capabilities?: HttpCapabilityGrant[]) =>
      buildScopedHttpTool({
        allowedBaseUrls: [API_BASE, SERVICE_BASE],
        tokenProvider: async () => TOKEN,
        ledger,
        ...(capabilities === undefined ? {} : { capabilities }),
      });

    it("defaults to read-only: mutating requests are rejected pre-fetch when no capabilities are granted", async () => {
      tool = buildWith(undefined);

      const result = await execute({
        method: "POST",
        path_or_url: "/api/v1/items",
        body: {},
      });

      expect(result.isError).toBe(true);
      expect(parsePayload(result).error?.code).toBe("CAPABILITY_NOT_GRANTED");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("GET stays origin-wide regardless of capabilities — reads are the tool's purpose", async () => {
      tool = buildWith([]);
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

      const result = await execute({
        method: "GET",
        path_or_url: "/api/v1/anything/at/all",
      });

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("allows a mutating request matching a grant's method + path pattern", async () => {
      tool = buildWith([{ methods: ["POST"], pathPattern: "/api/v1/items" }]);
      fetchMock.mockResolvedValue(jsonResponse(201, { id: "c-1" }));

      const result = await execute({
        method: "POST",
        path_or_url: "/api/v1/items",
        body: { title: "hi" },
      });

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects mutations on paths outside every grant — before any fetch", async () => {
      tool = buildWith([{ methods: ["POST"], pathPattern: "/api/v1/items" }]);

      const result = await execute({
        method: "POST",
        path_or_url: "/api/v1/datasets",
        body: {},
      });

      expect(result.isError).toBe(true);
      const payload = parsePayload(result);
      expect(payload.error?.code).toBe("CAPABILITY_NOT_GRANTED");
      expect(payload.error?.message).toContain("/api/v1/datasets");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects methods a grant does not list, even on a granted path", async () => {
      tool = buildWith([{ methods: ["POST"], pathPattern: "/api/v1/items" }]);

      const result = await execute({
        method: "PUT",
        path_or_url: "/api/v1/items",
        body: {},
      });

      expect(result.isError).toBe(true);
      expect(parsePayload(result).error?.code).toBe("CAPABILITY_NOT_GRANTED");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("supports single-segment wildcards in path patterns", async () => {
      tool = buildWith([
        { methods: ["PATCH"], pathPattern: "/api/v1/items/*/messages" },
      ]);
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

      const granted = await execute({
        method: "PATCH",
        path_or_url: "/api/v1/items/c-7/messages",
        body: {},
      });
      expect(granted.isError).toBeUndefined();

      const tooDeep = await execute({
        method: "PATCH",
        path_or_url: "/api/v1/items/c-7/messages/m-1",
        body: {},
      });
      expect(tooDeep.isError).toBe(true);
      expect(parsePayload(tooDeep).error?.code).toBe("CAPABILITY_NOT_GRANTED");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("matches against the bare path — query strings cannot defeat a grant boundary", async () => {
      tool = buildWith([{ methods: ["POST"], pathPattern: "/api/v1/items" }]);
      fetchMock.mockResolvedValue(jsonResponse(201, { id: "c-1" }));

      const result = await execute({
        method: "POST",
        path_or_url: "/api/v1/items",
        query: { redirect: "/api/v1/datasets" },
        body: {},
      });

      expect(result.isError).toBeUndefined();
    });

    it("throws at build time when a grant lists a non-grantable method", () => {
      expect(() =>
        buildWith([
          { methods: ["DELETE"], pathPattern: "/api/v1/items" } as never,
        ]),
      ).toThrow(/DELETE/);
      expect(() =>
        buildWith([
          { methods: ["GET"], pathPattern: "/api/v1/items" } as never,
        ]),
      ).toThrow(/GET/);
    });

    describe("encoded-path canonicalization (round-3 finding)", () => {
      const WILDCARD_GRANT: HttpCapabilityGrant[] = [
        { methods: ["PATCH"], pathPattern: "/api/v1/items/*/messages" },
      ];

      const expectRefusedPreFetch = (result: HttpToolResult) => {
        expect(result.isError).toBe(true);
        expect(parsePayload(result).error?.code).toBe("CAPABILITY_NOT_GRANTED");
        expect(fetchMock).not.toHaveBeenCalled();
      };

      it("rejects %2F-encoded separators hiding extra segments in a wildcard", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/c-7%2Fadmin/messages",
            body: {},
          }),
        );
      });

      it("rejects lowercase %2f variants", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/c-7%2fadmin/messages",
            body: {},
          }),
        );
      });

      it("rejects double-encoded %252F separators", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/c-7%252Fadmin/messages",
            body: {},
          }),
        );
      });

      it("rejects %5C-encoded backslash separators", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/c-7%5Cadmin/messages",
            body: {},
          }),
        );
      });

      it("rejects encoded dot-segment traversal (%2E%2E and double-encoded)", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        // WHATWG URL already collapses %2E%2E, so the normalized path
        // falls outside the grant — still refused pre-fetch.
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/%2E%2E/messages",
            body: {},
          }),
        );
        // Double-encoded ..: survives URL normalization, caught by the
        // fixpoint decode.
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/%252E%252E/messages",
            body: {},
          }),
        );
      });

      it("rejects malformed percent-encoding rather than guessing", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/c%zz7/messages",
            body: {},
          }),
        );
      });

      it("rejects bare and incomplete percent escapes before fetch", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        for (const itemId of ["c-%", "c-%G", "c-%A"]) {
          expectRefusedPreFetch(
            await execute({
              method: "PATCH",
              path_or_url: `/api/v1/items/${itemId}/messages`,
              body: {},
            }),
          );
        }
      });

      it("rejects a fullwidth solidus that NFKC normalizes to a separator", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/c-7%EF%BC%8Fadmin/messages",
            body: {},
          }),
        );
      });

      it("rejects a fullwidth percent that reveals an encoded separator after normalization", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/c-%EF%BC%852Fadmin/messages",
            body: {},
          }),
        );
      });

      it("rejects fullwidth dot segments that NFKC normalizes to traversal", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/%EF%BC%8E%EF%BC%8E/messages",
            body: {},
          }),
        );
      });

      it("rejects a fullwidth percent that reveals an encoded dot segment after normalization", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/%EF%BC%852E%EF%BC%852E/messages",
            body: {},
          }),
        );
      });

      it("rejects an invalid percent sequence exposed by a later decode layer", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/c-7%25C0%25AF/messages",
            body: {},
          }),
        );
      });

      it("rejects NUL characters exposed by direct or nested decoding", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/c-7%00/messages",
            body: {},
          }),
        );
        expectRefusedPreFetch(
          await execute({
            method: "PATCH",
            path_or_url: "/api/v1/items/c-7%2500/messages",
            body: {},
          }),
        );
      });

      it("still allows legitimate singly-encoded values like %20", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

        const result = await execute({
          method: "PATCH",
          path_or_url: "/api/v1/items/c%207/messages",
          body: {},
        });

        expect(result.isError).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(
          `${API_BASE}/api/v1/items/c%207/messages`,
        );
      });

      it("still allows legitimate non-ASCII segment values", async () => {
        tool = buildWith([...WILDCARD_GRANT]);
        fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

        const result = await execute({
          method: "PATCH",
          path_or_url: "/api/v1/items/c%C3%A9/messages",
          body: {},
        });

        expect(result.isError).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it("leaves GET untouched — path tricks cannot change the origin", async () => {
        tool = buildWith([]);
        fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

        const result = await execute({
          method: "GET",
          path_or_url: "/api/v1/items/c-7%2Fadmin/messages",
        });

        expect(result.isError).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    it("advertises only grantable mutating methods in the input schema enum", () => {
      tool = buildWith([{ methods: ["POST"], pathPattern: "/api/v1/items" }]);
      const schema = tool.inputSchema as {
        properties: { method: { enum: string[] } };
      };
      expect(schema.properties.method.enum).toEqual(["GET", "POST"]);

      tool = buildWith([]);
      const readOnly = tool.inputSchema as {
        properties: { method: { enum: string[] } };
      };
      expect(readOnly.properties.method.enum).toEqual(["GET"]);
    });
  });

  describe("credential handling", () => {
    it("injects Authorization: Bearer <jwt> from the tokenProvider", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
      await execute({ method: "GET", path_or_url: "/api/v1/items" });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        `Bearer ${TOKEN}`,
      );
    });

    it("injects the session headers from the headersProvider when provided", async () => {
      const scopedTool = buildScopedHttpTool({
        allowedBaseUrls: [API_BASE],
        tokenProvider: async () => TOKEN,
        headersProvider: async () => ({
          "X-Org-ID": " org-xyz ",
          "X-Empty": "",
        }),
        ledger,
      });
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
      await (scopedTool.execute(
        { method: "GET", path_or_url: "/api/v1/items" },
        {},
      ) as Promise<HttpToolResult>);

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Org-ID"]).toBe("org-xyz");
      // Empty values are dropped, and a session header never replaces auth.
      expect(headers["X-Empty"]).toBeUndefined();
      expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("sends no extra headers when no headersProvider is given", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
      await execute({ method: "GET", path_or_url: "/api/v1/items" });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(
        (init.headers as Record<string, string>)["X-Org-ID"],
      ).toBeUndefined();
    });

    it("never surfaces the token in results", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { items: [] }));
      const result = await execute({
        method: "GET",
        path_or_url: "/api/v1/items",
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("scrubs the token from network-failure error results instead of throwing", async () => {
      fetchMock.mockRejectedValue(
        new Error(`connect failed sending Bearer ${TOKEN} to host`),
      );
      const result = await execute({
        method: "GET",
        path_or_url: "/api/v1/items",
      });

      expect(result.isError).toBe(true);
      const payload = parsePayload(result);
      expect(payload.error?.code).toBe("REQUEST_FAILED");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("has no headers field in the input schema (agent cannot inject headers)", () => {
      const schema = tool.inputSchema as {
        properties: Record<string, unknown>;
      };
      expect(Object.keys(schema.properties).sort()).toEqual([
        "body",
        "method",
        "path_or_url",
        "query",
      ]);
    });
  });

  describe("responses", () => {
    it("surfaces 4xx as a structured result, not a throw", async () => {
      fetchMock.mockResolvedValue(jsonResponse(404, { detail: "not found" }));
      const payload = parsePayload(
        await execute({ method: "GET", path_or_url: "/api/v1/items/nope" }),
      );
      expect(payload.status).toBe(404);
      expect(payload.body).toEqual({ detail: "not found" });
    });

    it("surfaces 5xx as a structured result, not a throw", async () => {
      fetchMock.mockResolvedValue(jsonResponse(503, { detail: "down" }));
      const payload = parsePayload(
        await execute({ method: "GET", path_or_url: "/api/v1/items" }),
      );
      expect(payload.status).toBe(503);
    });

    it("returns only a content-type header subset, never response auth headers", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          200,
          { ok: true },
          {
            "content-type": "application/json",
            "set-cookie": "session=secret-cookie",
            "www-authenticate": "Bearer realm=x",
          },
        ),
      );
      const result = await execute({
        method: "GET",
        path_or_url: "/api/v1/items",
      });
      const payload = parsePayload(result);
      expect(payload.headers).toEqual({ "content-type": "application/json" });
      expect(JSON.stringify(result)).not.toContain("secret-cookie");
    });

    it("truncates bodies above the byte cap and flags it", async () => {
      tool = buildScopedHttpTool({
        allowedBaseUrls: [API_BASE],
        tokenProvider: async () => TOKEN,
        ledger,
        maxResponseBytes: 64,
      });
      const bigBody = "x".repeat(10_000);
      fetchMock.mockResolvedValue(
        new Response(bigBody, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
      const payload = parsePayload(
        await execute({ method: "GET", path_or_url: "/api/v1/big" }),
      );

      expect(payload.truncated).toBe(true);
      expect((payload.body as string).length).toBeLessThanOrEqual(64);
    });

    it("appends query params from args", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
      await execute({
        method: "GET",
        path_or_url: "/api/v1/items",
        query: { limit: "5" },
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${API_BASE}/api/v1/items?limit=5`,
      );
    });

    it("serializes JSON bodies for mutating requests", async () => {
      fetchMock.mockResolvedValue(jsonResponse(201, { id: "c-1" }));
      await execute({
        method: "POST",
        path_or_url: "/api/v1/items",
        body: { title: "hi" },
      });
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ title: "hi" }));
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/json",
      );
    });
  });

  describe("fetch bounding (review finding 6)", () => {
    it("bounds every fetch with an abort signal even absent a run deadline", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
      await execute({ method: "GET", path_or_url: "/api/v1/items" });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("aborts in-flight fetches when the run-deadline signal fires", async () => {
      const controller = new AbortController();
      tool = buildScopedHttpTool({
        allowedBaseUrls: [API_BASE],
        tokenProvider: async () => TOKEN,
        ledger,
        signal: controller.signal,
      });
      controller.abort();
      fetchMock.mockImplementation(async (...args: unknown[]) => {
        const init = args[1] as RequestInit;
        if (init.signal?.aborted) {
          throw new Error("This operation was aborted");
        }
        return jsonResponse(200, { ok: true });
      });

      const result = await execute({
        method: "GET",
        path_or_url: "/api/v1/items",
      });

      expect(result.isError).toBe(true);
      expect(parsePayload(result).error?.code).toBe("REQUEST_FAILED");
    });
  });

  describe("ledger feed", () => {
    it("records recognized creations with source http-tool", async () => {
      fetchMock.mockResolvedValue(jsonResponse(201, { id: "item-1" }));
      await execute({
        method: "POST",
        path_or_url: "/api/v1/items",
        body: { title: "hi" },
      });

      expect(ledger.entries).toEqual([
        expect.objectContaining({
          resourceType: "item",
          id: "item-1",
          source: "http-tool",
          cleanup: { method: "DELETE", path: "/api/v1/items/item-1" },
        }),
      ]);
    });

    it("does not feed the ledger for GET requests", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { id: "item-1" }));
      await execute({ method: "GET", path_or_url: "/api/v1/items" });
      expect(ledger.entries).toHaveLength(0);
      expect(ledger.warnings).toHaveLength(0);
    });

    it("flags unrecognized successful mutations as unmanaged warnings", async () => {
      fetchMock.mockResolvedValue(jsonResponse(201, { id: "ds-1" }));
      await execute({
        method: "POST",
        path_or_url: "/api/v1/datasets",
        body: {},
      });
      expect(ledger.entries).toHaveLength(0);
      expect(ledger.warnings).toEqual([
        expect.objectContaining({
          method: "POST",
          path: "/api/v1/datasets",
          source: "http-tool",
        }),
      ]);
    });
  });
});

describe("allowedBaseUrlsFromEnv", () => {
  it("collects baseUrls.api plus all baseUrls.services values", () => {
    expect(
      allowedBaseUrlsFromEnv({
        baseUrls: {
          web: "http://localhost:3000",
          api: "http://localhost:8000",
          services: {
            folders: "http://localhost:8084",
            artifacts: "http://localhost:8082",
          },
        },
      }),
    ).toEqual([
      "http://localhost:8000",
      "http://localhost:8084",
      "http://localhost:8082",
    ]);
  });

  it("excludes baseUrls.web — the HTTP tool is API-scoped", () => {
    const allowed = allowedBaseUrlsFromEnv({
      baseUrls: {
        web: "http://localhost:3000",
        api: "http://localhost:8000",
        services: {},
      },
    });
    expect(allowed).not.toContain("http://localhost:3000");
  });
});
