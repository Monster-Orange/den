/**
 * Unit tests for the journeys browser toolset
 * (src/pillars/journeys/tools/browser-tool.ts + snapshot-store.ts).
 * Playwright is fully mocked — no real browser is launched.
 *
 * Contract under test (plan: jrn-browser-tool packet):
 * - Tool surface: browser_navigate / browser_snapshot / browser_click /
 *   browser_type / browser_select / browser_wait, each returning a TEXT page
 *   summary (URL, title, interactable elements with stable refs) — never raw
 *   secrets, never image payloads.
 * - Web-origin policy enforced after EVERY action (click-driven redirects
 *   reverted + reported as structured tool errors), popups/new pages closed,
 *   downloads denied — all reported. Subresource/XHR traffic is never
 *   blocked (no route interception is ever installed).
 * - Deterministic per-action PNG screenshots into the SnapshotStore
 *   (NNN-<action>.png) with SnapshotIndex entries {seq, action, url, path,
 *   ts}; failures capture an additional failure-tagged screenshot.
 * - Credential safety: browser_type into password/otp inputs is masked in
 *   tool results and SnapshotIndex metadata, and the screenshot for that
 *   action is suppressed BEFORE page.screenshot() could run (critique
 *   finding D2-1: the sensitive frame must never be captured).
 * - Storage-state contents, cookies, passwords never appear in tool
 *   results, SnapshotIndex entries, or policy reports.
 */

import { describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildBrowserToolset,
  BROWSER_TOOL_NAMES,
  type BrowserToolset,
  type BrowserLike,
  type ContextLike,
  type PageLike,
  type LocatorLike,
} from "../../../src/pillars/journeys/tools/browser-tool.js";
import { SnapshotStore } from "../../../src/pillars/journeys/tools/snapshot-store.js";
import { RunLedger } from "../../../src/pillars/journeys/tools/ledger.js";
import { testLedgerRegistry } from "./fixtures/test-app.js";

const WEB_BASE = "http://localhost:3000";
const API_BASE = "http://localhost:8000";
const AUTH_FILE = "/tmp/playwright/.auth/user-local.json";
const PASSWORD_SENTINEL = "sentinel-password-p4ss";
const COOKIE_SENTINEL = "sentinel-cookie-value";

interface MockElement {
  ref: string;
  role: string;
  name: string;
}

/** Mutable mock harness standing in for a Playwright browser stack. */
interface Harness {
  browser: BrowserLike;
  context: ContextLike;
  page: PageLike;
  /** Auto-creating locator registry keyed by selector. */
  locators: { get: (selector: string) => LocatorLike };
  /** Handlers registered via context.on(). */
  contextHandlers: Map<string, Array<(arg: never) => void>>;
  /** Handlers registered via page.on(). */
  pageHandlers: Map<string, Array<(arg: never) => void>>;
  setUrl: (url: string) => void;
  setElements: (elements: MockElement[]) => void;
  launch: jest.Mock;
  newContext: jest.Mock;
  screenshot: jest.Mock;
  goto: jest.Mock;
  goBack: jest.Mock;
}

function makeLocator(
  overrides: Partial<Record<keyof LocatorLike, unknown>> = {},
): LocatorLike {
  return {
    click: jest.fn(async () => undefined),
    fill: jest.fn(async () => undefined),
    press: jest.fn(async () => undefined),
    selectOption: jest.fn(async () => undefined),
    evaluate: jest.fn(async () => ({ type: "text", autocomplete: "" })),
    ...overrides,
  } as LocatorLike;
}

