import type { Locator, Page } from "playwright";
import { browserWaitMs } from "./browser.js";

export interface FindLocator {
  waitFor(opts: {
    state: "visible" | "hidden" | "attached" | "detached";
    timeout: number;
  }): Promise<void>;
}

export interface FindResponse {
  url(): string;
  request(): { method(): string };
}

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

export function byLabel(page: Page, label: string | RegExp): Locator;
export function byLabel(page: FindPage, label: string | RegExp): FindLocator;
export function byLabel(page: FindPage, label: string | RegExp): FindLocator {
  return page.getByLabel(label, { exact: true });
}

export type PageState =
  | { dialog: string | RegExp }
  | { dialogClosed: string | RegExp }
  | { row: string | RegExp };

const shown = (n: string | RegExp) =>
  typeof n === "string" ? JSON.stringify(n) : String(n);

export function describeState(s: PageState): string {
  if ("dialog" in s) return `the dialog ${shown(s.dialog)} to open`;
  if ("dialogClosed" in s)
    return `the dialog ${shown(s.dialogClosed)} to close`;
  return `a row ${shown(s.row)}`;
}

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
