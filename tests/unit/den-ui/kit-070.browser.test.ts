/**
 * den-ui 0.7.0: four pieces of the top bar and rail that a host drew
 * itself move into the kit, so every host draws them the same way:
 *
 * 1. The scope crumbs: small-caps keys (COMPANY / PROJECT / ENV), each
 *    with its value, and a ▾ trigger when it has a menu. Any crumb may be
 *    left out.
 * 2. The search field with ⌘K inside it. The host gives the placeholder
 *    and what activating it does; the kit owns no palette.
 * 3. The bell: the button, its count badge, and the panel's shell (title,
 *    rows or the empty state). The kit owns the markup, focus, Esc and
 *    close; focus goes back to the bell, in WebKit too.
 * 4. The account entry in the rail's foot: a label, a detail, and a link
 *    or an action.
 *
 * On a bare page built from the kit's own files, in Chromium and WebKit.
 * The page keeps a click from focusing a button, as Safari on macOS does.
 * DEN_PW_WS: Den's own Playwright server instead of a local browser.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = process.env.DEN_PW_WS
        ? await kind.connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await kind.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

const STYLES = ["tokens", "fonts", "base", "shell", "report", "dialog"];

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${STYLES.map((s) => `<link rel="stylesheet" href="/kit/${s}.css">`).join("\n")}
<style>body { margin: 0; }</style>
</head>
<body class="den-has-shell"><div class="den-shell" id="den-shell"></div>
<main id="den-content"><p><button type="button" id="host-btn">Elsewhere</button></p></main>
<script type="module" src="/app.js"></script>
</body></html>`;

/**
 * The app: `?bare` mounts a shell with none of the four pieces; `?count=N`
 * the bell's count; `?items=0` an empty bell; `?act` the account entry as
 * an action. Activations, account actions and opens are kept on window.
 */
const APP = `
// Safari on macOS doesn't focus a button on a click: neither does this page.
document.addEventListener("mousedown", (e) => {
  if (e.target.closest && e.target.closest("button") && !e.target.closest(".den-bell-pop")) e.preventDefault();
}, true);
import DenUI from "/kit/kit.js";
const q = new URLSearchParams(location.search);
window.log = { search: [], account: 0, events: 0, opened: 0, closed: 0 };
DenUI.configure({ lang: "en", product: { name: "Acme" } });
const items = q.get("items") === "0" ? [] : [
  { id: "a", text: "Build finished", href: "#build", time: "2 min" },
  { id: "b", text: "Agent is waiting", href: "#agent", time: "now", read: true },
];
const model = {
  product: { name: "Acme", version: "1.0.0", mark: { text: "A", label: "Acme" } },
  groups: [{ id: "work", label: "Work" }],
  nav: [{ id: "home", label: "Home", href: "/", group: "work", icon: "home", current: true }],
};
if (!q.has("bare")) {
  const crumbs = [
    { key: "org", label: "Company", value: "North Co" },
    { key: "ws", label: "Project", value: "Garden", menu: [
      { label: "Garden", href: "#garden", current: true },
      { label: "Orchard", href: "#orchard" },
    ] },
  ];
  if (!q.has("noenv")) crumbs.push({ key: "env", label: "Env", value: "local", menu: '<a href="#staging" role="menuitem">staging</a>' });
  model.slots = {
    start: DenUI.scopeHtml({ crumbs }) + DenUI.searchHtml({ placeholder: "Find anything…" }),
    bell: DenUI.bellButtonHtml({ count: Number(q.get("count") ?? 2) }),
  };
  model.account = q.has("act")
    ? { label: "Signed in", detail: "this device", action: true }
    : { label: "Signed in", detail: "this device", href: "#account" };
  model.hydrate = {
    search: { onActivate: (via) => window.log.search.push(via) },
    bell: {
      title: "Notifications",
      items: () => items,
      onOpen: () => window.log.opened++,
      onClose: () => window.log.closed++,
    },
    account: { onAction: () => window.log.account++ },
  };
}
document.addEventListener("den-ui:search", () => window.log.events++);
window.shell = DenUI.mount(document.getElementById("den-shell"), model);
window.DenUI = DenUI;
window.ready = true;
`;