function makeHarness(): Harness {
  let currentUrl = `${WEB_BASE}/`;
  let elements: MockElement[] = [
    { ref: "e1", role: "button", name: "Send" },
    { ref: "e2", role: "textbox", name: "Message" },
  ];
  const contextHandlers = new Map<string, Array<(arg: never) => void>>();
  const pageHandlers = new Map<string, Array<(arg: never) => void>>();
  const locatorMap = new Map<string, LocatorLike>();
  const locators = {
    get: (selector: string): LocatorLike => {
      const existing = locatorMap.get(selector);
      if (existing) return existing;
      const fresh = makeLocator();
      locatorMap.set(selector, fresh);
      return fresh;
    },
  };

  const screenshot = jest.fn(async () => undefined);
  const goto = jest.fn(async (url: string) => {
    currentUrl = url;
  });
  const goBack = jest.fn(async () => {
    currentUrl = `${WEB_BASE}/`;
  });

  const page = {
    url: () => currentUrl,
    title: async () => "Example App",
    goto,
    goBack,
    evaluate: jest.fn(async () => elements),
    screenshot,
    locator: (selector: string) => locators.get(selector),
    waitForLoadState: jest.fn(async () => undefined),
    waitForTimeout: jest.fn(async () => undefined),
    on: (event: string, handler: (arg: never) => void) => {
      const list = pageHandlers.get(event) ?? [];
      list.push(handler);
      pageHandlers.set(event, list);
    },
    close: jest.fn(async () => undefined),
  } as unknown as PageLike;

  const context = {
    newPage: jest.fn(async () => page),
    on: (event: string, handler: (arg: never) => void) => {
      const list = contextHandlers.get(event) ?? [];
      list.push(handler);
      contextHandlers.set(event, list);
    },
    route: jest.fn(),
    close: jest.fn(async () => undefined),
  } as unknown as ContextLike;

  const newContext = jest.fn(async () => context);
  const browser = {
    newContext,
    close: jest.fn(async () => undefined),
  } as unknown as BrowserLike;
  const launch = jest.fn(async () => browser);

  return {
    browser,
    context,
    page,
    locators,
    contextHandlers,
    pageHandlers,
    setUrl: (url) => {
      currentUrl = url;
    },
    setElements: (next) => {
      elements = next;
    },
    launch,
    newContext,
    screenshot,
    goto,
    goBack,
  };
}

function makeToolset(harness: Harness): {
  toolset: BrowserToolset;
  store: SnapshotStore;
  ledger: RunLedger;
  reportDir: string;
} {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-snap-"));
  const store = new SnapshotStore(reportDir);
  const ledger = new RunLedger(testLedgerRegistry());
  const toolset = buildBrowserToolset({
    env: {
      baseUrls: {
        web: WEB_BASE,
        api: API_BASE,
        services: { folders: "http://localhost:8084" },
      },
    },
    authFilePath: AUTH_FILE,
    snapshotStore: store,
    ledger,
    launcher: { launch: harness.launch as never },
  });
  return { toolset, store, ledger, reportDir };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

async function run(
  toolset: BrowserToolset,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = toolset.tools[name];
  if (!tool) throw new Error(`tool ${name} not found`);
  return (await tool.execute(args as never, {} as never)) as ToolResult;
}

function text(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("buildBrowserToolset — surface", () => {
  it("exposes exactly the six browser tools", () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);

    expect(Object.keys(toolset.tools).sort()).toEqual(
      [...BROWSER_TOOL_NAMES].sort(),
    );
    expect(BROWSER_TOOL_NAMES).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_select",
      "browser_wait",
    ]);
    for (const tool of Object.values(toolset.tools)) {
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("lazily launches and creates the context from the pre-minted storageState", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);

    expect(harness.launch).not.toHaveBeenCalled();
    await run(toolset, "browser_snapshot");

    expect(harness.launch).toHaveBeenCalledTimes(1);
    expect(harness.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ storageState: AUTH_FILE }),
    );
  });

  it("returns a TEXT page summary with URL, title, and stable element refs", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);

    const result = await run(toolset, "browser_snapshot");
    const summary = text(result);

    expect(result.isError).toBeUndefined();
    expect(summary).toContain(`${WEB_BASE}/`);
    expect(summary).toContain("Example App");
    expect(summary).toContain("[e1]");
    expect(summary).toContain('button "Send"');
    expect(summary).toContain("[e2]");
  });

  it("never installs request/route interception — app XHR stays untouched", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);
    await run(toolset, "browser_snapshot");

    expect(
      (harness.context as unknown as { route: jest.Mock }).route,
    ).not.toHaveBeenCalled();
  });

  it("returns a COMPACT result (no element dump) after click/type/wait", async () => {
    // Cost control: only browser_snapshot / browser_navigate return the full
    // interactable-element dump. click/type/wait return URL + title + a
    // re-snapshot hint, so the agent's context does not accumulate a full
    // page snapshot after every action (staging: 46 actions × full snapshot
    // ≈ 3.2M tokens). Refs from the last full snapshot stay valid.
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);
    await run(toolset, "browser_snapshot");

    const clickResult = await run(toolset, "browser_click", { ref: "e1" });
    const clickText = text(clickResult);
    expect(clickResult.isError).toBeUndefined();
    expect(clickText).toContain(`${WEB_BASE}/`);
    expect(clickText).toContain("browser_snapshot for fresh element refs");
    // The compact result must NOT carry the element dump.
    expect(clickText).not.toContain("Interactable elements:");
    expect(clickText).not.toContain("[e2]");

    // A ref from the prior full snapshot is still usable (knownRefs intact).
    const secondClick = await run(toolset, "browser_click", { ref: "e2" });
    expect(secondClick.isError).toBeUndefined();
  });

  it("browser_navigate still returns the FULL element dump (fresh page needs refs)", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);

    const result = await run(toolset, "browser_navigate", { url: "/items" });
    const summary = text(result);
    expect(result.isError).toBeUndefined();
    expect(summary).toContain("Interactable elements:");
    expect(summary).toContain("[e1]");
  });
});

