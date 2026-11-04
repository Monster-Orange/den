/**
 * Unit tests for the browser network-interception ledger feed
 * (src/pillars/journeys/tools/browser-tool.ts — context.on("response")).
 * Playwright is fully mocked.
 *
 * Contract under test (plan: jrn-browser-tool packet):
 * - Mutating API calls (POST/PUT/PATCH/DELETE to allowlisted API origins)
 *   the web app makes feed the SAME ResourceDescriptor matcher as the HTTP
 *   tool, source-tagged "browser".
 * - Unrecognized successful mutations become unmanaged-mutation warnings.
 * - DATA MINIMIZATION: an interception record retains ONLY {method,
 *   sanitized path (query stripped), status, extracted id, source tag} —
 *   never headers, cookies, Authorization values, or bodies. Bodies are
 *   parsed transiently for id extraction and discarded.
 * - Sentinel tests: fake Authorization / Set-Cookie / password values
 *   pushed through the interception path never reach ledger entries or
 *   warnings.
 */

import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildBrowserToolset,
  INTERCEPTION_BODY_TIMEOUT_MS,
  INTERCEPTION_MAX_BODY_BYTES,
  type BrowserLike,
  type BrowserToolset,
  type BrowserToolsetTimeouts,
  type ContextLike,
  type PageLike,
  type ResponseLike,
} from "../../../src/pillars/journeys/tools/browser-tool.js";
import { SnapshotStore } from "../../../src/pillars/journeys/tools/snapshot-store.js";
import { RunLedger } from "../../../src/pillars/journeys/tools/ledger.js";
import { TEST_APP, testLedgerRegistry } from "./fixtures/test-app.js";
import type { JourneysWebApiConfig } from "../../../src/pillars/journeys/app-config.js";

const WEB_BASE = "http://localhost:3000";
const API_BASE = "http://localhost:8000";
const AUTH_SENTINEL = "Bearer sentinel-authorization-token";
const COOKIE_SENTINEL = "session=sentinel-set-cookie-value";
const PASSWORD_SENTINEL = "sentinel-body-password";

interface Feed {
  ledger: RunLedger;
  toolset: BrowserToolset;
  emit: (response: ResponseLike) => Promise<void>;
  /** Fire the handlers WITHOUT awaiting them (in-flight simulation). */
  emitNoAwait: (response: ResponseLike) => void;
}

/** Build the toolset over a mock context and return the response feed. */
async function makeFeed(
  timeouts?: BrowserToolsetTimeouts,
  /** null = the app declares no web_api. */
  webApi: JourneysWebApiConfig | null = TEST_APP.web_api ?? null,
): Promise<Feed> {
  const responseHandlers: Array<(response: ResponseLike) => unknown> = [];

  const page = {
    url: () => `${WEB_BASE}/`,
    title: async () => "Example App",
    goto: jest.fn(async () => undefined),
    goBack: jest.fn(async () => undefined),
    evaluate: jest.fn(async () => []),
    screenshot: jest.fn(async () => undefined),
    locator: jest.fn(),
    waitForLoadState: jest.fn(async () => undefined),
    waitForTimeout: jest.fn(async () => undefined),
    on: jest.fn(),
    close: jest.fn(async () => undefined),
  } as unknown as PageLike;

  const context = {
    newPage: jest.fn(async () => page),
    on: (event: string, handler: (response: ResponseLike) => unknown) => {
      if (event === "response") responseHandlers.push(handler);
    },
    close: jest.fn(async () => undefined),
  } as unknown as ContextLike;

  const browser = {
    newContext: jest.fn(async () => context),
    close: jest.fn(async () => undefined),
  } as unknown as BrowserLike;

  const ledger = new RunLedger(testLedgerRegistry());
  const store = new SnapshotStore(
    fs.mkdtempSync(path.join(os.tmpdir(), "jrn-int-")),
  );
  const toolset = buildBrowserToolset({
    env: {
      baseUrls: {
        web: WEB_BASE,
        api: API_BASE,
        services: { folders: "http://localhost:8084" },
      },
    },
    authFilePath: "/tmp/auth.json",
    snapshotStore: store,
    ledger,
    launcher: { launch: jest.fn(async () => browser) as never },
    ...(timeouts === undefined ? {} : { timeouts }),
    ...(webApi === null ? {} : { webApi }),
  });
  await toolset.start();

  expect(responseHandlers.length).toBeGreaterThan(0);
  return {
    ledger,
    toolset,
    emit: async (response) => {
      for (const handler of responseHandlers) {
        await handler(response);
      }
    },
    emitNoAwait: (response) => {
      for (const handler of responseHandlers) {
        void handler(response);
      }
    },
  };
}

