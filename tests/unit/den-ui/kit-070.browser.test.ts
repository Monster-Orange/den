/**
 * den-ui 0.7.0: four pieces of the top bar and rail that a host drew
 * itself move into the kit, so every host draws them the same way:
 *
 * 1. The scope crumbs: small-caps keys (COMPANY / PROJECT / ENV), each
 *    with its value, and a ▾ trigger when it has a menu. Any crumb may be
 *    left out.
 * 2. The search field with ⌘K inside it. The kit owns its words
 *    ("Search…"); the host gives what activating it does; the kit owns no
 *    palette.
 * 3. The bell: the button, its count badge, and the panel's shell (title,
 *    rows or the empty state). The kit owns the markup, focus, Esc and
 *    close; focus goes back to the bell, in WebKit too.
 * 4. The account entry in the rail's foot: a label, a detail, and a link
 *    or an action.
 * 5. ◐ ▾, the appearance menu: the host gives the modes, themes and
 *    languages and gets a callback; the kit owns the button, the menu,
 *    its keys, Esc and focus back.
 * 6. The version chip's pip (unread notes) and the update-waiting pill
 *    beside it.
 * 7. Settings in the rail's foot, before the account entry.
 * 8. The account entry's menu: who is signed in, here, and Sign out as a
 *    plain form post (no script needed for it).
 * 9. A crumb's menu with many entries gets a type-to-filter field.
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
window.log = { search: [], account: 0, events: 0, opened: 0, closed: 0, picks: [], waited: 0 };
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
  const many = ["Garden", "Orchard", "Meadow", "Forest", "River", "Harbor", "Valley", "Ridge"];
  const projects = q.has("many")
    ? many.map((n, i) => ({ label: n, href: "#" + n.toLowerCase(), current: i === 0 }))
    : [
        { label: "Garden", href: "#garden", current: true },
        { label: "Orchard", href: "#orchard" },
      ];
  // ?long: a host's long names (issue 303): 54+ characters each.
  const long = q.has("long");
  const crumbs = [
    { key: "org", label: "Company", value: long ? "The North Country Cooperative of Gardeners and Growers" : "North Co" },
    { key: "ws", label: "Project", value: long ? "The Quarterly Planning Project With A Very Long Name Too" : "Garden", menu: projects,
      ...(q.has("filter") ? { filter: Number(q.get("filter")) } : {}),
      ...(q.has("nofilter") ? { filter: false } : {}) },
  ];
  if (!q.has("noenv")) crumbs.push({ key: "env", label: "Env", value: "local", menu: '<a href="#staging" role="menuitem">staging</a>' });
  model.slots = {
    start: DenUI.scopeHtml({ crumbs }) + DenUI.searchHtml(),
    bell: DenUI.bellButtonHtml({ count: Number(q.get("count") ?? 2) }),
    account: DenUI.appearanceButtonHtml(),
  };
  // ?chips: a host's own chips in the end slot (issue 303).
  if (q.has("chips"))
    model.slots.end =
      '<button type="button" class="den-chip" id="host-a"><span>12 of 12 services up</span></button>' +
      '<button type="button" class="den-chip" id="host-b"><span>Runs</span></button>';
  // ?longname: a long install name.
  if (q.has("longname")) model.product = { ...model.product, name: "A Very Long Install Name For This Place And Then Some" };
  // ?longver: a long version (a dev build's) widens the kit's own chip.
  if (q.has("longver")) model.product = { ...model.product, version: "0.4.63-dev.12" };
  model.settings = { href: "#settings" };
  model.account = q.has("act")
    ? { name: "Ada Lovelace", login: "ada", action: true }
    : q.has("acctmenu")
      ? { name: "Ada Lovelace", login: "ada", menu: true }
      : { name: "Ada Lovelace", login: "ada", href: "#account" };
  model.hydrate = {
    search: { onActivate: (via) => window.log.search.push(via) },
    bell: {
      title: "Notifications",
      items: () => items,
      onOpen: () => window.log.opened++,
      onClose: () => window.log.closed++,
    },
    account: {
      onAction: () => window.log.account++,
      menu: () => ({
        name: "Ada Lovelace",
        login: "ada",
        items: [
          { label: "Sessions", href: "#sessions" },
          { label: "Sign out", action: { method: "post", url: "/out", csrf: "tok-1" } },
        ],
      }),
    },
    appearance: {
      menu: () => ({
        mode: "system",
        themes: [
          { value: "", label: "Org default (Plain)", selected: true },
          { value: "sea", label: "Sea" },
        ],
        languages: [
          { id: "en", name: "English", current: true },
          { id: "es", name: "Español" },
        ],
        items: [{ label: "All settings", href: "#all" }],
      }),
      onPick: (kind, value) => window.log.picks.push([kind, value]),
    },
  };
}
document.addEventListener("den-ui:search", () => window.log.events++);
// A host's own menu (its own rows and keys) given the kit's filter.
window.hostMenu = () => {
  const b = document.getElementById("host-btn");
  const m = document.createElement("div");
  m.className = "den-pop den-um";
  m.id = "host-menu";
  m.setAttribute("role", "menu");
  m.innerHTML = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"]
    .map((w) => '<button type="button" class="den-mi" role="menuitem">' + w + "</button>")
    .join("");
  m.addEventListener("click", (e) => {
    const r = e.target.closest(".den-mi");
    if (r) { window.log.picks.push(["host", r.textContent]); m.remove(); }
  });
  m.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { window.log.picks.push(["host-esc"]); m.remove(); b.focus(); }
  });
  const field = DenUI.attachMenuFilter(m, {
    label: "Things",
    onClose: () => { window.log.picks.push(["closed"]); m.remove(); b.focus(); },
  });
  document.body.appendChild(m);
  field.focus();
};
window.shell = DenUI.mount(document.getElementById("den-shell"), model);
window.DenUI = DenUI;
window.ready = true;
`;

/** What reached /out (a sign-out form's post): "METHOD body". */
const posts: string[] = [];