async function open(b: Browser, query = ""): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    if (u.pathname === "/app.js")
      return r.fulfill({ contentType: "text/javascript", body: APP });
    const f = u.pathname.replace(/^\/kit\//, "");
    const file = path.join(SRC, f);
    if (u.pathname.startsWith("/kit/") && fs.existsSync(file))
      return r.fulfill({
        contentType: f.endsWith(".css")
          ? "text/css"
          : f.endsWith(".woff2")
            ? "font/woff2"
            : "text/javascript",
        body: fs.readFileSync(file),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/${query}`);
  await p.waitForFunction(
    () => (window as { ready?: boolean }).ready === true,
    undefined,
    { timeout: 10_000 },
  );
  return p;
}

/** The focused element: its id, else its class, else its tag. */
const focused = (p: Page) =>
  p.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a) return null;
    return a.id || a.getAttribute("href") || a.tagName.toLowerCase();
  });

const log = (p: Page) =>
  p.evaluate(
    () =>
      (window as unknown as { log: Record<string, unknown> }).log as {
        search: string[];
        account: number;
        events: number;
        opened: number;
        closed: number;
      },
  );

for (const engine of ["chromium", "webkit"]) {
  describe(`den-ui 0.7.0 shell pieces (${engine})`, () => {
    it("draws the four pieces from the host's options", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      const got = await p.evaluate(() => {
        const top = document.querySelector(".den-top")!;
        const scope = top.querySelector(".den-scope");
        const crumbs = [...(scope?.querySelectorAll(".den-ib") ?? [])].map(
          (c) => ({
            tag: c.tagName.toLowerCase(),
            key: c.querySelector(".den-k")?.textContent,
            value: c.querySelector(".den-vn")?.textContent,
            menu: c.getAttribute("aria-haspopup"),
            caret: !!c.querySelector('[aria-hidden="true"]'),
          }),
        );
        const search = top.querySelector(".den-search");
        const bell = top.querySelector(".den-bell");
        const acct = document.querySelector(
          ".den-rail .den-acct",
        ) as HTMLAnchorElement | null;
        // The search sits after the scope, both after the brand.
        const order = [...top.children].map((e) => e.className.split(" ")[0]);
        return {
          group: scope?.getAttribute("role"),
          groupLabel: scope?.getAttribute("aria-label"),
          crumbs,
          keyCase: scope
            ? getComputedStyle(scope.querySelector(".den-k")!).textTransform
            : null,
          search: {
            tag: search?.tagName.toLowerCase(),
            ph: search?.querySelector(".den-search-ph")?.textContent,
            kbd: search?.querySelector("kbd")?.textContent,
            kbdInside: !!search?.contains(search.querySelector("kbd")),
            shortcuts: search?.getAttribute("aria-keyshortcuts"),
            name: search?.getAttribute("aria-label"),
          },
          bell: {
            popup: bell?.getAttribute("aria-haspopup"),
            expanded: bell?.getAttribute("aria-expanded"),
            badge: bell?.querySelector(".den-bell-n")?.textContent,
            badgeHidden: (bell?.querySelector(".den-bell-n") as HTMLElement)
              ?.hidden,
            name: bell?.getAttribute("aria-label"),
          },
          acct: acct
            ? {
                href: acct.getAttribute("href"),
                text: acct.textContent,
                inFoot:
                  !!acct.closest(".den-rail") &&
                  !acct.closest(".den-rail-group"),
              }
            : null,
          order,
        };
      });
      expect(got.group).toBe("group");
      expect(got.groupLabel).toBe("Scope");
      expect(got.crumbs).toEqual([
        {
          tag: "span",
          key: "Company",
          value: "North Co",
          menu: null,
          caret: false,
        },
        {
          tag: "button",
          key: "Project",
          value: "Garden",
          menu: "menu",
          caret: true,
        },
        {
          tag: "button",
          key: "Env",
          value: "local",
          menu: "menu",
          caret: true,
        },
      ]);
      expect(got.keyCase).toBe("uppercase");
      expect(got.search).toEqual({
        tag: "button",
        ph: "Find anything…",
        kbd: "⌘K",
        kbdInside: true,
        shortcuts: "Meta+K Control+K",
        name: "Find anything…",
      });
      expect(got.bell).toEqual({
        popup: "dialog",
        expanded: "false",
        badge: "2",
        badgeHidden: false,
        name: "Notifications: 2 unread",
      });
      expect(got.acct).toEqual({
        href: "#account",
        text: "Signed in · this device",
        inFoot: true,
      });
      expect(got.order.indexOf("den-scope")).toBeGreaterThan(
        got.order.indexOf("den-brand"),
      );
      expect(got.order.indexOf("den-search")).toBe(
        got.order.indexOf("den-scope") + 1,
      );
      await p.context().close();
    });

    it("a piece left out draws nothing", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, "?bare");
      await expect(
        p.evaluate(() =>
          [
            ".den-scope",
            ".den-search",
            ".den-bell",
            ".den-bell-pop",
            ".den-acct",
          ].map((s) => document.querySelectorAll(s).length),
        ),
      ).resolves.toEqual([0, 0, 0, 0, 0]);
      await expect(
        p.evaluate(() => {
          const D = (
            window as unknown as {
              DenUI: Record<string, (o?: unknown) => string>;
            }
          ).DenUI;
          return [
            D.scopeHtml({ crumbs: [] }),
            D.scopeHtml(),
            D.accountHtml(null),
          ];
        }),
      ).resolves.toEqual(["", "", ""]);
      await p.context().close();
      // One host has no ENV: its crumb and its separator are not drawn.
      const q = await open(b, "?noenv");
      await expect(
        q.evaluate(() => ({
          keys: [...document.querySelectorAll(".den-scope .den-k")].map(
            (k) => k.textContent,
          ),
          seps: document.querySelectorAll(".den-scope .den-sep").length,
        })),
      ).resolves.toEqual({ keys: ["Company", "Project"], seps: 2 });
      await q.context().close();
    });

    it("the search activates on a click, ⌘K and Ctrl-K", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.locator(".den-search").click();
      await p.locator("#host-btn").focus();
      await p.keyboard.press("Meta+k");
      await p.keyboard.press("Control+k");
      // ⌥⌘K is not the shortcut.
      await p.keyboard.press("Alt+Meta+k");
      const l = await log(p);
      expect(l.search).toEqual(["click", "key", "key"]);
      expect(l.events).toBe(3);
      await p.context().close();
    });

    it("the bell's badge: the count, 99+, none at 0", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, "?count=0");
      const badge = () =>
        p.evaluate(() => {
          const n = document.querySelector(".den-bell-n") as HTMLElement;
          return {
            text: n.textContent,
            hidden: n.hidden,
            shown: getComputedStyle(n).display !== "none",
            name: document
              .querySelector(".den-bell")!
              .getAttribute("aria-label"),
          };
        });
      await expect(badge()).resolves.toEqual({
        text: "",
        hidden: true,
        shown: false,
        name: "Notifications",
      });
      await p.evaluate(() =>
        (
          window as unknown as {
            shell: { bell: { setCount(n: number): void } };
          }
        ).shell.bell.setCount(120),
      );
      await expect(badge()).resolves.toEqual({
        text: "99+",
        hidden: false,
        shown: true,
        name: "Notifications: 120 unread",
      });
      await p.context().close();
    });

    it("the bell's panel: its rows, and the empty state", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.locator(".den-bell").click();
      const pop = p.locator(".den-bell-pop");
      await pop.waitFor({ state: "visible" });
      await expect(
        p.evaluate(() => {
          const pop = document.querySelector(".den-bell-pop")!;
          return {
            role: pop.getAttribute("role"),
            name: document.getElementById(pop.getAttribute("aria-labelledby")!)
              ?.textContent,
            rows: [...pop.querySelectorAll(".den-bell-row")].map((r) => ({
              text: r.querySelector("a")?.textContent,
              href: r.querySelector("a")?.getAttribute("href"),
              read: r.classList.contains("read"),
            })),
            controls: document
              .querySelector(".den-bell")!
              .getAttribute("aria-controls"),
            id: pop.id,
          };
        }),
      ).resolves.toEqual({
        role: "dialog",
        name: "Notifications",
        rows: [
          { text: "Build finished", href: "#build", read: false },
          { text: "Agent is waiting", href: "#agent", read: true },
        ],
        controls: "den-bell-pop",
        id: "den-bell-pop",
      });
      await p.context().close();
      const q = await open(b, "?items=0&count=0");
      await q.locator(".den-bell").click();
      await q.locator(".den-bell-pop").waitFor({ state: "visible" });
      await expect(
        q.evaluate(() => ({
          empty: document.querySelector(".den-bell-pop .den-bell-empty")
            ?.textContent,
          rows: document.querySelectorAll(".den-bell-pop .den-bell-row").length,
        })),
      ).resolves.toEqual({ empty: "Nothing new.", rows: 0 });
      await q.context().close();
    });

    it("the bell opens and closes: Esc, a click outside, the bell again; focus goes back to the bell", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      const bell = p.locator(".den-bell");
      const pop = p.locator(".den-bell-pop");
      // Esc: closed, focus on the bell (a click never focused it).
      await bell.click();
      await pop.waitFor({ state: "visible" });
      await expect(bell).toHaveAttribute("aria-expanded", "true");
      await expect(focused(p)).resolves.toBe("#build");
      await p.keyboard.press("Escape");
      await pop.waitFor({ state: "hidden" });
      await expect(bell).toHaveAttribute("aria-expanded", "false");
      await expect(focused(p)).resolves.toBe("den-bell");
      // The bell again closes it.
      await bell.click();
      await pop.waitFor({ state: "visible" });
      await bell.click();
      await pop.waitFor({ state: "hidden" });
      // A click outside closes it, and leaves focus where the click went.
      await bell.click();
      await pop.waitFor({ state: "visible" });
      await p.locator("#den-content").click({ position: { x: 600, y: 400 } });
      await pop.waitFor({ state: "hidden" });
      const l = await log(p);
      expect([l.opened, l.closed]).toEqual([3, 3]);
      await p.context().close();
    });

    it("keyboard: Tab reaches the crumbs, the search and the bell; menus and the bell open and close by key", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      // Tab order from the brand (WebKit needs Alt+Tab to reach links
      // and buttons; Chromium takes either).
      const tab = engine === "webkit" ? "Alt+Tab" : "Tab";
      await p.locator(".den-brand").focus();
      const seen: (string | null)[] = [];
      for (let i = 0; i < 5; i++) {
        await p.keyboard.press(tab);
        seen.push(await focused(p));
      }
      // (The org crumb has no menu: not a stop. Report sits before the bell.)
      expect(seen).toEqual([
        "den-scope-ws",
        "den-scope-env",
        "den-search",
        "button",
        "den-bell",
      ]);
      // The search: Enter activates it.
      await p.locator("#den-search").focus();
      await p.keyboard.press("Enter");
      expect((await log(p)).search).toEqual(["click"]);
      // A crumb's menu: ArrowDown opens it on its first entry, ↓ moves,
      // Esc closes it and focus goes back to its trigger.
      const ws = p.locator("#den-scope-ws");
      await ws.focus();
      await p.keyboard.press("ArrowDown");
      await expect(ws).toHaveAttribute("aria-expanded", "true");
      await expect(focused(p)).resolves.toBe("#garden");
      await p.keyboard.press("ArrowDown");
      await expect(focused(p)).resolves.toBe("#orchard");
      await p.keyboard.press("Escape");
      await expect(ws).toHaveAttribute("aria-expanded", "false");
      await expect(focused(p)).resolves.toBe("den-scope-ws");
      // Enter opens it too; the menu's entries are menu items.
      await p.keyboard.press("Enter");
      await expect(
        p.evaluate(() =>
          [...document.querySelectorAll("#den-scope-ws-menu a")].map((a) => [
            a.getAttribute("role"),
            a.getAttribute("aria-current"),
          ]),
        ),
      ).resolves.toEqual([
        ["menuitem", "true"],
        ["menuitem", null],
      ]);
      await p.keyboard.press("Escape");
      // The bell: Enter opens it on its first row; Esc closes it, back on
      // the bell.
      await p.locator("#den-bell").focus();
      await p.keyboard.press("Enter");
      await p.locator(".den-bell-pop").waitFor({ state: "visible" });
      await expect(focused(p)).resolves.toBe("#build");
      await p.keyboard.press("Escape");
      await expect(focused(p)).resolves.toBe("den-bell");
      await p.context().close();
    });

    it("the account entry: a link, or an action", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.locator(".den-acct").click();
      await expect(p.evaluate(() => location.hash)).resolves.toBe("#account");
      await expect(p.locator(".den-acct").getAttribute("title")).resolves.toBe(
        "Signed in · this device",
      );
      await p.context().close();
      const q = await open(b, "?act");
      await expect(
        q.evaluate(() => document.querySelector(".den-acct")!.tagName),
      ).resolves.toBe("BUTTON");
      await q.locator(".den-acct").click();
      await q.locator(".den-acct").focus();
      await q.keyboard.press("Enter");
      expect((await log(q)).account).toBe(2);
      await q.context().close();
    });
  });
}
