/**
 * Every word a page shows goes through the catalog, inside the page too
 * (0.4.45, after the project names review found English in es and ja on
 * Settings and Manage projects that no gate saw). The shell's pseudo-locale
 * lint (i18n-shell.browser.test.ts) checks only outside <main>, and the
 * parity test only compares catalog keys, so a page that draws an English
 * literal (a registry row's label, a hard-wired button) passed both.
 *
 * Here the real pages run on the demo distribution in Spanish, with the
 * Spanish catalog swapped for en wrapped in ⟦…⟧: anything visible in the
 * page's <main> (text, title, aria-label, placeholder) left unwrapped once
 * names are cut away is a literal that skipped the catalog. Needs
 * Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
let browser: Browser | null = null;
let s: AgentsPageServer | null = null;

/** shell.js's en, every text wrapped in ⟦…⟧ (its placeholders kept). */
function pseudo(): Record<string, string> {
  const window: Record<string, unknown> = {};
  const ctx = vm.createContext({
    window,
    document: { getElementById: () => null, documentElement: { lang: "en" } },
    Intl,
  });
  try {
    vm.runInContext(
      fs.readFileSync(path.join(PUBLIC, "shell.js"), "utf-8"),
      ctx,
    );
  } catch {
    // shell.js stops at its first DOM use; its catalog is set before it.
  }
  const en = (window.denMessages as Record<string, Record<string, string>>).en;
  return Object.fromEntries(Object.entries(en).map(([k, v]) => [k, `⟦${v}⟧`]));
}

/** What the demo serves by name, and what a page may show untranslated. */
const NAMES = [
  // The demo's edge domain (before "acme": longest first).
  "acme.localhost",
  "north",
  "south",
  "North Star",
  "notes",
  "blog",
  "acme",
  "alpha",
  "zeta",
  "local",
  "Den",
  "GitHub",
  "Hub",
  // Products, languages and tokens shown by their own names.
  "VS Code",
  "Cursor",
  "WebStorm",
  "IntelliJ IDEA",
  "Zed",
  "vim",
  "Neovim",
  "Emacs",
  "Terminal",
  "iTerm2",
  "Ghostty",
  "Warp",
  "kitty",
  "Alacritty",
  "Hyper",
  "Go",
  "Python",
  "TypeScript",
  "JavaScript",
  "Java",
  "Kotlin",
  "Rust",
  "Ruby",
  "Swift",
  "English",
  "Español",
  // A device's label, stored by the server at sign-in (web-session.ts).
  "Chrome on macOS",
  "Chrome",
  "macOS",
  "Acme",
  "accent",
  "ok",
  "warn",
  "bad",
  "bg",
  "surface",
  "text",
  "__DEN_CLI__",
  "__DEN_TITLE__",
  // A terminal's own name (agent-ops: "shell", "shell-2").
  "shell",
];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({ inactive: ["alpha", "zeta"] });
  const yml = path.join(s.tmp, "dist", "config", "local", "workspaces.yml");
  fs.writeFileSync(
    yml,
    fs
      .readFileSync(yml, "utf-8")
      .replace(
        "  north:\n",
        "  north:\n    hub_project: { id: proj_north1, slug: north-star, name: North Star }\n",
      ),
  );
  await s.settings({ language: "es" });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

async function open(next: string): Promise<Page> {
  const p = await browser!.newPage({ viewport: { width: 1440, height: 1000 } });
  const qps = JSON.stringify(pseudo());
  await p.route(`${s!.base}/i18n/es.js`, (r) =>
    r.fulfill({
      contentType: "text/javascript; charset=utf-8",
      body: `(window.denMessages = window.denMessages || {}).es = ${qps};`,
    }),
  );
  await p.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  await p.goto(signInUrl(s!.stateDir, s!.base, next));
  return p;
}

