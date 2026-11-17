/**
 * #299 (inside #163): in a browser, Settings › Agents › Keep agents
 * running after logout › Sign-in token. A person pastes the token from
 * `claude setup-token` and saves it: it goes to the install's configured
 * secrets store (Doppler here, its CLI a shim that keeps what it gets on
 * stdin in the server's temp dir), and is never shown back: no response
 * body, the page's HTML or the server's log has it after Save. The row
 * then says when it was set. The copy button copies exactly
 * `claude setup-token`.
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

const TOKEN = "fake-oat-token-browser-0123456789abcdef";

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
      // `doppler secrets set KEY --silent`: stdin kept under $TMP/kept.
      doppler: [
        'if [ "$1" = "--version" ]; then echo "v3.0.0"; exit 0; fi',
        'mkdir -p "$TMP/kept"',
        'if [ "$1" = secrets ] && [ "$2" = set ]; then cat > "$TMP/kept/$3"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    },
  });
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;

async function settingsPage() {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  // The page's first-run overlay off, as in the other Settings tests.
  await p.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  // The copy button's text, as the clipboard would get it.
  await p.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (t: string) => {
          (window as unknown as { __copied: string[] }).__copied.push(t);
        },
      },
    });
  });
  const bodies: string[] = [];
  p.on("response", async (r) => {
    try {
      bodies.push(await r.text());
    } catch {
      /* a redirect or a stream: no body */
    }
  });
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings#agents"));
  await p.waitForSelector("[data-keep-token-input]");
  return { p, bodies };
}

describe("#299: Settings › Sign-in token", () => {
  it("Save writes it to the store; it is in no response, the page or the log; the row says set <date>", async () => {
    if (skip()) return;
    const { p, bodies } = await settingsPage();
    const row = p.locator("[data-keep]");
    await expect(
      row.locator("[data-keep-token]").getAttribute("data-keep-token"),
    ).resolves.toBe("missing");
    const input = p.locator("[data-keep-token-input]");
    expect(await input.getAttribute("type")).toBe("password");
    await input.fill(TOKEN);
    const saved = p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/agents/signin-token") &&
        r.request().method() === "POST",
    );
    await p.locator("[data-keep-token-save]").click();
    expect((await saved).status()).toBe(200);
    await p.waitForSelector('[data-keep-token="set"]');
    // Let the page's own reloads after Save land too.
    await p.waitForTimeout(500);
    expect(await input.inputValue()).toBe("");
    expect(await p.locator('[data-keep-token="set"]').textContent()).toMatch(
      /set .*20\d\d/,
    );
    // The store has it.
    const kept = path.join(s!.tmp, "kept");
    const files = fs.readdirSync(kept);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(kept, files[0]!), "utf-8")).toBe(TOKEN);
    // Never shown back: no response, the page's HTML, or the server's log.
    for (const b of bodies) expect(b).not.toContain(TOKEN);
    expect(await p.content()).not.toContain(TOKEN);
    const settings = JSON.stringify(await s!.settingsGet());
    expect(settings).not.toContain(TOKEN);
    expect(settings).toMatch(/"agent_signin":\{"configured":true/);
    expect(s!.log()).not.toContain(TOKEN);
    // After a reload, still set and still not shown.
    await p.reload();
    await p.waitForSelector('[data-keep-token="set"]');
    expect(await p.content()).not.toContain(TOKEN);
    await p.context().close();
  });

  it("one line names the only terminal step, with a copy button that copies exactly `claude setup-token`", async () => {
    if (skip()) return;
    const { p } = await settingsPage();
    const line = p.locator("[data-keep-setup]");
    expect(await line.textContent()).toContain("claude setup-token");
    await p.locator("[data-keep-copy]").click();
    expect(
      await p.evaluate(
        () => (window as unknown as { __copied: string[] }).__copied,
      ),
    ).toEqual(["claude setup-token"]);
    await p.context().close();
  });
});