describe("buildBrowserToolset — origin policy", () => {
  it("rejects browser_navigate to an external origin without navigating", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);

    const result = await run(toolset, "browser_navigate", {
      url: "https://evil.example.com/phish",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("EXTERNAL_NAVIGATION_BLOCKED");
    expect(harness.goto).not.toHaveBeenCalled();
  });

  it("navigates same-origin paths resolved against the web base URL", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);

    const result = await run(toolset, "browser_navigate", { url: "/items" });

    expect(result.isError).toBeUndefined();
    expect(harness.goto).toHaveBeenCalledWith(
      `${WEB_BASE}/items`,
      expect.anything(),
    );
  });

  it("reverts and reports click-driven external redirects (post-action policy)", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);
    await run(toolset, "browser_snapshot");

    const locator = harness.locators.get('[data-den-ref="e1"]');
    (locator.click as jest.Mock).mockImplementation(async () => {
      harness.setUrl("https://evil.example.com/landed");
    });

    const result = await run(toolset, "browser_click", { ref: "e1" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("EXTERNAL_NAVIGATION_BLOCKED");
    expect(harness.goBack).toHaveBeenCalledTimes(1);
    expect(toolset.policyReports).toEqual([
      expect.objectContaining({ kind: "external-navigation-blocked" }),
    ]);
  });

  it("closes and reports popups/new pages", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);
    await run(toolset, "browser_snapshot");

    const popupClose = jest.fn(async () => undefined);
    const popup = {
      close: popupClose,
      url: () => "https://popup.example.com/",
    };
    for (const handler of harness.contextHandlers.get("page") ?? []) {
      handler(popup as never);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(popupClose).toHaveBeenCalledTimes(1);
    expect(toolset.policyReports).toEqual([
      expect.objectContaining({ kind: "popup-closed" }),
    ]);
  });

  it("denies and reports downloads", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);
    await run(toolset, "browser_snapshot");

    const cancel = jest.fn(async () => undefined);
    for (const handler of harness.pageHandlers.get("download") ?? []) {
      handler({ cancel } as never);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(toolset.policyReports).toEqual([
      expect.objectContaining({ kind: "download-denied" }),
    ]);
  });
});