function makeResponse(options: {
  method?: string;
  url: string;
  status?: number;
  body?: unknown;
  jsonThrows?: boolean;
  contentType?: string;
  contentLength?: string;
  json?: () => Promise<unknown>;
}): ResponseLike {
  return {
    url: () => options.url,
    status: () => options.status ?? 201,
    request: () => ({
      method: () => options.method ?? "POST",
      // A real Playwright request would expose headers — the feed must
      // never read them. They exist here purely as sentinel bait.
      headers: () => ({ authorization: AUTH_SENTINEL }),
    }),
    // Only content-type/content-length are metadata the feed may consult
    // (review finding R2-2); set-cookie stays sentinel bait.
    headers: () => ({
      "set-cookie": COOKIE_SENTINEL,
      "content-type": options.contentType ?? "application/json",
      ...(options.contentLength === undefined
        ? {}
        : { "content-length": options.contentLength }),
    }),
    json:
      options.json ??
      (async () => {
        if (options.jsonThrows) throw new Error("not json (SSE stream)");
        return options.body;
      }),
  } as unknown as ResponseLike;
}

describe("browser network interception — ledger feed", () => {
  it("records recognized creations through the shared matcher with source browser", async () => {
    const feed = await makeFeed();

    await feed.emit(
      makeResponse({
        url: `${API_BASE}/api/v1/items`,
        body: { id: "item-42", password: PASSWORD_SENTINEL },
      }),
    );

    expect(feed.ledger.entries).toEqual([
      expect.objectContaining({
        resourceType: "item",
        id: "item-42",
        method: "POST",
        path: "/api/v1/items",
        status: 201,
        source: "browser",
        cleanup: { method: "DELETE", path: "/api/v1/items/item-42" },
      }),
    ]);
  });

  it("flags unrecognized successful mutations as unmanaged warnings", async () => {
    const feed = await makeFeed();

    await feed.emit(
      makeResponse({
        url: `${API_BASE}/api/v1/datasets`,
        body: { id: "ds-1" },
      }),
    );

    expect(feed.ledger.entries).toHaveLength(0);
    expect(feed.ledger.warnings).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/datasets",
        source: "browser",
      }),
    ]);
  });

  it("ignores GET traffic", async () => {
    const feed = await makeFeed();
    await feed.emit(
      makeResponse({
        method: "GET",
        url: `${API_BASE}/api/v1/items`,
        status: 200,
        body: { id: "item-1" },
      }),
    );
    expect(feed.ledger.entries).toHaveLength(0);
    expect(feed.ledger.warnings).toHaveLength(0);
  });

  it("ignores mutations to non-API origins (web app auth routes, the IdP)", async () => {
    const feed = await makeFeed();
    await feed.emit(
      makeResponse({ url: `${WEB_BASE}/api/auth/callback`, body: {} }),
    );
    await feed.emit(
      makeResponse({
        url: "https://example.us.auth0.com/oauth/token",
        body: { access_token: AUTH_SENTINEL },
      }),
    );
    expect(feed.ledger.entries).toHaveLength(0);
    expect(feed.ledger.warnings).toHaveLength(0);
  });

  it("ignores action POSTs (test/browse/messages-stream)", async () => {
    const feed = await makeFeed();
    await feed.emit(
      makeResponse({
        url: `${API_BASE}/api/v1/folders/c-1/test`,
        body: { ok: true },
      }),
    );
    expect(feed.ledger.entries).toHaveLength(0);
    expect(feed.ledger.warnings).toHaveLength(0);
  });

  it("strips query strings from stored paths", async () => {
    const feed = await makeFeed();
    await feed.emit(
      makeResponse({
        url: `${API_BASE}/api/v1/items?token=leaky-query-token`,
        body: { id: "item-7" },
      }),
    );
    expect(feed.ledger.entries[0].path).toBe("/api/v1/items");
    expect(JSON.stringify(feed.ledger.entries)).not.toContain(
      "leaky-query-token",
    );
  });

  it("degrades to a warning when the body is unparseable (SSE stream)", async () => {
    const feed = await makeFeed();
    await feed.emit(
      makeResponse({
        url: `${API_BASE}/api/v1/items`,
        jsonThrows: true,
      }),
    );
    expect(feed.ledger.entries).toHaveLength(0);
    expect(feed.ledger.warnings).toHaveLength(1);
  });

  it("binds extracted ids for verifier {placeholder} use", async () => {
    const feed = await makeFeed();
    await feed.emit(
      makeResponse({
        url: `http://localhost:8084/api/v1/folders`,
        body: { id: "fold-99" },
      }),
    );
    expect(feed.ledger.entries[0]).toEqual(
      expect.objectContaining({
        resourceType: "folder",
        id: "fold-99",
        cleanup: { method: "DELETE", path: "/api/v1/folders/fold-99" },
      }),
    );
  });

  it("records web-origin API creations under web_api.prefix, applying the declared rewrites", async () => {
    // An app whose browser code calls its API through its own web origin
    // (a backend-for-frontend proxy) POSTs to <web>/api/folders — it NEVER
    // hits an API origin. The declared rewrite maps the path to
    // /api/v1/folders so it matches the same descriptor the verifier
    // probes and {folder_id} binds.
    const feed = await makeFeed();
    await feed.emit(
      makeResponse({
        url: `${WEB_BASE}/api/folders`,
        body: { id: "fold-web-1" },
      }),
    );
    expect(feed.ledger.entries).toEqual([
      expect.objectContaining({
        resourceType: "folder",
        id: "fold-web-1",
        method: "POST",
        path: "/api/v1/folders",
        status: 201,
        source: "browser",
        cleanup: { method: "DELETE", path: "/api/v1/folders/fold-web-1" },
      }),
    ]);
  });

  it("passes a web-origin path that no rewrite covers through unchanged", async () => {
    const feed = await makeFeed();
    await feed.emit(
      makeResponse({
        url: `${WEB_BASE}/api/v1/folders`,
        body: { id: "fold-web-2" },
      }),
    );
    expect(feed.ledger.entries).toEqual([
      expect.objectContaining({ resourceType: "folder", id: "fold-web-2" }),
    ]);
  });

  it("still ignores web-origin routes under web_api.ignore (auth callbacks)", async () => {
    const feed = await makeFeed();
    await feed.emit(
      makeResponse({ url: `${WEB_BASE}/api/auth/callback`, body: {} }),
    );
    expect(feed.ledger.entries).toHaveLength(0);
    expect(feed.ledger.warnings).toHaveLength(0);
  });

  it("ignores web-origin mutations outside web_api.prefix", async () => {
    const feed = await makeFeed();
    await feed.emit(
      makeResponse({ url: `${WEB_BASE}/settings/save`, body: { id: "x" } }),
    );
    expect(feed.ledger.entries).toHaveLength(0);
    expect(feed.ledger.warnings).toHaveLength(0);
  });

  it("watches only API origins when the app declares no web_api", async () => {
    const feed = await makeFeed(undefined, null);
    await feed.emit(
      makeResponse({ url: `${WEB_BASE}/api/folders`, body: { id: "f-1" } }),
    );
    expect(feed.ledger.entries).toHaveLength(0);
    expect(feed.ledger.warnings).toHaveLength(0);
  });

  describe("interception draining (review finding 7)", () => {
    it("drain() waits for in-flight response handlers so the ledger is complete", async () => {
      const feed = await makeFeed();
      let release: ((body: unknown) => void) | undefined;
      const slowResponse = makeResponse({
        url: `${API_BASE}/api/v1/items`,
        json: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      });

      feed.emitNoAwait(slowResponse);
      expect(feed.ledger.entries).toHaveLength(0);

      const drained = feed.toolset.drain();
      release?.({ id: "item-9" });
      await drained;

      expect(feed.ledger.entries).toEqual([
        expect.objectContaining({ resourceType: "item", id: "item-9" }),
      ]);
    });

    it("drain() resolves immediately when nothing is pending", async () => {
      const feed = await makeFeed();
      await expect(feed.toolset.drain()).resolves.toBeUndefined();
    });

    it("records interception-processing failures as ledger interception errors — never silent", async () => {
      const feed = await makeFeed();
      jest.spyOn(feed.ledger, "record").mockImplementation(() => {
        throw new Error("matcher exploded");
      });

      await feed.emit(
        makeResponse({ url: `${API_BASE}/api/v1/items`, body: { id: "x" } }),
      );
      await feed.toolset.drain();

      expect(feed.ledger.interceptionErrors).toEqual([
        expect.stringContaining("matcher exploded"),
      ]);
    });
  });

  describe("bounded body processing + drain (review finding R2-2)", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("never parses non-JSON bodies (SSE streams) — json() is not called", async () => {
      const feed = await makeFeed();
      const json = jest.fn(async () => ({ id: "never" }));

      await feed.emit(
        makeResponse({
          url: `${API_BASE}/api/v1/items`,
          contentType: "text/event-stream",
          json,
        }),
      );

      expect(json).not.toHaveBeenCalled();
      // Recognized creation without an extractable id degrades to a
      // reported warning — never a hang, never a guessed delete.
      expect(feed.ledger.entries).toHaveLength(0);
      expect(feed.ledger.warnings).toHaveLength(1);
    });

    it("never parses bodies whose content-length exceeds the cap", async () => {
      const feed = await makeFeed();
      const json = jest.fn(async () => ({ id: "never" }));

      await feed.emit(
        makeResponse({
          url: `${API_BASE}/api/v1/items`,
          contentLength: String(INTERCEPTION_MAX_BODY_BYTES + 1),
          json,
        }),
      );

      expect(json).not.toHaveBeenCalled();
      expect(feed.ledger.warnings).toHaveLength(1);
    });

    it("bounds a hung json() read and surfaces an interception warning", async () => {
      jest.useFakeTimers();
      const feed = await makeFeed();

      feed.emitNoAwait(
        makeResponse({
          url: `${API_BASE}/api/v1/items`,
          json: () => new Promise(() => undefined),
        }),
      );

      const drained = feed.toolset.drain();
      await jest.advanceTimersByTimeAsync(INTERCEPTION_BODY_TIMEOUT_MS + 1);
      await drained;

      expect(feed.ledger.interceptionErrors).toEqual([
        expect.stringContaining("timed out"),
      ]);
      // The record still lands (body unknown → unmanaged warning).
      expect(feed.ledger.entries).toHaveLength(0);
      expect(feed.ledger.warnings).toHaveLength(1);
    });

    it("drain() resolves at its cap even when a handler never settles, with a drain warning", async () => {
      jest.useFakeTimers();
      // Body timeout far beyond the drain cap so the handler stays
      // genuinely pending while drain's own bound fires.
      const feed = await makeFeed({ bodyMs: 60_000, drainMs: 1_000 });

      feed.emitNoAwait(
        makeResponse({
          url: `${API_BASE}/api/v1/items`,
          json: () => new Promise(() => undefined),
        }),
      );

      const drained = feed.toolset.drain();
      await jest.advanceTimersByTimeAsync(1_001);
      await drained;

      expect(feed.ledger.interceptionErrors).toEqual([
        expect.stringContaining("drain"),
      ]);
    });
  });

  describe("data minimization", () => {
    it("retains ONLY method, sanitized path, status, id, source, cleanup", async () => {
      const feed = await makeFeed();
      await feed.emit(
        makeResponse({
          url: `${API_BASE}/api/v1/items`,
          body: { id: "item-1", secret: PASSWORD_SENTINEL },
        }),
      );

      expect(Object.keys(feed.ledger.entries[0]).sort()).toEqual([
        "cleanup",
        "id",
        "method",
        "path",
        "resourceType",
        "source",
        "status",
      ]);
    });

    it("sentinel: Authorization, Set-Cookie, and password values never reach ledger state", async () => {
      const feed = await makeFeed();
      await feed.emit(
        makeResponse({
          url: `${API_BASE}/api/v1/items`,
          body: {
            id: "item-1",
            password: PASSWORD_SENTINEL,
            authorization: AUTH_SENTINEL,
          },
        }),
      );
      await feed.emit(
        makeResponse({
          url: `${API_BASE}/api/v1/unknown-things`,
          body: { password: PASSWORD_SENTINEL },
        }),
      );

      const state = JSON.stringify({
        entries: feed.ledger.entries,
        warnings: feed.ledger.warnings,
      });
      expect(state).not.toContain(AUTH_SENTINEL);
      expect(state).not.toContain(COOKIE_SENTINEL);
      expect(state).not.toContain(PASSWORD_SENTINEL);
    });
  });
});