/** Unwrapped text in <main>: each visible text node and title/label/placeholder. */
function leaks(p: Page, root = "#den-content"): Promise<string[]> {
  return p.evaluate(
    ([names, root]) => {
      const out = new Set<string>();
      const check = (str: string | null, where: string) => {
        if (!str) return;
        let rest = str;
        for (let prev = ""; prev !== rest; ) {
          prev = rest;
          rest = rest.replace(/⟦[^⟦⟧]*⟧/g, " ");
        }
        for (const n of names)
          rest = rest.replace(
            new RegExp(`(^|[^\\w-])${n}(?![\\w-])`, "g"),
            "$1",
          );
        // Paths, URLs and commands are data, not words.
        rest = rest.replace(/(\/[\w.@~-]+)+\/?|https?:\S+|`[^`]*`/g, " ");
        // CSS tokens and colours (--accent #557a2a), addresses (127.0.0.1).
        rest = rest.replace(
          /--[\w-]+|#[0-9a-fA-F]{3,8}\b|\b\d{1,3}(\.\d{1,3}){3}\b/g,
          " ",
        );
        if (/[A-Za-z]{2,}/.test(rest))
          out.add(`${where}: ${str.trim().slice(0, 90)}`);
      };
      const main = document.querySelector(root as string);
      if (!main) return ["no #den-content"];
      const visible = (e: Element) => !!(e as HTMLElement).offsetParent;
      const skip = (e: Element) =>
        !!e.closest(
          "script, style, code, pre, kbd, [hidden], [aria-hidden=true], input, textarea",
        );
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || skip(el) || !visible(el)) continue;
        check(
          n.textContent,
          `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}>`,
        );
      }
      for (const el of Array.from(
        main.querySelectorAll("[title], [aria-label], [placeholder]"),
      )) {
        if (el.closest("script, style, [hidden]") || !visible(el)) continue;
        for (const a of ["title", "aria-label", "placeholder"])
          check(el.getAttribute(a), `${el.tagName.toLowerCase()}[${a}]`);
      }
      return [...out];
    },
    [NAMES, root] as const,
  );
}

describe("pages in a pseudo-locale: no literal inside <main>", () => {
  it("Settings › Project setup and Navigation", async () => {
    if (!browser) return;
    const p = await open("/settings?ws=north#workspace");
    await p.waitForSelector('[data-setting="workspace.name"] [data-pname]');
    await p.waitForSelector(
      '[data-setting="shell.projectOrder"] [data-porder]',
    );
    const found = await leaks(p);
    await p.close();
    expect(found).toEqual([]);
  }, 60_000);

  it("Manage projects", async () => {
    if (!browser) return;
    const p = await open("/local-dev?ws=north");
    await p.waitForSelector("#ws-list .ws-item");
    await p.waitForSelector("#content h2");
    const found = await leaks(p);
    await p.close();
    expect(found).toEqual([]);
  }, 60_000);

  it("Graph, with a card's details open", async () => {
    if (!browser) return;
    const p = await open("/graph?ws=north");
    await p.waitForSelector(".dg-card");
    const found = new Set(await leaks(p));
    await p.click(".dg-card");
    await p.waitForSelector(".dg-panel:not([hidden])");
    for (const l of await leaks(p)) found.add(l);
    await p.close();
    expect([...found]).toEqual([]);
  }, 60_000);

  it("Agents, the terminal and the server agent's page", async () => {
    if (!browser) return;
    const found = new Set<string>();
    for (const [url, ready] of [
      ["/agents", "#den-content"],
      ["/agents?terminal=1", ".xterm, #den-content"],
      ["/server-agent", "#den-content"],
    ]) {
      const p = await open(url);
      await p.waitForSelector(ready);
      await p.waitForLoadState("networkidle").catch(() => {});
      await p.waitForTimeout(1500);
      // The page's own URL line is data.
      for (const l of await leaks(p))
        if (!l.startsWith("<span#ag-url>")) found.add(`${url} ${l}`);
      await p.close();
    }
    expect([...found]).toEqual([]);
  }, 90_000);

  it("the bell, open", async () => {
    if (!browser) return;
    const p = await open("/agents");
    await p.click("#den-bell");
    await p.waitForSelector(".den-bell-pop");
    const found = await leaks(p, ".den-bell-pop");
    await p.close();
    expect(found).toEqual([]);
  }, 60_000);
});