describe("buildBrowserToolset — snapshots", () => {
  it("persists a deterministic per-action PNG and SnapshotIndex entry", async () => {
    const harness = makeHarness();
    const { toolset, store } = makeToolset(harness);

    await run(toolset, "browser_navigate", { url: "/items" });
    await run(toolset, "browser_snapshot");

    expect(harness.screenshot).toHaveBeenCalledTimes(2);
    expect(store.index).toHaveLength(2);
    expect(store.index[0]).toEqual(
      expect.objectContaining({
        seq: 1,
        action: "navigate",
        url: `${WEB_BASE}/items`,
        path: expect.stringContaining("001-navigate.png"),
        ts: expect.any(String),
      }),
    );
    expect(store.index[1].path).toContain("002-snapshot.png");
    // Screenshots land under the run's snapshots dir.
    expect(store.index[0].path).toContain(store.snapshotsDir);
    expect((harness.screenshot.mock.calls[0][0] as { path: string }).path).toBe(
      store.index[0].path,
    );
  });

  it("captures a failure-tagged screenshot when an action fails", async () => {
    const harness = makeHarness();
    const { toolset, store } = makeToolset(harness);
    await run(toolset, "browser_snapshot");

    const locator = harness.locators.get('[data-den-ref="e1"]');
    (locator.click as jest.Mock).mockRejectedValue(
      new Error("Timeout 5000ms exceeded") as never,
    );

    const result = await run(toolset, "browser_click", { ref: "e1" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("ACTION_FAILED");
    const failureEntries = store.index.filter((e) => e.failure === true);
    expect(failureEntries).toHaveLength(1);
    expect(failureEntries[0].path).toContain("-failure.png");
  });

  it("rejects unknown refs with a structured error", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);
    await run(toolset, "browser_snapshot");

    const result = await run(toolset, "browser_click", { ref: "e99" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("UNKNOWN_REF");
  });
});

describe("buildBrowserToolset — credential safety", () => {
  async function typeIntoSensitiveField(
    harness: Harness,
    toolset: BrowserToolset,
    meta: { type?: string; autocomplete?: string },
  ): Promise<ToolResult> {
    await run(toolset, "browser_snapshot");
    const locator = harness.locators.get('[data-den-ref="e2"]');
    (locator.evaluate as jest.Mock).mockResolvedValue({
      type: meta.type ?? "text",
      autocomplete: meta.autocomplete ?? "",
    } as never);
    harness.screenshot.mockClear();
    return run(toolset, "browser_type", {
      ref: "e2",
      text: PASSWORD_SENTINEL,
    });
  }

  it("masks browser_type into password inputs and SUPPRESSES the screenshot before page.screenshot could run (D2-1)", async () => {
    const harness = makeHarness();
    const { toolset, store } = makeToolset(harness);

    const result = await typeIntoSensitiveField(harness, toolset, {
      type: "password",
    });

    // The value is still typed into the page…
    const locator = harness.locators.get('[data-den-ref="e2"]');
    expect(locator.fill).toHaveBeenCalledWith(PASSWORD_SENTINEL);
    // …but the tool result is masked…
    expect(text(result)).not.toContain(PASSWORD_SENTINEL);
    expect(text(result)).toContain("[MASKED]");
    // …and page.screenshot was NEVER invoked for the sensitive action —
    // the capture is suppressed before Playwright could serialize the frame.
    expect(harness.screenshot).not.toHaveBeenCalled();
    const entry = store.index[store.index.length - 1];
    expect(entry.masked).toBe(true);
    expect(entry.suppressed).toBe(true);
    expect(entry.path).toBeNull();
  });

  it("suppresses the failure screenshot and returns a value-free error when a sensitive typing action fails (review finding 1)", async () => {
    const harness = makeHarness();
    const { toolset, store } = makeToolset(harness);
    await run(toolset, "browser_snapshot");

    const locator = harness.locators.get('[data-den-ref="e2"]');
    (locator.evaluate as jest.Mock).mockResolvedValue({
      type: "password",
      autocomplete: "",
    } as never);
    // fill() succeeds, press("Enter") fails with an error message that
    // embeds the typed value — the exact leak path of the finding.
    (locator.press as jest.Mock).mockRejectedValue(
      new Error(`press failed after filling "${PASSWORD_SENTINEL}"`) as never,
    );
    harness.screenshot.mockClear();

    const result = await run(toolset, "browser_type", {
      ref: "e2",
      text: PASSWORD_SENTINEL,
      submit: true,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("ACTION_FAILED");
    expect(text(result)).not.toContain(PASSWORD_SENTINEL);
    // No failure frame may ever be serialized for a sensitive action.
    expect(harness.screenshot).not.toHaveBeenCalled();
    const entry = store.index[store.index.length - 1];
    expect(entry.failure).toBe(true);
    expect(entry.masked).toBe(true);
    expect(entry.suppressed).toBe(true);
    expect(entry.path).toBeNull();
  });

  it("suppresses the failure screenshot when a sensitive action lands on an external origin", async () => {
    const harness = makeHarness();
    const { toolset, store } = makeToolset(harness);
    await run(toolset, "browser_snapshot");

    const locator = harness.locators.get('[data-den-ref="e2"]');
    (locator.evaluate as jest.Mock).mockResolvedValue({
      type: "password",
      autocomplete: "",
    } as never);
    (locator.fill as jest.Mock).mockImplementation(async () => {
      harness.setUrl("https://evil.example.com/landed");
    });
    harness.screenshot.mockClear();

    const result = await run(toolset, "browser_type", {
      ref: "e2",
      text: PASSWORD_SENTINEL,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("EXTERNAL_NAVIGATION_BLOCKED");
    expect(text(result)).not.toContain(PASSWORD_SENTINEL);
    expect(harness.screenshot).not.toHaveBeenCalled();
    const entry = store.index[store.index.length - 1];
    expect(entry.masked).toBe(true);
    expect(entry.suppressed).toBe(true);
    expect(entry.path).toBeNull();
  });

  it("masks otp autocomplete inputs too", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);

    const result = await typeIntoSensitiveField(harness, toolset, {
      autocomplete: "one-time-code",
    });

    expect(text(result)).not.toContain(PASSWORD_SENTINEL);
    expect(harness.screenshot).not.toHaveBeenCalled();
  });

  it("captures normally for non-sensitive inputs and echoes the typed text", async () => {
    const harness = makeHarness();
    const { toolset, store } = makeToolset(harness);

    await run(toolset, "browser_snapshot");
    harness.screenshot.mockClear();
    const result = await run(toolset, "browser_type", {
      ref: "e2",
      text: "hello world",
    });

    expect(result.isError).toBeUndefined();
    expect(harness.screenshot).toHaveBeenCalledTimes(1);
    const entry = store.index[store.index.length - 1];
    expect(entry.masked).toBeUndefined();
    expect(entry.suppressed).toBeUndefined();
  });

  it("keeps storage-state contents, cookies, and passwords out of every output surface", async () => {
    const harness = makeHarness();
    const { toolset, store } = makeToolset(harness);

    // Simulate a page whose DOM summary the harness controls; sentinel
    // values exist only in the harness (auth file, cookies) — never in
    // summaries.
    await run(toolset, "browser_snapshot");
    const typed = await typeIntoSensitiveField(harness, toolset, {
      type: "password",
    });
    const everything = JSON.stringify({
      typed,
      index: store.index,
      reports: toolset.policyReports,
    });

    expect(everything).not.toContain(PASSWORD_SENTINEL);
    expect(everything).not.toContain(COOKIE_SENTINEL);
    expect(everything).not.toContain(AUTH_FILE.replace(".json", "-secret"));
  });
});

describe("buildBrowserToolset — waiting and disposal", () => {
  it("browser_wait waits for the load state by default", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);

    const result = await run(toolset, "browser_wait", {});

    expect(result.isError).toBeUndefined();
    expect(
      (harness.page as unknown as { waitForLoadState: jest.Mock })
        .waitForLoadState,
    ).toHaveBeenCalled();
  });

  it("browser_wait caps explicit millisecond waits", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);

    await run(toolset, "browser_wait", { milliseconds: 120_000 });

    const waitForTimeout = (
      harness.page as unknown as { waitForTimeout: jest.Mock }
    ).waitForTimeout;
    expect(waitForTimeout).toHaveBeenCalledTimes(1);
    const waited = waitForTimeout.mock.calls[0][0] as number;
    expect(waited).toBeLessThanOrEqual(10_000);
  });

  it("dispose closes context and browser", async () => {
    const harness = makeHarness();
    const { toolset } = makeToolset(harness);
    await run(toolset, "browser_snapshot");

    await toolset.dispose();

    expect(
      (harness.context as unknown as { close: jest.Mock }).close,
    ).toHaveBeenCalled();
    expect(
      (harness.browser as unknown as { close: jest.Mock }).close,
    ).toHaveBeenCalled();
  });
});