async function open(
  b: Browser,
  query = "",
  width = 1280,
  touch = false,
): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width, height: 800 },
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    if (u.pathname === "/out") {
      posts.push(`${r.request().method()} ${r.request().postData() ?? ""}`);
      return r.fulfill({ contentType: "text/html", body: "signed out" });
    }
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
          ".den-rail [data-den-account]",
        ) as HTMLAnchorElement | null;
        // The search sits after the scope, both after the brand.
        // In reading order: the left part's pieces, then the search, then
        // the chips (issue 303: ☰, the brand and the crumbs sit in .den-left).
        const order = [
          ...top.querySelectorAll(
            ":scope > .den-left > *, :scope > :not(.den-left)",
          ),
        ].map((e) => e.className.split(" ")[0]);
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
        ph: "Search…",
        kbd: "⌘K",
        kbdInside: true,
        shortcuts: "Meta+K Control+K",
        // The kit's own words: a host can't set them.
        name: "Search",
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
        // The kit's two lines: the name, then @login.
        text: "Ada Lovelace@ada",
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
            "[data-den-account]",
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
      await expect(bell.getAttribute("aria-expanded")).resolves.toBe("true");
      await expect(focused(p)).resolves.toBe("#build");
      await p.keyboard.press("Escape");
      await pop.waitFor({ state: "hidden" });
      await expect(bell.getAttribute("aria-expanded")).resolves.toBe("false");
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
      await expect(ws.getAttribute("aria-expanded")).resolves.toBe("true");
      await expect(focused(p)).resolves.toBe("#garden");
      await p.keyboard.press("ArrowDown");
      await expect(focused(p)).resolves.toBe("#orchard");
      await p.keyboard.press("Escape");
      await expect(ws.getAttribute("aria-expanded")).resolves.toBe("false");
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
      await p.locator("[data-den-account]").click();
      await expect(p.evaluate(() => location.hash)).resolves.toBe("#account");
      await expect(
        p.locator("[data-den-account]").getAttribute("title"),
      ).resolves.toBe("Ada Lovelace · @ada");
      await p.context().close();
      const q = await open(b, "?act");
      await expect(
        q.evaluate(() => document.querySelector("[data-den-account]")!.tagName),
      ).resolves.toBe("BUTTON");
      await q.locator("[data-den-account]").click();
      await q.locator("[data-den-account]").focus();
      await q.keyboard.press("Enter");
      expect((await log(q)).account).toBe(2);
      await q.context().close();
    });

    it("◐ ▾: the button, its menu, a pick, Esc and focus back", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      const btn = p.locator(".den-top .appearance-btn");
      await expect(
        btn.evaluate((e) => [
          e.getAttribute("aria-label"),
          e.getAttribute("title"),
          e.getAttribute("aria-haspopup"),
          e.textContent,
          // Last in the bar.
          e === document.querySelector(".den-chips")!.lastElementChild,
        ]),
      ).resolves.toEqual([
        "Appearance",
        "Appearance and theme",
        "menu",
        "◐ ▾",
        true,
      ]);
      // A click opens it on the checked mode.
      await btn.click();
      const menu = p.locator("#appearance-btn-menu");
      await menu.waitFor();
      await expect(btn.getAttribute("aria-expanded")).resolves.toBe("true");
      await expect(
        p.evaluate(() => {
          const m = document.querySelector("#appearance-btn-menu")!;
          return {
            heads: [...m.querySelectorAll(".den-ml")].map((h) => h.textContent),
            rows: [...m.querySelectorAll(".den-mi")].map((r) => [
              r.textContent,
              r.getAttribute("role"),
              r.getAttribute("aria-checked"),
            ]),
            focused: document.activeElement?.textContent,
            below:
              m.getBoundingClientRect().top >=
              document.querySelector(".appearance-btn")!.getBoundingClientRect()
                .bottom,
          };
        }),
      ).resolves.toEqual({
        heads: ["Appearance", "Theme", "Language"],
        rows: [
          ["System", "menuitemradio", "true"],
          ["Dark", "menuitemradio", "false"],
          ["Light", "menuitemradio", "false"],
          ["Org default (Plain)", "menuitemradio", "true"],
          ["Sea", "menuitemradio", "false"],
          ["English", "menuitemradio", "true"],
          ["Español", "menuitemradio", "false"],
          ["All settings", "menuitem", null],
        ],
        focused: "System",
        below: true,
      });
      // ↓ then Enter picks Dark: the host's callback, closed, focus back.
      await p.keyboard.press("ArrowDown");
      await p.keyboard.press("Enter");
      await menu.waitFor({ state: "detached" });
      expect((await log(p)).picks).toEqual([["mode", "dark"]]);
      await expect(focused(p)).resolves.toBe("appearance-btn");
      // Esc closes it, focus back on ◐ ▾ (a click never focused it).
      await btn.click();
      await menu.waitFor();
      await p.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      await expect(focused(p)).resolves.toBe("appearance-btn");
      await expect(btn.getAttribute("aria-expanded")).resolves.toBe("false");
      // A click on a theme picks it.
      await btn.click();
      await p.locator('.den-pop .den-mi[data-value="sea"]').click();
      await menu.waitFor({ state: "detached" });
      // ↑ on the button opens it on its last entry; a press outside closes it.
      await btn.focus();
      await p.keyboard.press("ArrowUp");
      await menu.waitFor();
      await expect(focused(p)).resolves.toBe("#all");
      await p.locator("#den-content").click({ position: { x: 600, y: 400 } });
      await menu.waitFor({ state: "detached" });
      expect((await log(p)).picks).toEqual([
        ["mode", "dark"],
        ["theme", "sea"],
      ]);
      await p.context().close();
    });

    it("the version chip's pip, and the update-waiting pill beside it", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      const pip = () =>
        p.evaluate(
          () => getComputedStyle(document.getElementById("v-pip")!).display,
        );
      await expect(pip()).resolves.toBe("none");
      await p.evaluate(() =>
        (
          window as unknown as {
            DenUI: { version: { unread(on: boolean): void } };
          }
        ).DenUI.version.unread(true),
      );
      await expect(pip()).resolves.toBe("block");
      await p.evaluate(() => {
        const w = window as unknown as {
          log: { waited: number };
          DenUI: { version: { waiting(o: object | null): void } };
        };
        w.DenUI.version.waiting({
          label: "stale server",
          action: "Restart",
          name: "Stale server: restart",
          title: "Restart it",
          onClick: () => w.log.waited++,
        });
      });
      await expect(
        p.evaluate(() => {
          const s = document.getElementById("stale-pill")!;
          return {
            after:
              document.getElementById("version-pill")!.nextElementSibling === s,
            text: s.textContent,
            name: s.getAttribute("aria-label"),
            shown: getComputedStyle(s).display !== "none",
          };
        }),
      ).resolves.toEqual({
        after: true,
        text: "⚠ stale server · Restart",
        name: "Stale server: restart",
        shown: true,
      });
      await p.locator("#stale-pill").click();
      expect((await log(p)).waited).toBe(1);
      await p.evaluate(() =>
        (
          window as unknown as {
            DenUI: { version: { waiting(o: null): void } };
          }
        ).DenUI.version.waiting(null),
      );
      await expect(
        p.evaluate(
          () =>
            getComputedStyle(document.getElementById("stale-pill")!).display,
        ),
      ).resolves.toBe("none");
      await p.context().close();
    });

    it("the mark's layout is the kit's: a flex box, its image a 22px block", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      const r = await p.evaluate(() => {
        const D = (
          window as unknown as {
            DenUI: { markHtml: (m: { src: string; label: string }) => string };
          }
        ).DenUI;
        document.getElementById("den-mark")!.outerHTML = D.markHtml({
          src: "/kit/marks/den.svg",
          label: "Den",
        });
        const m = document.getElementById("den-mark")!;
        const img = m.querySelector("img")!;
        const box = img.getBoundingClientRect();
        return [
          getComputedStyle(m).display,
          getComputedStyle(m).alignItems,
          getComputedStyle(img).display,
          Math.round(box.width),
          Math.round(box.height),
        ];
      });
      expect(r).toEqual(["flex", "center", "block", 22, 22]);
      await p.context().close();
    });

    it("a phone's top bar: a wide host chip never squeezes the brand's mark", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.setViewportSize({ width: 390, height: 844 });
      const r = await p.evaluate(() => {
        const chips = document.querySelector(".den-top .den-chips")!;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "den-chip";
        chip.textContent = "A host's very wide status chip, 12 of 12 up";
        // A host's chip that may give way (as Den's status chip does).
        chip.style.setProperty("min-width", "0");
        chip.style.setProperty("flex-shrink", "1");
        chip.style.setProperty("overflow", "hidden");
        chips.prepend(chip);
        const brand = document
          .querySelector(".den-brand")!
          .getBoundingClientRect();
        const mark = document
          .getElementById("den-mark")!
          .getBoundingClientRect();
        return {
          brand: brand.width,
          mark: mark.width,
          markRight: mark.right,
          brandRight: brand.right,
        };
      });
      expect(r.mark).toBeGreaterThan(0);
      expect(r.brand).toBeGreaterThanOrEqual(r.mark);
      expect(r.brandRight).toBeGreaterThanOrEqual(r.markRight);
      await p.context().close();
    });

    it("a phone's top bar: ☰, search, bell and ◐ ▾ are 32px tap targets, on one line", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.setViewportSize({ width: 390, height: 844 });
      const r = await p.evaluate(() =>
        ["#den-menu-btn", ".den-search", "#den-bell", "#appearance-btn"].map(
          (sel) => {
            const el = document.querySelector(sel)!;
            const c = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            return [
              sel,
              parseFloat(c.minHeight) >= 32 && box.height >= 32,
              parseFloat(c.minWidth) >= 32 && box.width >= 32,
              Math.round(box.top + box.height / 2),
            ];
          },
        ),
      );
      for (const [sel, tall, wide] of r)
        expect([sel, tall, wide]).toEqual([sel, true, true]);
      // All on the bar's middle line.
      expect(new Set(r.map((x) => x[3])).size).toBe(1);
      await p.context().close();
    });

    it("one key cap: Report's ⌘⇧F and search's ⌘K are the same .den-kbd cap", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      const caps = await p.evaluate(() => {
        const look = (el: Element | null) => {
          if (!el) return null;
          const c = getComputedStyle(el);
          return {
            h: Math.round(el.getBoundingClientRect().height),
            border: [
              c.borderTopWidth,
              c.borderRightWidth,
              c.borderBottomWidth,
              c.borderLeftWidth,
              c.borderTopStyle,
            ].join(" "),
            radius: c.borderTopLeftRadius,
            pad: c.paddingLeft + " " + c.paddingRight,
            bg: c.backgroundColor,
            surface: (() => {
              const t = document.createElement("i");
              t.style.setProperty("background", "var(--surface)");
              document.body.appendChild(t);
              const v = getComputedStyle(t).backgroundColor;
              t.remove();
              return v;
            })(),
          };
        };
        const extra = document.createElement("kbd");
        extra.className = "den-kbd";
        extra.textContent = "⌘J";
        document.body.appendChild(extra);
        return {
          report: look(document.querySelector(".den-top .den-rb kbd")),
          search: look(document.querySelector(".den-search kbd")),
          host: look(extra),
        };
      });
      for (const c of [caps.report, caps.search, caps.host]) {
        expect(c).not.toBeNull();
        expect(c!.border).toBe("1px 1px 2px 1px solid");
        expect(c!.radius).toBe("4px");
        expect(c!.pad).toBe("5px 5px");
        expect(c!.bg).toBe(c!.surface);
      }
      expect(caps.report!.h).toBe(caps.search!.h);
      await p.context().close();
    });

    it('a rail group\'s heading is as tall with its "from" tag as without', async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, "?bare");
      const hs = await p.evaluate(() => {
        const D = (
          window as unknown as {
            DenUI: { shellHtml: (m: unknown) => string };
          }
        ).DenUI;
        const box = document.createElement("div");
        box.innerHTML = D.shellHtml({
          product: { name: "Acme", version: "1.0.0" },
          groups: [
            { id: "a", label: "First" },
            { id: "b", label: "Second", from: "plugin" },
            { id: "c", label: "Third" },
          ],
          nav: ["a", "b", "c"].map((g) => ({
            id: "p" + g,
            label: "Page " + g,
            href: "#" + g,
            group: g,
            icon: "home",
          })),
        });
        document.body.appendChild(box);
        const measure = () =>
          [...box.querySelectorAll(".den-gh")].map((h) => [
            h.querySelector(".den-tagx") ? "tag" : "plain",
            h.getBoundingClientRect().height,
          ]);
        // The faces this machine has, then faces whose line is shorter
        // than the tag's box (as on a machine with other fonts): a mono
        // face with a small line, and a tiny one.
        const runs = [measure()];
        for (const css of [
          ".den-gh { font-family: monospace; line-height: 11px; }",
          ".den-gh { font-size: 7px; }",
        ]) {
          const st = document.createElement("style");
          st.textContent = css;
          document.head.appendChild(st);
          runs.push(measure());
          st.remove();
        }
        return runs;
      });
      // The tag never makes its heading taller: the heading is the plain
      // one's height (32px in Den's fonts), whatever the faces measure.
      for (const run of hs) {
        expect(run.map((h) => h[0])).toEqual(["plain", "tag", "plain"]);
        expect(run[1]![1]).toBe(run[2]![1]);
      }
      await p.context().close();
    });

    it("Settings in the rail's foot, then the account entry, then Collapse", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await expect(
        p.evaluate(() => {
          const rail = document.querySelector(".den-rail")!;
          const grow = rail.querySelector(".den-rail-grow")!;
          const foot: string[] = [];
          for (let e = grow.nextElementSibling; e; e = e.nextElementSibling)
            foot.push(
              (e.getAttribute("data-nav") || e.getAttribute("data-act") || "") +
                ":" +
                e.textContent,
            );
          return {
            foot,
            href: rail
              .querySelector('[data-nav="settings"]')
              ?.getAttribute("href"),
          };
        }),
      ).resolves.toEqual({
        foot: [
          "settings:Settings",
          "account:Ada Lovelace@ada",
          "collapse:Collapse",
        ],
        href: "#settings",
      });
      await p.context().close();
      const q = await open(b, "?bare");
      await expect(
        q.evaluate(() =>
          ['[data-nav="settings"]', ".appearance-btn", "#stale-pill"].map(
            (s) => document.querySelectorAll(s).length,
          ),
        ),
      ).resolves.toEqual([0, 0, 0]);
      await q.context().close();
    });

    it("the account entry's menu: who, where, and Sign out as a form post; Esc and focus back", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, "?acctmenu");
      const btn = p.locator(".den-rail [data-den-account]");
      await expect(btn.evaluate((e) => e.tagName)).resolves.toBe("BUTTON");
      await expect(btn.getAttribute("aria-haspopup")).resolves.toBe("menu");
      await expect(btn.getAttribute("aria-expanded")).resolves.toBe("false");
      await btn.click();
      await expect(btn.getAttribute("aria-expanded")).resolves.toBe("true");
      const menu = p.locator("#den-account-menu");
      await expect(menu.getAttribute("role")).resolves.toBe("menu");
      // Who is signed in and where, then a rule, then the entries.
      await expect(
        menu.evaluate((m) =>
          [...m.children].map((c) =>
            c.tagName === "FORM"
              ? `form ${c.getAttribute("method")} ${c.getAttribute("action")}: ${(c as HTMLFormElement).elements.namedItem("csrf") ? "csrf" : "-"} | ${c.textContent}`
              : `${c.className}: ${c.textContent}`,
          ),
        ),
      ).resolves.toEqual([
        // Drawn as the rail's entry is: the name, then @login.
        "den-ml den-acct: Ada Lovelace@ada",
        "den-hr: ",
        "den-mi: Sessions",
        "form post /out: csrf | Sign out",
      ]);
      // Opened by a click: focus on its first entry, and ↓ moves on.
      await expect(focused(p)).resolves.toBe("#sessions");
      await p.keyboard.press("ArrowDown");
      await expect(
        p.evaluate(() => document.activeElement?.textContent),
      ).resolves.toBe("Sign out");
      // Esc closes it; focus goes back to the entry.
      await p.keyboard.press("Escape");
      await expect(menu.count()).resolves.toBe(0);
      await expect(btn.getAttribute("aria-expanded")).resolves.toBe("false");
      await expect(focused(p)).resolves.toBe("den-account");
      // A press outside closes it.
      await btn.click();
      await expect(menu.count()).resolves.toBe(1);
      await p.mouse.click(900, 500);
      await expect(menu.count()).resolves.toBe(0);
      // Sign out posts the form, with no script of the host's.
      posts.length = 0;
      await btn.focus();
      await p.keyboard.press("Enter");
      await p.keyboard.press("End");
      await Promise.all([p.waitForURL(/\/out$/), p.keyboard.press("Enter")]);
      expect(posts).toEqual(["POST csrf=tok-1"]);
      await p.context().close();
    });

    it("a crumb's long menu filters as you type: ↓ and Enter work, Esc clears then closes", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, "?many");
      const ws = p.locator("#den-scope-ws");
      const menu = p.locator("#den-scope-ws-menu");
      const field = menu.locator("input.den-mfilter");
      const shown = () =>
        menu.evaluate((m) =>
          [...m.querySelectorAll<HTMLElement>(".den-mi")]
            .filter((a) => !a.hidden && a.offsetParent !== null)
            .map((a) => a.textContent),
        );
      await ws.click();
      // More than 6 entries: the field is first, and has the focus.
      await expect(field.count()).resolves.toBe(1);
      await expect(
        menu.evaluate((m) => m.firstElementChild?.matches("input.den-mfilter")),
      ).resolves.toBe(true);
      await expect(field.getAttribute("type")).resolves.toBe("search");
      await expect(field.getAttribute("aria-label")).resolves.toBe(
        "Filter Project",
      );
      await expect(focused(p)).resolves.toBe("den-scope-ws-menu-filter");
      // The field looks like the host's menu fields.
      await expect(
        field.evaluate((e) => {
          const c = getComputedStyle(e);
          return [
            c.borderTopStyle,
            c.borderTopWidth,
            c.paddingTop,
            c.paddingLeft,
          ];
        }),
      ).resolves.toEqual(["solid", "1px", "6px", "8px"]);
      await p.keyboard.type("r");
      await expect(shown()).resolves.toEqual([
        "Garden",
        "Orchard",
        "Forest",
        "River",
        "Harbor",
        "Ridge",
      ]);
      await p.keyboard.type("iv");
      await expect(shown()).resolves.toEqual(["River"]);
      // ↓ goes to the first entry shown; ↑ from it, back to the field.
      await p.keyboard.press("ArrowDown");
      await expect(focused(p)).resolves.toBe("#river");
      await p.keyboard.press("ArrowUp");
      await expect(focused(p)).resolves.toBe("den-scope-ws-menu-filter");
      // Nothing matches: a line says so.
      await p.keyboard.type("zz");
      await expect(shown()).resolves.toEqual([]);
      await expect(
        menu.locator(".den-mnote:not([hidden])").textContent(),
      ).resolves.toBe("No match");
      // Esc clears the field first, and the menu stays.
      await p.keyboard.press("Escape");
      await expect(field.inputValue()).resolves.toBe("");
      await expect(menu.isVisible()).resolves.toBe(true);
      await expect(shown()).resolves.toHaveLength(8);
      // Esc again closes it; focus goes back to the crumb.
      await p.keyboard.press("Escape");
      await expect(menu.isVisible()).resolves.toBe(false);
      await expect(focused(p)).resolves.toBe("den-scope-ws");
      // Enter takes the first entry shown.
      await ws.click();
      await p.keyboard.type("orch");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => location.hash === "#orchard");
      await p.context().close();
    });

    it("the filter: on past 6 entries by default; a number sets the threshold; false turns it off", async () => {
      const b = browsers[engine];
      if (!b) return;
      const count = async (q: string) => {
        const p = await open(b, q);
        const n = await p
          .locator("#den-scope-ws-menu input.den-mfilter")
          .count();
        await p.context().close();
        return n;
      };
      // Two entries: none. Eight: one. A threshold of 1 on two: one.
      await expect(count("")).resolves.toBe(0);
      await expect(count("?many")).resolves.toBe(1);
      await expect(count("?filter=1")).resolves.toBe(1);
      await expect(count("?many&filter=10")).resolves.toBe(0);
      await expect(count("?many&nofilter")).resolves.toBe(0);
    });

    it("a filtered menu passes axe: the field sits beside the role=menu list, never in it (kit and host menus)", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, "?many");
      await p.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
      const axeOn = (sel: string) =>
        p.evaluate(async (s) => {
          const axe = (
            window as unknown as {
              axe: {
                run: (
                  el: Element,
                  o: unknown,
                ) => Promise<{ violations: { id: string }[] }>;
              };
            }
          ).axe;
          const r = await axe.run(document.querySelector(s)!, {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "best-practice"],
            },
          });
          return r.violations.map((v) => v.id);
        }, sel);
      // A crumb's 8 entries, open.
      await p.locator("#den-scope-ws").click();
      await expect(
        p.locator("#den-scope-ws-menu input.den-mfilter").count(),
      ).resolves.toBe(1);
      await expect(axeOn("#den-scope-ws-menu")).resolves.toEqual([]);
      // The field names the list it filters.
      const list = await p
        .locator("#den-scope-ws-menu input.den-mfilter")
        .getAttribute("aria-controls");
      await expect(p.locator(`#${list}`).getAttribute("role")).resolves.toBe(
        "menu",
      );
      await p.keyboard.press("Escape");
      // A host's own menu through attachMenuFilter.
      await p.evaluate(() =>
        (window as unknown as { hostMenu: () => void }).hostMenu(),
      );
      await expect(axeOn("#host-menu")).resolves.toEqual([]);
      await p.context().close();
    });

    it("a host's own menu gets the same filter (attachMenuFilter)", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.evaluate(() =>
        (window as unknown as { hostMenu: () => void }).hostMenu(),
      );
      const menu = p.locator("#host-menu");
      await expect(focused(p)).resolves.toBe("host-menu-filter");
      await expect(
        menu.locator("input.den-mfilter").getAttribute("aria-label"),
      ).resolves.toBe("Filter Things");
      await p.keyboard.type("eta");
      await expect(
        menu.evaluate((m) =>
          [...m.querySelectorAll<HTMLElement>(".den-mi")]
            .filter((x) => !x.hidden)
            .map((x) => x.textContent),
        ),
      ).resolves.toEqual(["Beta", "Zeta", "Eta"]);
      // Esc clears first, and the host's own Esc does not run.
      await p.keyboard.press("Escape");
      await expect(
        menu.locator("input.den-mfilter").inputValue(),
      ).resolves.toBe("");
      await expect(menu.count()).resolves.toBe(1);
      // Esc again: the host's onClose, not its own key.
      await p.keyboard.press("Escape");
      await expect(menu.count()).resolves.toBe(0);
      await expect(focused(p)).resolves.toBe("host-btn");
      // Enter takes the first shown.
      await p.evaluate(() =>
        (window as unknown as { hostMenu: () => void }).hostMenu(),
      );
      await p.keyboard.type("gam");
      await p.keyboard.press("Enter");
      await expect(
        p.evaluate(
          () => (window as unknown as { log: { picks: unknown[] } }).log.picks,
        ),
      ).resolves.toEqual([["closed"], ["host", "Gamma"]]);
      await p.context().close();
    });
  });

  // issue 303: the search sits in a fixed slot, the same in every product,
  // whatever the host's words or chips; Report, the bell, the version and
  // ◐ stay pinned to the right edge; the crumbs give way first (the last
  // one kept), then the install name; nothing overflows the bar.
  describe(`issue 303 the search's fixed slot (${engine})`, () => {
    const measure = (p: Page) =>
      p.evaluate(() => {
        const r = (sel: string) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          const b = e.getBoundingClientRect();
          return [Math.round(b.x * 10) / 10, Math.round(b.width * 10) / 10];
        };
        const top = document.querySelector<HTMLElement>(".den-top")!;
        const crumbs = [
          ...top.querySelectorAll<HTMLElement>(".den-scope .den-vn"),
        ].filter((e) => e.getClientRects().length);
        const last = crumbs[crumbs.length - 1];
        const longCut = crumbs.some((e) => e.scrollWidth > e.clientWidth + 1);
        const ic = top.querySelector(".den-search-ic")!.getBoundingClientRect();
        const first = top.querySelector(
          ".den-chips > *:not(.den-end), .den-end > *",
        );
        const chipX = [...top.querySelectorAll<HTMLElement>(".den-chips *")]
          .filter(
            (e) =>
              e.getClientRects().length && e.getBoundingClientRect().width > 0,
          )
          .map((e) => e.getBoundingClientRect().x);
        const title = top.querySelector<HTMLElement>(".den-title")!;
        return {
          search: r(".den-search"),
          report: r(".den-rb-top"),
          bell: r("#den-bell"),
          version: r("#version-pill"),
          appearance: r("#appearance-btn"),
          overflow: top.scrollWidth > top.clientWidth + 1,
          // The gap from ⌕ to the first chip after it.
          gap: Math.round(Math.min(...chipX) - ic.right),
          firstChip: !!first,
          lastCrumb: last
            ? {
                shown: last.getBoundingClientRect().width > 0,
                cut: last.scrollWidth > last.clientWidth + 1,
                ellipsis: getComputedStyle(last).textOverflow,
              }
            : null,
          titleCut: title.scrollWidth > title.clientWidth + 1,
          longCut,
        };
      });

    it("at 1280 the search is at 464, 304 wide, with short or long names and with or without host chips", async () => {
      const b = browsers[engine];
      if (!b) return;
      const got: Record<string, Awaited<ReturnType<typeof measure>>> = {};
      for (const q of [
        "",
        "?long",
        "?chips",
        "?long&chips",
        "?long&longname",
      ]) {
        const p = await open(b, q, 1280);
        got[q || "short"] = await measure(p);
        await p.context().close();
      }
      for (const [k, m] of Object.entries(got)) {
        expect([k, m.search]).toEqual([k, [464, 304]]);
        // Pinned right: where the short names put them.
        for (const it of ["report", "bell", "version", "appearance"] as const)
          expect([k, it, m[it]]).toEqual([k, it, got.short![it]]);
        expect([k, m.overflow]).toEqual([k, false]);
        // A visible gap between ⌕ and the first chip.
        expect(m.gap).toBeGreaterThanOrEqual(12);
      }
      // Long names: the last crumb is kept whole; a long one before it
      // ends in an ellipsis.
      for (const k of ["?long", "?long&chips"])
        expect([k, got[k]!.lastCrumb]).toEqual([
          k,
          { shown: true, cut: false, ellipsis: "ellipsis" },
        ]);
      expect([got["?long"]!.longCut, got.short!.longCut]).toEqual([
        true,
        false,
      ]);
    });

    it("narrower than the left part, the search and the kit's buttons need: the chips never run under the search", async () => {
      const b = browsers[engine];
      if (!b) return;
      for (const w of [1280, 1100, 960, 800])
        for (const q of ["?chips", "?long&chips&longver", "?longver"]) {
          const p = await open(b, q, w);
          const m = await measure(p);
          await p.context().close();
          // ⌕ to the first chip: a clear gap, never an overlap.
          expect([w, q, m.gap >= 12]).toEqual([w, q, true]);
          expect([w, q, m.overflow]).toEqual([w, q, false]);
        }
    });

    it("at 390 the search sits at the same x, short or long names, with or without host chips", async () => {
      const b = browsers[engine];
      if (!b) return;
      const got: Record<string, Awaited<ReturnType<typeof measure>>> = {};
      for (const q of ["", "?long", "?chips", "?long&chips"]) {
        const p = await open(b, q, 390);
        got[q || "short"] = await measure(p);
        await p.context().close();
      }
      const at = got.short!.search;
      expect(at![0]).toBe(82);
      for (const q of ["?long", "?chips", "?long&chips"]) {
        expect([q, got[q]!.search]).toEqual([q, at]);
        expect([q, got[q]!.overflow]).toEqual([q, false]);
        expect(got[q]!.gap).toBeGreaterThanOrEqual(8);
      }
    });
  });

  // Issue 303: on a touch screen every top-bar control takes a 44px tap
  // (an ::after hit area: the look is the same) and the key hints hide.
  describe(`issue 303 touch targets (${engine})`, () => {
    // The kit's two touch rules for any host element: .den-hit (a 44px
    // tap on touch, nothing without) and .den-kbd (hidden on touch).
    const hostTouch = (p: Page) =>
      p.evaluate(() => {
        const main = document.getElementById("den-content")!;
        main.insertAdjacentHTML(
          "beforeend",
          '<p style="padding:40px"><button type="button" class="den-hit" id="hh" style="font-size:12px;padding:2px 4px">x</button> <kbd class="den-kbd" id="hk">⌘J</kbd></p>',
        );
        const b = document.getElementById("hh")!;
        const r = b.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const edges = [
          [cx, cy - 21],
          [cx, cy + 21],
          [cx - 21, cy],
          [cx + 21, cy],
        ].map(
          ([x, y]) => document.elementFromPoint(x!, y!)?.closest("#hh") != null,
        );
        const k = document.getElementById("hk")!;
        return {
          small: r.width < 44 && r.height < 44,
          box: [Math.round(r.width), Math.round(r.height)],
          edges,
          kbd: k.getClientRects().length > 0,
        };
      });

    it("a host's .den-hit takes a 44px tap on touch and none without; a host's .den-kbd hides on touch", async () => {
      const b = browsers[engine];
      if (!b) return;
      const t = await open(b, "", 390, engine === "webkit");
      const onTouch = await hostTouch(t);
      await t.context().close();
      const m = await open(b, "", 390, false);
      const noTouch = await hostTouch(m);
      await m.context().close();
      expect(noTouch.small).toBe(true);
      expect(noTouch.edges).toEqual([false, false, false, false]);
      expect(noTouch.kbd).toBe(true);
      if (engine !== "webkit") return;
      // Same look: the button's own box is unchanged.
      expect(onTouch.box).toEqual(noTouch.box);
      expect(onTouch.edges).toEqual([true, true, true, true]);
      expect(onTouch.kbd).toBe(false);
    });

    it("at 390 on touch: every bar control's hit box is 44×44, no key hint shows, and the bar looks the same", async () => {
      const b = browsers[engine];
      if (!b || engine !== "webkit") return;
      const t = await open(b, "?chips", 390, true);
      const touchOn = await t.evaluate(
        () => matchMedia("(pointer: coarse)").matches,
      );
      expect(touchOn).toBe(true);
      const got = await t.evaluate(() => {
        const top = document.querySelector<HTMLElement>(".den-top")!;
        const controls = [
          ...top.querySelectorAll<HTMLElement>("button, a[href]"),
        ].filter(
          (e) =>
            e.getClientRects().length && e.getBoundingClientRect().width > 0,
        );
        const box44 = (e: HTMLElement) => {
          const r = e.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const hx = Math.max(44, r.width) / 2 - 1;
          const hy = Math.max(44, r.height) / 2 - 1;
          return { cx, cy, hx, hy };
        };
        const inBox = (e: HTMLElement, x: number, y: number) => {
          const { cx, cy, hx, hy } = box44(e);
          return Math.abs(x - cx) <= hx + 1 && Math.abs(y - cy) <= hy + 1;
        };
        const misses: string[] = [];
        for (const c of controls) {
          const { cx, cy, hx, hy } = box44(c);
          for (const [x, y] of [
            [cx, cy - hy],
            [cx, cy + hy],
            [cx - hx, cy],
            [cx + hx, cy],
          ]) {
            const hit = document.elementFromPoint(x, y) as HTMLElement | null;
            const owner =
              hit?.closest<HTMLElement>(".den-top button, .den-top a[href]") ??
              null;
            if (owner === c) continue;
            // Where two neighbours' 44px boxes overlap, either may take it.
            if (owner && controls.includes(owner) && inBox(owner, x, y))
              continue;
            misses.push(
              `${c.id || c.className} at ${Math.round(x)},${Math.round(y)} hit ${owner?.id || owner?.className || hit?.tagName}`,
            );
          }
        }
        const kbd = [
          ...top.querySelectorAll<HTMLElement>("kbd, .den-kbd"),
        ].filter(
          (e) =>
            e.getClientRects().length && e.getBoundingClientRect().width > 0,
        ).length;
        return { n: controls.length, misses, kbd };
      });
      expect(got.n).toBeGreaterThanOrEqual(5);
      expect(got.misses).toEqual([]);
      expect(got.kbd).toBe(0);
      const touchShot = await t.locator(".den-top").screenshot();
      await t.context().close();
      // The same bar without touch, its key hints hidden: the same pixels.
      const m = await open(b, "?chips", 390, false);
      await m.addStyleTag({
        content:
          ".den-top kbd, .den-top .den-kbd { display: none !important; }",
      });
      const mouseShot = await m.locator(".den-top").screenshot();
      await m.context().close();
      expect(touchShot.equals(mouseShot)).toBe(true);
    });
  });
}
