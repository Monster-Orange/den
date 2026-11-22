/**
 * Issue 399: Settings › Agents › Keep agents running after logout never
 * says "make one with claude setup-token, then <cli> agents token set".
 * With no token (or an old one), its line says where the token comes from
 * in plain words, links the vendor's sign-in docs (the runtime catalog's
 * signIn.docs, as the server sends it), and "Sign-in token" in "paste it
 * into Sign-in token below" focuses that field.
 *
 * The row is shown on, under the always-on service, by the page's own
 * GET /api/settings answer with keep_running_after_logout and the
 * agent_signin mode changed; everything else is the server's. Chromium
 * and WebKit; DEN_PW_WS connects to a Playwright server instead of
 * launching. The demo distribution (helpers/agents-page-server.ts).
 * Invented values only.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { builtinEntry } from "../../../src/shared/agents/catalog.js";
import { launchBrowser } from "../helpers/browser.js";

jest.setTimeout(60_000);

const ENGINES = ["chromium", "webkit"] as const;
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};
let s: AgentsPageServer | null = null;
const DOCS = builtinEntry("den-claude")!.signIn!.docs!;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES) browsers[e] = await launchBrowser(pw[e]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({
    userYml: "secrets:\n  provider: doppler\n",
    scripts: {
      doppler: [
        'if [ "$1" = "--version" ]; then echo "v3.0.0"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    },
  });
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

/** Settings, the row on, with this sign-in state over the server's. */
async function open(
  e: (typeof ENGINES)[number],
  signin: Record<string, unknown>,
  accounts?: unknown[],
): Promise<Page> {
  const ctx = await browsers[e]!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
    } catch {
      /* none */
    }
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const p = await ctx.newPage();
  await p.route("**/api/settings", async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    const res = await r.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    body.keep_running_after_logout = true;
    body.agent_signin = {
      ...(body.agent_signin as Record<string, unknown>),
      ...signin,
    };
    if (accounts) body.agent_accounts = accounts;
    await r.fulfill({ response: res, json: body });
  });
  await signInPage(p, s!.stateDir, s!.base, "/settings#agents");
  await p.waitForSelector("[data-keep-token-go]", { timeout: 20_000 });
  return p;
}

describe.each(ENGINES)("issue 399 in %s: the sign-in token line", (e) => {
  it.each([
    ["no token", { configured: false, mode: "token" }, "missing"],
    [
      "an old one",
      { configured: true, old: true, age_days: 340, mode: "token" },
      "old",
    ],
  ] as const)(
    "%s: plain words, the vendor's docs, and Sign-in token focuses the field",
    async (_name, signin, state) => {
      if (!browsers[e] || !s) return;
      const p = await open(e, signin);
      const line = p.locator(`[data-keep-token="${state}"]`);
      const says = (await line.textContent()) ?? "";
      expect(says).not.toMatch(/setup-token|agents token set|\bthen\b/);
      expect(says).toContain(
        `Claude Code makes ${state === "old" ? "a new one" : "one"} when you sign in to it (its sign-in docs); paste it into Sign-in token below.`,
      );
      // The catalog's page, as the server sent it.
      const docs = line.locator("a[data-keep-token-docs]");
      expect(await docs.getAttribute("href")).toBe(DOCS);
      expect(await docs.getAttribute("target")).toBe("_blank");
      // The description says it in plain words too.
      const row = (await p.locator("body").textContent()) ?? "";
      expect(row).not.toMatch(/claude setup-token, then/);

      const input = p.locator("[data-keep-token-input]");
      expect(await input.evaluate((el) => document.activeElement === el)).toBe(
        false,
      );
      const before = p.url();
      await line.locator("[data-keep-token-go]").click();
      await p.waitForFunction(
        () =>
          document.activeElement?.matches?.("[data-keep-token-input]") === true,
        undefined,
        { timeout: 5000 },
      );
      // A link to the field, not a page change.
      expect(p.url()).toBe(before);
      await p.context().close();
    },
  );

  it("two Claude Code accounts (issue 339): Sign-in token focuses the first account's field", async () => {
    if (!browsers[e] || !s) return;
    const p = await open(e, { configured: false, mode: "token" }, [
      {
        runtime: "den-claude",
        name: "Claude Code",
        account: "Claude",
        accounts: [
          { id: "a", letter: "A", configured: false, first: true },
          { id: "b", letter: "B", configured: false },
        ],
      },
    ]);
    await p.locator('[data-acct="a"] [data-acct-token]').waitFor();
    await p.locator("[data-keep-token-go]").click();
    await p.waitForFunction(
      () =>
        document.activeElement?.closest?.('[data-acct="a"]') != null &&
        document.activeElement?.matches?.("[data-acct-token]") === true,
      undefined,
      { timeout: 5000 },
    );
    await p.context().close();
  });
});
