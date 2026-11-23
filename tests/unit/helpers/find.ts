/**
 * Issue 841: how a browser test finds an element and waits for the page,
 * in Chromium and WebKit alike.
 *
 * - Find by what a person sees: `byRole(page, "button", "Save")` (its role
 *   and accessible name) or `byLabel(page, "Project name")`, both matched
 *   exactly. Never a class selector or a position (`.nth`, `:nth-child`):
 *   those break on a restyle (the brittle-pattern ratchet counts them).
 * - Wait for a named state, never a fixed sleep: `waitFor(page, { dialog:
 *   "Delete project" })`, `{ dialogClosed }`, `{ row }`. A wait ends as soon
 *   as the state holds; one that runs out says which state, how long, and
 *   Playwright's reason.
 * - A request settled: `settled(page, "/api/agents", () => button.click(),
 *   { method: "POST" })` arms the wait before the action, so a fast response
 *   is never missed; the path is exact and the method keeps a background
 *   poll from settling it.
 *
 * Timeouts default to the suite's wait (browserWaitMs: DEN_BROWSER_WAIT_MS,
 * 20 s unset), which allows for a remote browser's round trips.
 */
import type { Locator, Page } from "playwright";
import { browserWaitMs } from "./browser.js";

/** What these helpers use of a Playwright Locator. */
export interface FindLocator {
  waitFor(opts: {
    state: "visible" | "hidden" | "attached" | "detached";
    timeout: number;
  }): Promise<void>;
}

/** What settled uses of a Playwright Response. */
export interface FindResponse {
  url(): string;
  request(): { method(): string };
}

/** What these helpers use of a Playwright Page (a Page satisfies it). */
export interface FindPage {
  getByRole(
    role: string,
    opts: { name: string | RegExp; exact: boolean },
  ): FindLocator;
  getByLabel(label: string | RegExp, opts: { exact: boolean }): FindLocator;
  waitForResponse(
    match: (r: FindResponse) => boolean,
    opts: { timeout: number },
  ): Promise<FindResponse>;
}

/** An element by its role and accessible name, matched exactly. */
export function byRole(
  page: Page,
  role: Parameters<Page["getByRole"]>[0],
  name: string | RegExp,
): Locator;
export function byRole(
  page: FindPage,
  role: string,
  name: string | RegExp,
): FindLocator;
export function byRole(
  page: FindPage,
  role: string,
  name: string | RegExp,
): FindLocator {
  return page.getByRole(role, { name, exact: true });
}

/** A form control by its label, matched exactly. */
export function byLabel(page: Page, label: string | RegExp): Locator;
export function byLabel(page: FindPage, label: string | RegExp): FindLocator;
export function byLabel(page: FindPage, label: string | RegExp): FindLocator {
  return page.getByLabel(label, { exact: true });
}

/** A page state a test waits for, by what a person sees. */
export type PageState =
  | { dialog: string | RegExp }
  | { dialogClosed: string | RegExp }
  | { row: string | RegExp };

const shown = (n: string | RegExp) =>
  typeof n === "string" ? JSON.stringify(n) : String(n);

/** A state in words, for a failure message. */
export function describeState(s: PageState): string {
  if ("dialog" in s) return `the dialog ${shown(s.dialog)} to open`;
  if ("dialogClosed" in s)
    return `the dialog ${shown(s.dialogClosed)} to close`;
  return `a row ${shown(s.row)}`;
}

/**
 * Waits until `state` holds, up to `timeout` ms (the suite's wait unset).
 * Throws naming the state, the time and the reason when it runs out.
 */
export async function waitFor(
  page: FindPage,
  state: PageState,
  opts: { timeout?: number } = {},
): Promise<void> {
  const timeout = opts.timeout ?? browserWaitMs();
  const [locator, want] =
    "dialog" in state
      ? [byRole(page, "dialog", state.dialog), "visible" as const]
      : "dialogClosed" in state
        ? [byRole(page, "dialog", state.dialogClosed), "hidden" as const]
        : [byRole(page, "row", state.row), "visible" as const];
  try {
    await locator.waitFor({ state: want, timeout });
  } catch (e) {
    throw new Error(
      `waited ${timeout} ms for ${describeState(state)}: ${firstLine(e)}`,
    );
  }
}

/**
 * Runs `action` and waits for the first response to it, armed before the
 * action. A string is the exact path (`/api/agents` never matches
 * `/api/agents/stale`, and the query is ignored); a RegExp is tested against
 * the whole URL, for anything looser. `method` ("POST", any case) keeps a
 * background poll to the same path from settling it. Returns the response.
 */
export async function settled<R extends FindResponse = FindResponse>(
  page: FindPage,
  url: string | RegExp,
  action: () => Promise<unknown>,
  opts: { timeout?: number; method?: string } = {},
): Promise<R> {
  const timeout = opts.timeout ?? browserWaitMs();
  const method = opts.method?.toUpperCase();
  const match = (r: FindResponse) => {
    if (method && r.request().method().toUpperCase() !== method) return false;
    if (typeof url !== "string") return url.test(r.url());
    try {
      return new URL(r.url()).pathname === url;
    } catch {
      return false;
    }
  };
  const waiting = page.waitForResponse(match, { timeout });
  // Never an unhandled rejection while the action runs.
  waiting.catch(() => undefined);
  await action();
  try {
    return (await waiting) as R;
  } catch (e) {
    throw new Error(
      `waited ${timeout} ms for a ${method ? `${method} ` : ""}response from ${String(url)}: ${firstLine(e)}`,
    );
  }
}

function firstLine(e: unknown): string {
  return String((e as Error)?.message ?? e).split("\n")[0];
}
