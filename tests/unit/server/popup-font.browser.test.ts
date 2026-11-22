/**
 * Issue 793: no pop-up draws in a serif font. Each of Den's pop-ups is
 * opened on each theme, in a real browser, and every piece of its text
 * must be in the page's own font: the same computed font-family as
 * document.body, and never a serif (a list with a serif generic, or with no
 * generic at all, which falls back to the browser's default serif).
 * Monospace text that is meant to be (code, a key, a version) is the
 * theme's --mono and is left out.
 *
 * The pop-ups: What's new (on its own the first time a version is unseen,
 * then from the version chip), a Yes/No question (the kit's confirm),
 * Local Dev's "turn off auto-start" question, and Projects' Add Service
 * (issue 806). Each on the Agents page and
 * on Settings, whose <body> has no font of its own (the font is on the
 * page's main, #den-content): a pop-up put in <body> that sets no font of
 * its own drew in the browser's serif there, which is what the owner saw.
 *
 * The themes: Den's built-in theme, and local themes standing for the kinds
 * the published themes are: a web font first in the stack, a light theme
 * whose display and Japanese faces are serif, a monospace UI face, a theme
 * with no `type` at all; then a theme whose CSS has no --sans (the kit's
 * tokens.css still has it), and no --sans anywhere (the kit's own
 * fallback is all there is: the pop-up still never draws in serif). The
 * theme's CSS is theme-runtime.ts's; the kit's sheets are served as
 * ui-assets.ts lists them.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { pageImport } from "./helpers/page-import.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let base = "";
let server: ChildProcess;
let browser: Browser | null = null;

/** A local theme: Den's own, with another id, name and type. */
function addTheme(
  dist: string,
  id: string,
  edit: (m: Record<string, unknown>) => void,
): void {
  const dir = path.join(dist, "plugins", id);
  fs.cpSync(path.join(ENGINE, "themes", "den"), dir, { recursive: true });
  const file = path.join(dir, "den-theme.json");
  const m = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
    string,
    unknown
  >;
  m.id = id;
  m.name = `Test ${id}`;
  m.author = "Den tests";
  delete m.homepage;
  edit(m);
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
}

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-793-")));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(path.join(dist, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(dist, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(dist, "config", "den.yml"),
    "environments: [local]\n",
  );
  // A repo in a project: not a fresh Den (ON-6), so What's new opens.
  fs.writeFileSync(
    path.join(dist, "config", "local", "workspaces.yml"),
    "active: [default]\nfocus: default\nworkspaces:\n  default:\n    services:\n      shop:\n        mode: dev-managed\n        path: /nowhere/shop\n",
  );
  // The catalog names it, so it is a service (the graph draws its card).
  fs.writeFileSync(
    path.join(dist, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\n",
  );
  addTheme(dist, "webfont", (m) => {
    m.type = {
      sans: 'Rubik, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      mono: '"Space Mono", ui-monospace, Menlo, monospace',
      display: "Rubik, sans-serif",
    };
  });
  addTheme(dist, "serifdisplay", (m) => {
    m.default_mode = "light";
    m.type = {
      sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
      display: 'ui-serif, "Iowan Old Style", Palatino, Georgia, serif',
      ja: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif',
    };
  });
  addTheme(dist, "monoface", (m) => {
    m.type = {
      sans: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      mono: '"JetBrains Mono", ui-monospace, Menlo, monospace',
    };
  });
  addTheme(dist, "notype", (m) => {
    delete m.type;
  });
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: dist,
      env: {
        ...process.env,
        DEN_ROOT: dist,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: path.join(tmp, "home"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
      },
    },
  );
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [server],
    after: () => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    },
  });
});

/**
 * The themes. `strip` takes --sans out of the theme's CSS, and with "all"
 * out of the kit's tokens.css too.
 */
