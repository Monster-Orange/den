/**
 * Journeys browser toolset — @cursor/sdk custom tools over a harness-side
 * Playwright chromium context created from a pre-minted storageState auth
 * file (see browser-session.ts). The agent gets text page summaries with
 * stable element refs; screenshots persist harness-side only (never sent
 * to the model).
 *
 * Result-size posture (cost control): only browser_snapshot and
 * browser_navigate return the FULL interactable-element dump (they (re)issue
 * refs). click/type/select/wait return a COMPACT result — URL + title + a
 * "call browser_snapshot for refs" hint — because returning the full page
 * snapshot after every action made context grow ~linearly per action and
 * dominated token cost (first staging run: 46 actions ≈ 3.2M tokens, agent
 * output only 6K). Refs stay valid until the next full snapshot.
 *
 * Security posture (plan: jrn-browser-tool packet, two critique rounds):
 * - Web-origin policy enforced after EVERY action: any top-level
 *   navigation off `baseUrls.web`'s origin — including click-driven
 *   redirects — is reverted (page.goBack) and reported as a structured
 *   tool error. Popups/new pages are closed immediately; downloads are
 *   denied. The page's own subresource/XHR traffic is deliberately never
 *   blocked (no route interception exists), so the app keeps working.
 * - Sensitive-input masking: browser_type into password/otp inputs is
 *   masked in tool results and SnapshotIndex metadata, and the action's
 *   screenshot is SUPPRESSED before page.screenshot() could serialize the
 *   frame (critique finding D2-1).
 * - context.on("response") feeds the shared ledger matcher under the
 *   data-minimization contract: method + sanitized path + status +
 *   extracted id + source tag only. Bodies are parsed transiently for id
 *   extraction and discarded; cookies and auth headers are never read —
 *   the ONLY header metadata the feed consults is content-type/
 *   content-length, to decide whether a body is safe to parse at all
 *   (review finding R2-2).
 * - Interception lifecycle is BOUNDED (review finding R2-2): non-JSON or
 *   oversized bodies are never parsed (an SSE stream's json() would pend
 *   until the stream closes), JSON reads race a hard timeout, and drain()
 *   caps its wait — every bound violation surfaces as an interception
 *   warning on the ledger, never a silent hang.
 */

import { chromium } from "@playwright/test";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import { rewriteWebApiUrl, type JourneysWebApiConfig } from "../app-config.js";
import { RunLedger, sanitizePath, type HttpMethod } from "./ledger.js";
import type { SnapshotStore } from "./snapshot-store.js";

import { product } from "../../../shared/product.js";
/** Agent-facing tool surface, in mount order. */
export const BROWSER_TOOL_NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_wait",
] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

// Upper bound for an explicit browser_wait; keeps a single tool call from
// consuming a meaningful share of the journey's wall-clock budget.
export const WAIT_CAP_MS = 10_000;

// Cap on elements returned per snapshot; bounds tool-result token cost on
// element-dense pages (tables, long lists).
const MAX_SNAPSHOT_ELEMENTS = 100;

// Hard bound on one interception handler's body read (review finding
// R2-2): a response body that cannot be read within this window (e.g. a
// stream that never closes) is abandoned and reported, never awaited
// indefinitely.
export const INTERCEPTION_BODY_TIMEOUT_MS = 5_000;

// Hard bound on drain(): the runner must never block on late network
// records longer than this — on expiry drain resolves and the gap is
// reported as an interception warning.
export const INTERCEPTION_DRAIN_TIMEOUT_MS = 10_000;

// Bodies with a declared content-length above this are never parsed; id
// extraction only needs small JSON creation payloads.
export const INTERCEPTION_MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** Race sentinel distinguishing a timeout from a settled body read. */
const TIMED_OUT: unique symbol = Symbol("timed-out");

const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

// ── Structural Playwright surface ───────────────────────────────────────────
// Minimal interfaces the toolset needs; the real Playwright chromium stack
// satisfies them, and unit tests provide plain-object stubs so no browser
// ever launches in CI.