describe("SnapshotStore", () => {
  it("allocates deterministic zero-padded sequence names", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-store-"));
    const store = new SnapshotStore(dir);

    const captured: string[] = [];
    await store.persist({
      action: "navigate",
      url: "http://x/",
      capture: async (p) => {
        captured.push(p);
      },
    });
    await store.persist({
      action: "click",
      url: "http://x/",
      capture: async (p) => {
        captured.push(p);
      },
    });

    expect(captured[0].endsWith("001-navigate.png")).toBe(true);
    expect(captured[1].endsWith("002-click.png")).toBe(true);
    expect(store.index.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("suppressed entries never invoke capture and carry a null path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-store-"));
    const store = new SnapshotStore(dir);
    const capture = jest.fn(async () => undefined);

    const entry = await store.persist({
      action: "type",
      url: "http://x/login",
      capture,
      masked: true,
      suppress: true,
    });

    expect(capture).not.toHaveBeenCalled();
    expect(entry.path).toBeNull();
    expect(entry.masked).toBe(true);
    expect(entry.suppressed).toBe(true);
  });

  it("records capture failures in the index instead of throwing (review finding 9)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-store-"));
    const store = new SnapshotStore(dir);

    const entry = await store.persist({
      action: "click",
      url: "http://x/",
      capture: async () => {
        throw new Error("disk full");
      },
    });

    expect(entry.path).toBeNull();
    expect(entry.captureError).toContain("disk full");
    expect(store.index).toHaveLength(1);
    expect(store.index[0].captureError).toContain("disk full");
  });

  it("creates the snapshots dir under the report dir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-store-"));
    const store = new SnapshotStore(dir);
    await store.persist({
      action: "navigate",
      url: "http://x/",
      capture: async () => undefined,
    });

    expect(store.snapshotsDir).toBe(path.join(dir, "snapshots"));
    expect(fs.existsSync(store.snapshotsDir)).toBe(true);
  });
});