const THEMES: { label: string; id: string; strip?: "theme" | "all" }[] = [
  { label: "the built-in theme", id: "den" },
  { label: "a web-font theme", id: "webfont" },
  { label: "a light theme with serif display faces", id: "serifdisplay" },
  { label: "a monospace-face theme", id: "monoface" },
  { label: "a theme with no type", id: "notype" },
  { label: "a theme with no --sans", id: "den", strip: "theme" },
  { label: "no --sans anywhere", id: "den", strip: "all" },
];

/** Each piece of text in the pop-up `sel`, with its font and the body's. */
type Fonts = {
  body: string;
  mono: string;
  texts: { what: string; font: string }[];
};
function fontsOf(p: Page, sel: string): Promise<Fonts> {
  return p.evaluate((sel) => {
    const norm = (s: string) =>
      s
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
        .join(",");
    const root = document.querySelector(sel);
    const texts: { what: string; font: string }[] = [];
    const all = root ? [root, ...root.querySelectorAll("*")] : [];
    for (const el of all) {
      if (el.closest("code, kbd, pre, samp, svg")) continue;
      const own = [...el.childNodes].some(
        (n) => n.nodeType === 3 && (n.textContent ?? "").trim(),
      );
      if (!own || !el.getClientRects().length) continue;
      const tag = el.tagName.toLowerCase();
      texts.push({
        what: `${tag}${el.id ? `#${el.id}` : ""}${el.classList[0] ? `.${el.classList[0]}` : ""}`,
        font: norm(getComputedStyle(el).fontFamily),
      });
    }
    // The theme's monospace, resolved as the browser resolves it.
    const probe = document.createElement("span");
    probe.style.fontFamily = "var(--mono)";
    document.body.append(probe);
    const mono = norm(getComputedStyle(probe).fontFamily);
    probe.remove();
    return {
      body: norm(getComputedStyle(document.body).fontFamily),
      mono,
      texts,
    };
  }, sel);
}

const GENERIC =
  /^(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|math|emoji)$/i;

/**
 * Serif: a serif generic in the list, or no generic at all (the browser's
 * default face, a serif, is what's left when the named fonts are missing).
 */
export function isSerif(font: string): boolean {
  const list = font.split(",").map((s) => s.trim());
  if (list.some((f) => /^(serif|ui-serif)$/i.test(f))) return true;
  return !list.some((f) => GENERIC.test(f));
}

/** What's wrong with a pop-up's fonts ([] when nothing). */
function problems(f: Fonts, mustMatchBody: boolean): string[] {
  const out: string[] = [];
  if (!f.texts.length) out.push("no text found in the pop-up");
  for (const t of f.texts) {
    if (t.font === f.mono) continue;
    if (isSerif(t.font)) out.push(`${t.what} is serif: ${t.font}`);
    else if (mustMatchBody && t.font !== f.body)
      out.push(`${t.what} is ${t.font}, the page is ${f.body}`);
  }
  return out;
}

async function pageOn(
  theme: (typeof THEMES)[number],
  where: string,
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, path.join(tmp, "home"), base);
  // This version unseen: What's new opens on its own.
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("den-changelog-seen", "0.0.0-unseen");
    } catch {
      /* none */
    }
  });
  if (theme.strip) {
    const drop = (css: string) => css.replace(/^\s*--sans\s*:[^;]*;\s*$/gm, "");
    await ctx.route("**/theme.css*", async (r) => {
      const res = await r.fetch();
      await r.fulfill({ response: res, body: drop(await res.text()) });
    });
    if (theme.strip === "all")
      await ctx.route("**/kit/tokens.css*", async (r) => {
        const res = await r.fetch();
        await r.fulfill({ response: res, body: drop(await res.text()) });
      });
  }
  const p = await ctx.newPage();
  await p.goto(`${base}/settings`);
  await p.waitForFunction(
    () => !!(window as unknown as PageWin).denShell?.api,
    undefined,
    {
      timeout: 20_000,
    },
  );
  await p.evaluate(
    (id) =>
      (window as unknown as PageWin).denShell!.api("POST", "/api/settings", {
        appearance: { theme: id },
      }),
    theme.id,
  );
  await p.goto(`${base}${where}`);
  return p;
}