export interface LocatorLike {
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  press(key: string): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  /** Serialized-script evaluation against the matched element. */
  evaluate(script: string): Promise<unknown>;
}

export interface DownloadLike {
  cancel(): Promise<void>;
}

export interface PageLike {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  goBack(): Promise<unknown>;
  /** Serialized-script evaluation in the page. */
  evaluate(script: string): Promise<unknown>;
  screenshot(options: { path: string }): Promise<unknown>;
  locator(selector: string): LocatorLike;
  waitForLoadState(state?: string): Promise<void>;
  waitForTimeout(milliseconds: number): Promise<void>;
  on(event: "download", handler: (download: DownloadLike) => unknown): unknown;
  close(): Promise<void>;
}

export interface ResponseLike {
  url(): string;
  status(): number;
  request(): { method(): string };
  /**
   * Response headers. The feed reads ONLY content-type/content-length
   * (parse-safety metadata) — cookies and auth headers stay untouched.
   */
  headers(): Record<string, string>;
  json(): Promise<unknown>;
}

export interface ContextLike {
  newPage(): Promise<PageLike>;
  on(event: "page", handler: (page: PageLike) => unknown): unknown;
  on(event: "response", handler: (response: ResponseLike) => unknown): unknown;
  close(): Promise<void>;
}

export interface BrowserLike {
  newContext(options?: {
    storageState?: string;
    acceptDownloads?: boolean;
  }): Promise<ContextLike>;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  launch(options?: { headless?: boolean }): Promise<BrowserLike>;
}

// ── Policy reporting ────────────────────────────────────────────────────────

export interface PolicyReport {
  kind: "external-navigation-blocked" | "popup-closed" | "download-denied";
  /** Sanitized detail (origin/path only — never credentials). */
  detail: string;
  ts: string;
}

// ── Options / result types ──────────────────────────────────────────────────

export interface BrowserToolsetEnv {
  baseUrls: {
    web: string;
    api: string;
    services: Record<string, string>;
  };
}

/** Interception lifecycle bounds (review finding R2-2); test override. */
export interface BrowserToolsetTimeouts {
  /** Body-read bound; defaults to INTERCEPTION_BODY_TIMEOUT_MS. */
  bodyMs?: number;
  /** drain() bound; defaults to INTERCEPTION_DRAIN_TIMEOUT_MS. */
  drainMs?: number;
}

export interface BrowserToolsetOptions {
  env: BrowserToolsetEnv;
  /** Pre-minted storageState path from provisionBrowserSession(). */
  authFilePath: string;
  snapshotStore: SnapshotStore;
  /** Ledger fed by network interception (source: browser). */
  ledger: RunLedger;
  /** Injectable launcher for unit tests; defaults to Playwright chromium. */
  launcher?: BrowserLauncher;
  /** Interception lifecycle bounds; production uses the defaults. */
  timeouts?: BrowserToolsetTimeouts;
  /**
   * API calls the app's browser code makes through the WEB origin (a
   * backend-for-frontend proxy), from `journeys.app.web_api`. Unset: only
   * direct API/service-origin calls feed the ledger.
   */
  webApi?: JourneysWebApiConfig;
}

export interface BrowserToolset {
  tools: Record<BrowserToolName, SDKCustomTool>;
  /** Launch + wire the browser stack (idempotent; tools call it lazily). */
  start(): Promise<void>;
  /**
   * Await every pending response-interception handler (review finding
   * 7): the runner drains BEFORE returning its RunOutcome so verify /
   * teardown always observe a complete ledger. Never rejects, and never
   * waits past INTERCEPTION_DRAIN_TIMEOUT_MS — on expiry it records an
   * interception warning instead (review finding R2-2).
   */
  drain(): Promise<void>;
  /** Close page/context/browser; safe to call multiple times. */
  dispose(): Promise<void>;
  /** Origin-policy enforcement events, in occurrence order. */
  readonly policyReports: readonly PolicyReport[];
}

