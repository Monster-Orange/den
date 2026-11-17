/**
 * Issue 339: in a browser, Settings › Agents › Keep agents running after
 * logout › the sign-in accounts. A person adds an account to Claude Code
 * (Sign-in B), sets its token in the same hidden field as today, and moves
 * it first. The token goes to its own item in the install's secrets store
 * (Doppler here, its CLI a shim that keeps what it gets on stdin in the
 * server's temp dir, per key), never account one's; the order stays after
 * a reload; the token is in no response, the page or the server's log.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented values.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

jest.setTimeout(60_000);

const TOKEN = "fake-account-b-browser-0123456789abcdef";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({
    userYml: "secrets:\n  provider: doppler\n",
    scripts: {
      doppler: [
        'if [ "$1" = "--version" ]; then echo "v3.0.0"; exit 0; fi',
        'mkdir -p "$TMP/kept"',
        'if [ "$1" = secrets ] && [ "$2" = set ]; then cat > "$TMP/kept/$3"; exit 0; fi',
        'if [ "$1" = secrets ] && [ "$2" = get ]; then [ -s "$TMP/kept/$3" ] && cat "$TMP/kept/$3" && exit 0; exit 1; fi',
        "exit 1",
      ].join("\n"),
    },
  });
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;

describe("issue 339: Settings › sign-in accounts", () => {
  it("Add account, Set sign-in token, Move up: its own item, the order kept, the token never shown", async () => {
    if (skip()) return;
    const ctx = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const st = document.createElement("style");
        st.textContent = "#cl-overlay{display:none!important}";
        document.head.appendChild(st);
      });
    });
    const bodies: string[] = [];
    p.on("response", async (r) => {
      try {
        bodies.push(await r.text());
      } catch {
        /* no body */
      }
    });
    await p.goto(signInUrl(s!.stateDir, s!.base, "/settings#agents"));
    const vendor = p.locator('[data-acct-runtime="den-claude"]');
    await vendor.waitFor({ state: "attached" });
    // One account, as today: today's field, and Add account.
    expect(await vendor.locator("[data-acct]").count()).toBe(0);
    await vendor.locator("[data-acct-add]").click();
    const b = vendor.locator('[data-acct="2"]');
    await b.waitFor();
    expect(await vendor.locator("[data-acct]").count()).toBe(2);
    expect(await b.textContent()).toContain("Sign-in B");
    expect(await b.getAttribute("data-acct-state")).toBe("missing");
    // Today's single field steps aside: each account has its own.
    expect(await p.locator("[data-keep-token-input]").isVisible()).toBe(false);
    const input = b.locator("[data-acct-token]");
    expect(await input.getAttribute("type")).toBe("password");
    await input.fill(TOKEN);
    await b.locator("[data-acct-save]").click();
    await p.waitForSelector('[data-acct="2"][data-acct-state="set"]');
    expect(await input.inputValue()).toBe("");
    // Its own item: the one key in the store is account 2's.
    const kept = fs.readdirSync(path.join(s!.tmp, "kept"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/AGENT_SIGNIN_TOKEN_DEN_CLAUDE_2$/);
    expect(fs.readFileSync(path.join(s!.tmp, "kept", kept[0]!), "utf-8")).toBe(
      TOKEN,
    );
    // Move it first: kept after a reload.
    await b.locator("[data-acct-up]").click();
    await p.waitForFunction(
      () =>
        document
          .querySelector('[data-acct-runtime="den-claude"] [data-acct]')
          ?.getAttribute("data-acct") === "2",
    );
    await p.reload();
    await p.waitForSelector('[data-acct-runtime="den-claude"] [data-acct]', {
      state: "attached",
    });
    expect(
      await p
        .locator('[data-acct-runtime="den-claude"] [data-acct]')
        .first()
        .getAttribute("data-acct"),
    ).toBe("2");
    // Never shown back.
    for (const x of bodies) expect(x).not.toContain(TOKEN);
    expect(await p.content()).not.toContain(TOKEN);
    expect(JSON.stringify(await s!.settingsGet())).not.toContain(TOKEN);
    expect(s!.log()).not.toContain(TOKEN);
    await ctx.close();
  });
});