/** The page's globals this file uses. */
type PageWin = {
  denShell?: { api: (m: string, u: string, b?: unknown) => Promise<unknown> };
  toggleAutostart?: (repo: string, on: boolean) => unknown;
};

const WHATS_NEW = "#cl-overlay.open";

/**
 * For review: a screenshot into DEN455_SHOTS (CI uploads that folder as
 * an artifact); nothing when it isn't set.
 */
const SHOTS = process.env.DEN455_SHOTS?.trim() || "";
async function shot(p: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
const CONFIRM = "dialog.dk-dlg[open]";

describe("issue 793: every pop-up draws in the page's font, on every theme", () => {
  describe.each(THEMES)("$label", (theme) => {
    const strict = theme.strip !== "all";

    it.each(["/agents", "/settings"])(
      "What's new on %s: on its own, then from the version chip",
      async (where) => {
        if (!browser) return;
        const p = await pageOn(theme, where);
        await p.locator(WHATS_NEW).waitFor({ timeout: 20_000 });
        expect(problems(await fontsOf(p, "#cl-overlay"), strict)).toEqual([]);
        await p.keyboard.press("Escape");
        await p.locator(WHATS_NEW).waitFor({ state: "detached" });
        await p.click("#version-pill");
        await p.locator(WHATS_NEW).waitFor();
        await shot(
          p,
          `793-whatsnew${where.replace(/\//g, "-")}-${theme.id}${theme.strip ? `-nosans-${theme.strip}` : ""}`,
        );
        expect(problems(await fontsOf(p, "#cl-overlay"), strict)).toEqual([]);
        await p.context().close();
      },
      60_000,
    );

    it.each(["/agents", "/settings"])(
      "a Yes/No question on %s",
      async (where) => {
        if (!browser) return;
        const p = await pageOn(theme, where);
        await p.locator(WHATS_NEW).waitFor({ timeout: 20_000 });
        await p.keyboard.press("Escape");
        await p.locator(WHATS_NEW).waitFor({ state: "detached" });
        // A string, so the browser does the import (not the test's compiler).
        await p.evaluate(
          `${pageImport("/dialog-den.js")}.then((m) => void m.askConfirm({ title: "Turn it off?", message: "Two systems need it." }))`,
        );
        await p.locator(CONFIRM).waitFor();
        expect(problems(await fontsOf(p, CONFIRM), strict)).toEqual([]);
        await p.keyboard.press("Escape");
        await p.context().close();
      },
      60_000,
    );

    it("Local Dev's turn-off-auto-start question", async () => {
      if (!browser) return;
      const p = await pageOn(theme, "/settings");
      // Another system needs this one (a hard edge): the question shows.
      await p.route("**/api/graph?*", async (r) => {
        let g: { nodes?: unknown[]; edges?: unknown[] } = {};
        try {
          const res = await r.fetch();
          if (res.ok()) g = (await res.json()) as typeof g;
        } catch {
          /* the edge below is enough */
        }
        await r.fulfill({
          json: {
            ...g,
            nodes: g.nodes ?? [],
            edges: [
              ...(g.edges ?? []),
              { from: "web", to: "shop", blocking: "hard" },
            ],
          },
        });
      });
      await p.goto(`${base}/local-dev`);
      await p.locator(WHATS_NEW).waitFor({ timeout: 20_000 });
      await p.keyboard.press("Escape");
      await p.locator(WHATS_NEW).waitFor({ state: "detached" });
      const pop = `#autostart-confirm-overlay, ${CONFIRM}`;
      const t0 = Date.now();
      while (!(await p.$(pop)) && Date.now() - t0 < 20_000) {
        // Not awaited: it answers only once the question is answered.
        await p.evaluate(() => {
          void (window as unknown as PageWin).toggleAutostart?.("shop", false);
        });
        await p.waitForTimeout(400);
      }
      await p.locator(pop).first().waitFor();
      expect(problems(await fontsOf(p, pop), strict)).toEqual([]);
      await p.context().close();
    }, 60_000);

    // Issue 806: Projects' Add Service, on the kit's dialog.
    it("Projects' Add Service", async () => {
      if (!browser) return;
      const p = await pageOn(theme, "/local-dev?ws=default");
      await p.locator(WHATS_NEW).waitFor({ timeout: 20_000 });
      await p.keyboard.press("Escape");
      await p.locator(WHATS_NEW).waitFor({ state: "detached" });
      await p.locator("[data-add-svc]").click();
      const pop = "dialog#add-svc-dlg[open]";
      await p.locator(pop).waitFor();
      expect(problems(await fontsOf(p, pop), strict)).toEqual([]);
      await p.keyboard.press("Escape");
      await p.context().close();
    }, 60_000);

    // Issue 837: the graph's details, popped out, on the kit's dialog.
    it("the graph's popped-out details", async () => {
      if (!browser) return;
      const p = await pageOn(theme, "/graph?ws=default");
      await p.locator(WHATS_NEW).waitFor({ timeout: 20_000 });
      await p.keyboard.press("Escape");
      await p.locator(WHATS_NEW).waitFor({ state: "detached" });
      await p
        .locator('[role="group"][data-id], [role="group"][data-repo]')
        .click({ timeout: 30_000 });
      await p.locator("[data-popout]:visible").click();
      const pop = "dialog#dg-pop[open]";
      await p.locator(pop).waitFor();
      expect(problems(await fontsOf(p, pop), strict)).toEqual([]);
      await p.keyboard.press("Escape");
      await p.context().close();
    }, 60_000);
  });

  it("the serif check can fail", () => {
    expect(isSerif("Times New Roman")).toBe(true);
    expect(isSerif("Georgia,serif")).toBe(true);
    expect(isSerif("Rubik")).toBe(true);
    expect(isSerif("Rubik,-apple-system,sans-serif")).toBe(false);
    expect(isSerif("JetBrains Mono,ui-monospace,monospace")).toBe(false);
  });
});

/**
 * Vision's root-cause gate: every Den page's <body> is in the theme's
 * --sans (base.css), so anything a script adds to <body> inherits it.
 * Before, Agents, Settings, Verify, Edge, Server agent, the error page and
 * Embed's connect page set their font on #den-content only, and <body>
 * was the browser's serif.
 */
const PAGES = [
  "/local-dev",
  "/graph",
  "/agents",
  "/agents?terminal=1",
  "/services",
  "/logs",
  "/verify",
  "/environments",
  "/release",
  "/edge",
  "/settings",
  "/server-agent",
  "/embed/connect",
  "/no-such-page",
];

describe("issue 793: every page's <body> is in the theme's sans", () => {
  describe.each(
    THEMES.filter((t) => !t.strip && ["den", "serifdisplay"].includes(t.id)),
  )("$label", (theme) => {
    it("every page", async () => {
      if (!browser) return;
      const p = await pageOn(theme, "/settings");
      const bad: string[] = [];
      for (const where of PAGES) {
        await p.goto(`${base}${where}`);
        await p.waitForLoadState("load");
        const f = await p.evaluate(() => {
          const norm = (s: string) =>
            s
              .split(",")
              .map((x) => x.trim().replace(/^["']|["']$/g, ""))
              .filter(Boolean)
              .join(",");
          const probe = document.createElement("span");
          probe.style.fontFamily = "var(--sans)";
          document.documentElement.append(probe);
          const sans = norm(getComputedStyle(probe).fontFamily);
          probe.remove();
          return {
            body: norm(getComputedStyle(document.body).fontFamily),
            sans,
          };
        });
        if (isSerif(f.body)) bad.push(`${where}: <body> is serif: ${f.body}`);
        else if (f.body !== f.sans)
          bad.push(`${where}: <body> is ${f.body}, --sans is ${f.sans}`);
      }
      expect(bad).toEqual([]);
      await p.context().close();
    }, 180_000);
  });
});