export type BrowserToolErrorCode =
  | "INVALID_ARGS"
  | "UNKNOWN_REF"
  | "EXTERNAL_NAVIGATION_BLOCKED"
  | "ACTION_FAILED";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface PageElementSummary {
  ref: string;
  role: string;
  name: string;
}

// ── Page scripts (serialized strings — the repo's TS config has no DOM lib,
// and these run inside the browser, not in Node) ────────────────────────────

const SNAPSHOT_SCRIPT = `(() => {
  const selector = 'a[href], button, input, select, textarea, ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
    '[contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(selector));
  const visible = nodes.filter((el) =>
    !el.disabled && el.getClientRects().length > 0);
  return visible.slice(0, ${MAX_SNAPSHOT_ELEMENTS}).map((el, i) => {
    const ref = "e" + (i + 1);
    el.setAttribute("data-${product().cli}-ref", ref);
    const name = (el.getAttribute("aria-label") || el.textContent ||
      el.getAttribute("placeholder") || el.getAttribute("name") || "")
      .trim().slice(0, 80);
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    return { ref, role, name };
  });
})()`;

const SENSITIVITY_SCRIPT = `((el) => ({
  type: (el.getAttribute("type") || "").toLowerCase(),
  autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(),
}))`;

function isSensitiveInput(meta: {
  type: string;
  autocomplete: string;
}): boolean {
  if (meta.type === "password") return true;
  return /password|one-time-code|otp/.test(meta.autocomplete);
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(code: BrowserToolErrorCode, message: string): ToolResult {
  return {
    content: [{ type: "text", text: `ERROR ${code}: ${message}` }],
    isError: true,
  };
}

/**
 * Build the browser custom toolset. Mount `tools` in
 * `Agent.create({local: {customTools}})`; call `dispose()` in the runner's
 * finally block.
 */
export function buildBrowserToolset(
  options: BrowserToolsetOptions,
): BrowserToolset {
  const { env, authFilePath, snapshotStore, ledger, webApi } = options;
  // The Playwright chromium object satisfies BrowserLauncher structurally,
  // but its event-overload signatures don't line up with the minimal
  // interfaces above, so the default goes through a cast.
  const launcher: BrowserLauncher =
    options.launcher ?? (chromium as unknown as BrowserLauncher);

  const webOrigin = new URL(env.baseUrls.web).origin;
  const apiOrigins = new Set(
    [env.baseUrls.api, ...Object.values(env.baseUrls.services)].map(
      (base) => new URL(base).origin,
    ),
  );

  const policyReports: PolicyReport[] = [];
  let browser: BrowserLike | undefined;
  let context: ContextLike | undefined;
  let page: PageLike | undefined;
  /** Refs issued by the most recent snapshot generation. */
  let knownRefs = new Set<string>();

  function report(kind: PolicyReport["kind"], detail: string): void {
    policyReports.push({ kind, detail, ts: new Date().toISOString() });
  }

  /** Pending interception-handler promises, drained by the runner. */
  const pendingInterceptions = new Set<Promise<void>>();

  const bodyTimeoutMs =
    options.timeouts?.bodyMs ?? INTERCEPTION_BODY_TIMEOUT_MS;
  const drainTimeoutMs =
    options.timeouts?.drainMs ?? INTERCEPTION_DRAIN_TIMEOUT_MS;

  /**
   * Bounded body read (review finding R2-2): parse ONLY when the
   * content-type/content-length metadata says it is safe (small JSON —
   * an SSE stream's json() pends until the stream closes), and even then
   * race the read against a hard timeout. Timeouts surface as
   * interception warnings; the abandoned read's settlement is observed so
   * it can never unhandled-reject later.
   */
  async function readBodyBounded(
    response: ResponseLike,
    method: string,
  ): Promise<unknown> {
    const headers = response.headers();
    const contentType = (headers["content-type"] ?? "").toLowerCase();
    if (!contentType.includes("application/json")) {
      return undefined;
    }
    const contentLength = Number(headers["content-length"] ?? Number.NaN);
    if (
      Number.isFinite(contentLength) &&
      contentLength > INTERCEPTION_MAX_BODY_BYTES
    ) {
      return undefined;
    }

    // json() rejections (malformed JSON) keep the pre-existing degrade
    // path: body undefined → unmanaged-mutation warning via the matcher.
    const read = response.json().catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), bodyTimeoutMs);
    });
    try {
      const result = await Promise.race([read, cap]);
      if (result === TIMED_OUT) {
        ledger.recordInterceptionError(
          `interception body read timed out after ${bodyTimeoutMs}ms: ` +
            `${method} ${sanitizePath(response.url())} — recorded without a body`,
        );
        return undefined;
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Data-minimized interception feed: only method + URL (sanitized inside
   * the ledger) + status + transiently-parsed body ever leave the response
   * object; cookies and auth headers are never read (content-type/
   * content-length only — see readBodyBounded).
   *
   * Handlers are TRACKED (review finding 7): the toolset's drain() hook
   * awaits every pending handler so verify/teardown never race a
   * creation that hasn't been recorded yet, and processing failures are
   * surfaced as ledger warnings — never swallowed silently.
   */
  async function onResponse(response: ResponseLike): Promise<void> {
    try {
      const method = response.request().method().toUpperCase();
      if (!MUTATING_METHODS.has(method)) return;
      const url = new URL(response.url());
      // Record mutations on (a) a direct API/service origin, OR (b) the web
      // origin under the app's declared web_api prefix. An app whose browser
      // code calls the API through its own web origin (a backend-for-frontend
      // proxy) never hits an API origin directly, so watching only API
      // origins would leave the ledger empty and every `{<type>_id}`
      // unbound. The ledger's own path patterns still gate what records.
      const onApiOrigin = apiOrigins.has(url.origin);
      const onWebApiPath =
        webApi !== undefined &&
        url.origin === webOrigin &&
        url.pathname.startsWith(webApi.prefix);
      if (!onApiOrigin && !onWebApiPath) return;

      // Declared ignore prefixes (login/session routes on the web origin)
      // are never a tracked resource mutation — skip them so they neither
      // bind nor raise an unmanaged warning on every browser journey.
      if (
        onWebApiPath &&
        (webApi.ignore ?? []).some((prefix) => url.pathname.startsWith(prefix))
      ) {
        return;
      }

      // A web-origin call may speak a different path vocabulary than the
      // API; the declared rewrites map it onto the API paths the ledger
      // descriptors and verifier probes use. Direct API-origin calls pass
      // through untouched.
      const pathOrUrl = onWebApiPath
        ? rewriteWebApiUrl(response.url(), webApi)
        : response.url();

      const body = await readBodyBounded(response, method);
      ledger.record(
        {
          method: method as HttpMethod,
          pathOrUrl,
          status: response.status(),
          body,
        },
        "browser",
      );
    } catch (error) {
      // Interception must never break the page or the journey — but a
      // processing failure means a possible untracked creation, so it
      // lands in the ledger as a warning for the report.
      ledger.recordInterceptionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function trackInterception(response: ResponseLike): Promise<void> {
    const pending = onResponse(response).finally(() => {
      pendingInterceptions.delete(pending);
    });
    pendingInterceptions.add(pending);
    return pending;
  }

  /**
   * Bounded drain (review finding R2-2): waits for pending handlers but
   * never longer than drainTimeoutMs — on expiry it resolves and records
   * an interception warning (late records may be missing from the
   * ledger). Never rejects; called on both normal and failure paths.
   */
  async function drain(): Promise<void> {
    if (pendingInterceptions.size === 0) return;
    // Handlers never reject (onResponse catches everything), so the
    // settle loop below can only resolve or stay pending.
    const settleAll = (async () => {
      // New handlers can be registered while awaiting (late responses),
      // so loop until the pending set is observed empty.
      while (pendingInterceptions.size > 0) {
        await Promise.all([...pendingInterceptions]);
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), drainTimeoutMs);
    });
    try {
      const result = await Promise.race([settleAll, cap]);
      if (result === TIMED_OUT) {
        ledger.recordInterceptionError(
          `interception drain timed out after ${drainTimeoutMs}ms — late ` +
            "network records may be missing from the ledger",
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function ensureStarted(): Promise<void> {
    if (page) return;
    browser = await launcher.launch({ headless: true });
    context = await browser.newContext({
      storageState: authFilePath,
      acceptDownloads: false,
    });
    context.on("response", (response: ResponseLike) =>
      trackInterception(response),
    );

    page = await context.newPage();
    page.on("download", async (download: DownloadLike) => {
      try {
        await download.cancel();
      } catch {
        // Best effort — acceptDownloads: false already denies persistence.
      }
      report("download-denied", "download attempt cancelled");
    });

    // Registered AFTER the main page exists so this only ever sees popups
    // and window.open targets — those are closed on sight.
    context.on("page", async (extra: PageLike) => {
      try {
        await extra.close();
      } catch {
        // Page may already be closed.
      }
      report("popup-closed", "new page/popup closed by policy");
    });

    // new URL(...) normalizes the configured base (adds the trailing slash)
    // so page.url() comparisons stay canonical.
    await page.goto(new URL(env.baseUrls.web).toString(), {
      waitUntil: "domcontentloaded",
    });
  }

  function requirePage(): PageLike {
    if (!page) throw new Error("browser toolset not started");
    return page;
  }

  /**
   * Full page snapshot: URL, title, and every interactable element with its
   * ref. This is the ONLY result that (re)issues refs — knownRefs is reset
   * here, so refs are valid until the next full snapshot. Returned by
   * browser_snapshot and browser_navigate (a fresh page always needs refs).
   */
  async function buildSummary(): Promise<string> {
    const current = requirePage();
    const elements = (await current.evaluate(
      SNAPSHOT_SCRIPT,
    )) as PageElementSummary[];
    knownRefs = new Set(elements.map((element) => element.ref));
    const title = await current.title();
    const lines = [
      `URL: ${current.url()}`,
      `Title: ${title}`,
      "Interactable elements:",
      ...elements.map(
        (element) => `  [${element.ref}] ${element.role} "${element.name}"`,
      ),
    ];
    return lines.join("\n");
  }

  /**
   * Compact post-action result: URL + title only, no element dump. Returned
   * by click/type/select/wait so the agent's context does not accumulate a
   * full ~900-token page snapshot after EVERY action (the dominant cost on
   * the first staging run: 46 actions × full snapshot ≈ 3.2M tokens, output
   * only 6K). The agent takes browser_snapshot when it needs fresh refs;
   * knownRefs is deliberately NOT reset here, so refs from the last full
   * snapshot stay valid across intervening actions.
   */
  async function buildCompactSummary(): Promise<string> {
    const current = requirePage();
    const title = await current.title();
    return [
      `URL: ${current.url()}`,
      `Title: ${title}`,
      "(page changed — call browser_snapshot for fresh element refs)",
    ].join("\n");
  }

  async function captureSnapshot(
    action: string,
    flags: { failure?: boolean; masked?: boolean; suppress?: boolean } = {},
  ): Promise<void> {
    const current = requirePage();
    try {
      await snapshotStore.persist({
        action,
        url: current.url(),
        capture: (filePath) =>
          current.screenshot({ path: filePath }).then(() => undefined),
        ...flags,
      });
    } catch {
      // persist() records capture failures itself (finding 9); this is a
      // last resort so an unexpected store error cannot fail the action.
    }
  }

  /**
   * Shared action pipeline: run the action, then (in order) enforce the
   * post-action origin policy, persist the deterministic screenshot
   * (suppressed for masked actions — BEFORE any capture could happen), and
   * return the fresh page summary.
   */
  async function performAction(
    action: string,
    act: () => Promise<void>,
    flags: {
      masked?: boolean;
      resultPrefix?: string;
      /** Return the full element dump (snapshot/navigate) vs a compact
       * URL+title line (click/type/select/wait). Default: compact. */
      full?: boolean;
    } = {},
  ): Promise<ToolResult> {
    await ensureStarted();
    const current = requirePage();

    try {
      await act();
    } catch (error) {
      // Masking propagates into the FAILURE path too: a sensitive action's
      // failure frame is suppressed pre-capture, and the raw driver error —
      // which can embed the typed value (e.g. a fill/press failure message)
      // — is replaced with a value-free message.
      await captureSnapshot(action, {
        failure: true,
        masked: flags.masked,
        suppress: flags.masked,
      });
      if (flags.masked) {
        return errorResult(
          "ACTION_FAILED",
          `${action} failed on a sensitive input; error details suppressed ` +
            "to avoid leaking the typed value.",
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResult("ACTION_FAILED", `${action} failed: ${message}`);
    }

    const landedOrigin = new URL(current.url()).origin;
    if (landedOrigin !== webOrigin) {
      report("external-navigation-blocked", landedOrigin);
      try {
        await current.goBack();
      } catch {
        // If we cannot navigate back the structured error still surfaces.
      }
      await captureSnapshot(action, {
        failure: true,
        masked: flags.masked,
        suppress: flags.masked,
      });
      return errorResult(
        "EXTERNAL_NAVIGATION_BLOCKED",
        `Action navigated to external origin ${landedOrigin}; navigation ` +
          "was reverted. Journeys may only travel the app under test.",
      );
    }

    await captureSnapshot(action, {
      masked: flags.masked,
      suppress: flags.masked,
    });

    const summary = flags.full
      ? await buildSummary()
      : await buildCompactSummary();
    return textResult(
      flags.resultPrefix ? `${flags.resultPrefix}\n${summary}` : summary,
    );
  }

  function refFromArgs(
    args: Record<string, SDKJsonValue>,
  ): string | ToolResult {
    const ref = typeof args.ref === "string" ? args.ref : "";
    if (ref.length === 0) {
      return errorResult("INVALID_ARGS", "ref is required.");
    }
    if (!knownRefs.has(ref)) {
      return errorResult(
        "UNKNOWN_REF",
        `Ref "${ref}" was not issued by the latest snapshot. Take a fresh ` +
          "browser_snapshot and use its refs.",
      );
    }
    return ref;
  }

  function locatorFor(ref: string): LocatorLike {
    return requirePage().locator(`[data-${product().cli}-ref="${ref}"]`);
  }

  const refProperty = {
    ref: {
      type: "string",
      description: "Element ref from the latest page snapshot (e.g. e3)",
    },
  } as const;

  const tools: Record<BrowserToolName, SDKCustomTool> = {
    browser_navigate: {
      description:
        "Navigate the browser to a path or URL on the app under test. " +
        "Only the app's own origin is reachable.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Path (e.g. /settings) or absolute app URL",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
      execute: async (args: Record<string, SDKJsonValue>) => {
        const raw = typeof args.url === "string" ? args.url : "";
        if (raw.length === 0) {
          return errorResult("INVALID_ARGS", "url is required.");
        }
        let target: URL;
        try {
          target = new URL(raw, env.baseUrls.web);
        } catch {
          return errorResult("INVALID_ARGS", `Malformed URL: ${raw}`);
        }
        if (target.origin !== webOrigin) {
          report("external-navigation-blocked", target.origin);
          return errorResult(
            "EXTERNAL_NAVIGATION_BLOCKED",
            `Origin ${target.origin} is outside the app under test ` +
              `(${webOrigin}); navigation refused.`,
          );
        }
        return performAction(
          "navigate",
          async () => {
            await requirePage().goto(target.toString(), {
              waitUntil: "domcontentloaded",
            });
          },
          // A fresh page: return the full element dump so the agent has refs.
          { full: true },
        );
      },
    },

    browser_snapshot: {
      description:
        "Take a fresh text snapshot of the current page: URL, title, and " +
        "interactable elements with refs for use in other browser tools.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        // The explicit "give me refs" tool → always the full element dump.
        return performAction("snapshot", async () => undefined, {
          full: true,
        });
      },
    },

    browser_click: {
      description: "Click an element identified by its snapshot ref.",
      inputSchema: {
        type: "object",
        properties: { ...refProperty },
        required: ["ref"],
        additionalProperties: false,
      },
      execute: async (args: Record<string, SDKJsonValue>) => {
        await ensureStarted();
        const ref = refFromArgs(args);
        if (typeof ref !== "string") return ref;
        return performAction("click", () => locatorFor(ref).click());
      },
    },

    browser_type: {
      description:
        "Type text into an input identified by its snapshot ref. Values " +
        "typed into password/OTP fields are masked in results.",
      inputSchema: {
        type: "object",
        properties: {
          ...refProperty,
          text: { type: "string", description: "Text to type" },
          submit: {
            type: "boolean",
            description: "Press Enter after typing",
          },
        },
        required: ["ref", "text"],
        additionalProperties: false,
      },
      execute: async (args: Record<string, SDKJsonValue>) => {
        await ensureStarted();
        const ref = refFromArgs(args);
        if (typeof ref !== "string") return ref;
        const value = typeof args.text === "string" ? args.text : "";
        const locator = locatorFor(ref);

        // Sensitivity is decided BEFORE acting so masking/suppression
        // covers the tool result, the SnapshotIndex entry, AND the
        // screenshot pipeline (which is suppressed pre-capture).
        let sensitive = false;
        try {
          const meta = (await locator.evaluate(SENSITIVITY_SCRIPT)) as {
            type?: string;
            autocomplete?: string;
          };
          sensitive = isSensitiveInput({
            type: (meta.type ?? "").toLowerCase(),
            autocomplete: (meta.autocomplete ?? "").toLowerCase(),
          });
        } catch {
          // Unknown metadata — fail toward masking rather than leaking.
          sensitive = true;
        }

        return performAction(
          "type",
          async () => {
            await locator.fill(value);
            if (args.submit === true) {
              await locator.press("Enter");
            }
          },
          {
            masked: sensitive,
            resultPrefix: sensitive
              ? `Typed [MASKED] into [${ref}]`
              : `Typed ${JSON.stringify(value)} into [${ref}]`,
          },
        );
      },
    },

    browser_select: {
      description:
        "Select an option (by value or label) in a select element " +
        "identified by its snapshot ref.",
      inputSchema: {
        type: "object",
        properties: {
          ...refProperty,
          value: { type: "string", description: "Option value or label" },
        },
        required: ["ref", "value"],
        additionalProperties: false,
      },
      execute: async (args: Record<string, SDKJsonValue>) => {
        await ensureStarted();
        const ref = refFromArgs(args);
        if (typeof ref !== "string") return ref;
        const value = typeof args.value === "string" ? args.value : "";
        return performAction("select", async () => {
          await locatorFor(ref).selectOption(value);
        });
      },
    },

    browser_wait: {
      description:
        "Wait for the page to settle (default: load state) or for an " +
        `explicit duration (capped at ${WAIT_CAP_MS} ms).`,
      inputSchema: {
        type: "object",
        properties: {
          milliseconds: {
            type: "number",
            description: `Explicit wait in ms (capped at ${WAIT_CAP_MS})`,
          },
        },
        additionalProperties: false,
      },
      execute: async (args: Record<string, SDKJsonValue>) => {
        return performAction("wait", async () => {
          const current = requirePage();
          if (typeof args.milliseconds === "number") {
            await current.waitForTimeout(
              Math.min(Math.max(args.milliseconds, 0), WAIT_CAP_MS),
            );
          } else {
            await current.waitForLoadState("load");
          }
        });
      },
    },
  };

  return {
    tools,
    start: ensureStarted,
    drain,
    dispose: async () => {
      const closingPage = page;
      const closingContext = context;
      const closingBrowser = browser;
      page = undefined;
      context = undefined;
      browser = undefined;
      try {
        await closingPage?.close();
      } catch {
        // Already closed.
      }
      try {
        await closingContext?.close();
      } catch {
        // Already closed.
      }
      try {
        await closingBrowser?.close();
      } catch {
        // Already closed.
      }
    },
    get policyReports(): readonly PolicyReport[] {
      return policyReports;
    },
  };
}
