/**
 * The rail (0.3.0-dev.17; R11, R11a, R12, R13, R14) in a real browser:
 * shell.js mounted on a bare page served by a stub origin, so the test
 * sees exactly what the registry renders.
 *
 * - groups in GROUPS order with their headings, each Den page in its
 *   spec group (Develop / Verify / Ship), Settings and the collapse button
 *   last;
 * - Pinned first, from the prefs (`/api/settings` shell.pins), with a dot
 *   from the shared rollup;
 * - a distribution's group and page, registered at runtime, in order and
 *   tagged;
 * - badges from state (Services: down services, bad; Logs: open streams);
 * - one tab stop (the current page); collapse keeps the headings for
 *   screen readers and saves the pref.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";

const SHELL = fs.readFileSync(
  path.join(process.cwd(), "src", "ui", "server", "public", "shell.js"),
  "utf-8",
);
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** A page on a stub origin with the shell for `page`; records POSTs. */
async function mount(
  page: string,
  settings: unknown = { shell: { pins: [], collapsed: false } },
  opts: { before?: string; after?: string } = {},
): Promise<{ p: Page; posts: unknown[]; warnings: string[] }> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 800 },
  });
  const p = await ctx.newPage();
  const posts: unknown[] = [];
  const warnings: string[] = [];
  p.on("console", (m) => {
    if (m.type() === "warning") warnings.push(m.text());
  });
  await p.route("http://den.test/**", async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === "/shell.js")
      return r.fulfill({
        contentType: "text/javascript; charset=utf-8",
        body: SHELL,
      });
    if (url.pathname === "/api/settings") {
      if (r.request().method() === "POST")
        posts.push(JSON.parse(r.request().postData() ?? "null"));
      return r.fulfill({ json: settings });
    }
    return r.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><style>:root { --mono: monospace; --sans: sans-serif; --display: sans-serif; }</style></head><body>${opts.before ?? ""}<div id="den-shell" data-page="${page}"></div><script src="/shell.js"></script><main id="den-content">page${opts.after ?? ""}</main></body></html>`,
    });
  });
  await p.goto("http://den.test/x");
  await p.waitForSelector(".den-rail .den-ni");
  return { p, posts, warnings };
}

const rail = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll(".den-rail > *")].map((g) =>
      g.classList.contains("den-rail-group")
        ? {
            heading: g.querySelector(".den-gh > span")?.textContent,
            tag: g.querySelector(".den-tagx")?.textContent ?? null,
            items: [...g.querySelectorAll(".den-ni")].map(
              (a) => (a as HTMLElement).dataset.nav,
            ),
          }
        : ((g as HTMLElement).dataset.nav ??
          (g as HTMLElement).dataset.act ??
          g.className),
    ),
  );

describe("the rail", () => {
  it("renders the groups in order, each Den page in its spec group", async () => {
    if (!browser) return;
    const { p } = await mount("tests");
    expect(await rail(p)).toEqual([
      {
        heading: "Develop",
        tag: null,
        items: ["local-dev", "graph", "agents", "services", "logs"],
      },
      { heading: "Verify", tag: null, items: ["tests"] },
      { heading: "Ship", tag: null, items: ["environments", "release"] },
      "den-rail-grow",
      "settings",
      "collapse",
    ]);
    // Each group is named for assistive tech by its heading.
    expect(
      await p.getAttribute(
        '[role="group"][aria-labelledby="den-gh-verify"]',
        "aria-labelledby",
      ),
    ).toBe("den-gh-verify");
    expect(await p.getAttribute('[data-nav="tests"]', "aria-current")).toBe(
      "page",
    );
    expect(await p.getAttribute('[data-nav="settings"]', "href")).toBe(
      "/settings",
    );
    await p.context().close();
  });

  it("shows Pinned first, from the prefs, with dots from the shared rollup", async () => {
    if (!browser) return;
    const { p } = await mount("services", {
      shell: { pins: ["shop", "billing/api"], collapsed: false },
    });
    await p.waitForSelector('[data-pin="billing/api"]');
    const groups = await rail(p);
    expect(groups[0]).toEqual({
      heading: "Pinned",
      tag: null,
      items: ["pin-shop", "pin-billing/api"],
    });
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { setState(s: unknown): void } }
      ).denShell.setState({
        health: { shop: "ok", "billing/api": "down" },
      }),
    );
    expect(
      await p.$$eval(".den-ni[data-pin] .den-dot", (d) =>
        d.map((e) => e.className),
      ),
    ).toEqual(["den-dot", "den-dot bad"]);
    expect(await p.getAttribute('[data-pin="shop"]', "href")).toBe(
      "/services#repo-shop",
    );
    await p.context().close();
  });

  it("adds a distribution's group and page where its order puts them, tagged", async () => {
    if (!browser) return;
    const { p } = await mount("services");
    await p.evaluate(() => {
      const sh = (
        window as unknown as {
          denShell: {
            addMessages(l: string, m: Record<string, string>): void;
            registerGroup(g: unknown): void;
            registerNav(n: unknown): void;
          };
        }
      ).denShell;
      sh.addMessages("en", { "g.acme": "Acme", "n.edge": "Edge routes" });
      sh.registerGroup({
        id: "acme",
        label: "g.acme",
        order: 40,
        from: "acme",
      });
      sh.registerNav({
        id: "edge",
        label: "n.edge",
        group: "acme",
        order: 10,
        href: "/p/edge",
      });
      sh.registerNav({
        id: "early",
        label: "Early",
        group: "acme",
        order: 5,
        href: "/p/early",
      });
      sh.registerGroup({ id: "first", label: "First", order: 5 });
      sh.registerNav({
        id: "one",
        label: "One",
        group: "first",
        order: 1,
        href: "/p/one",
      });
    });
    const groups = (await rail(p)) as {
      heading: string;
      tag: string | null;
      items: string[];
    }[];
    expect(groups.slice(0, 5).map((g) => [g.heading, g.tag, g.items])).toEqual([
      ["First", null, ["one"]],
      ["Develop", null, ["local-dev", "graph", "agents", "services", "logs"]],
      ["Verify", null, ["tests"]],
      ["Ship", null, ["environments", "release"]],
      ["Acme", "acme", ["early", "edge"]],
    ]);
    await p.context().close();
  });

  it("badges: Services counts down services (bad), Logs open streams", async () => {
    if (!browser) return;
    const { p } = await mount("logs");
    expect(await p.$$(".den-bdg")).toHaveLength(0);
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { setState(s: unknown): void } }
      ).denShell.setState({
        down: 2,
        openLogs: 3,
      }),
    );
    expect(
      await p.$eval('[data-nav="services"] .den-bdg', (e) => [
        e.className,
        e.textContent,
      ]),
    ).toEqual(["den-bdg bad", "2"]);
    expect(await p.getAttribute('[data-nav="services"]', "aria-label")).toBe(
      "Services, 2 down",
    );
    expect(
      await p.$eval('[data-nav="logs"] .den-bdg', (e) => [
        e.className,
        e.textContent,
      ]),
    ).toEqual(["den-bdg", "3"]);
    expect(await p.getAttribute('[data-nav="logs"]', "aria-label")).toBe(
      "Logs, 3 open",
    );
    await p.context().close();
  });

  it("is one tab stop, on the current page; the arrows move it", async () => {
    if (!browser) return;
    const { p } = await mount("environments", {
      shell: { pins: ["shop"], collapsed: false },
    });
    await p.waitForSelector('[data-pin="shop"]');
    const stops = () =>
      p.$$eval('.den-rail [tabindex="0"]', (e) =>
        e.map((x) => (x as HTMLElement).dataset.nav),
      );
    expect(await stops()).toEqual(["environments"]);
    // Tab from the skip link lands on the current page, not the first item.
    await p.focus("#version-pill").catch(() => {});
    await p.focus(".den-skip");
    for (let i = 0; i < 20; i++) {
      await p.keyboard.press("Tab");
      if (
        await p.evaluate(() => !!document.activeElement?.closest(".den-rail"))
      )
        break;
    }
    expect(
      await p.evaluate(
        () => (document.activeElement as HTMLElement).dataset.nav,
      ),
    ).toBe("environments");
    await p.keyboard.press("ArrowDown");
    expect(await stops()).toEqual(["release"]);
    await p.keyboard.press("Home");
    expect(
      await p.evaluate(
        () => (document.activeElement as HTMLElement).dataset.nav,
      ),
    ).toBe("pin-shop");
    await p.context().close();
  });

  it("collapses to icons, keeps the headings for screen readers, and saves the pref", async () => {
    if (!browser) return;
    const { p, posts } = await mount("services");
    await p.click('[data-act="collapse"]');
    expect(
      await p.evaluate(() =>
        document.body.classList.contains("den-rail-collapsed"),
      ),
    ).toBe(true);
    // The heading (its label span names the group).
    const gh = await p.$eval("#den-gh-develop", (label) => {
      const e = label.closest(".den-gh") as HTMLElement;
      const cs = getComputedStyle(e);
      return {
        display: cs.display,
        width: e.getBoundingClientRect().width,
        text: e.textContent,
      };
    });
    expect(gh.display).not.toBe("none");
    expect(gh.width).toBeLessThanOrEqual(1);
    expect(gh.text).toBe("Develop");
    // 56px content + 8px padding each side (+ the 1px border, which needs
    // the theme's --border; this bare page has no theme).
    expect(
      await p.$eval(".den-rail", (e) => e.getBoundingClientRect().width),
    ).toBeGreaterThanOrEqual(72);
    await p.waitForTimeout(50);
    expect(posts).toContainEqual({ shell: { collapsed: true } });
    await p.context().close();
  });

  it("pins and unpins: prefs only, with the toast", async () => {
    if (!browser) return;
    const { p, posts } = await mount("services");
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { pin(id: string): void } }
      ).denShell.pin("shop"),
    );
    expect(await p.textContent(".den-toast")).toBe("Pinned shop");
    await p.waitForSelector('[data-pin="shop"]');
    await p.click('[data-unpin="shop"]', { force: true });
    expect(await p.$$('[data-pin="shop"]')).toHaveLength(0);
    await p.waitForTimeout(50);
    expect(posts).toEqual([
      { shell: { pins: ["shop"] } },
      { shell: { pins: [] } },
    ]);
    await p.context().close();
  });
});

describe("the top bar's scope", () => {
  it("names the org as the prototype does: brand / ORG name / WORKSPACE / ENV", async () => {
    if (!browser) return;
    const { p } = await mount("services");
    // Unknown until header.js reports it: no empty part, no stray "/".
    expect(await p.isVisible("#org-crumb")).toBe(false);
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { setOrg: (o: unknown) => void } }
      ).denShell.setOrg({ id: "acme", title: "Acme Corp" }),
    );
    const parts = await p.evaluate(() =>
      [...document.querySelectorAll(".den-top .den-scope > *")]
        .filter(
          (el) =>
            (el as HTMLElement).offsetParent !== null || el.id === "ws-pill",
        )
        .map((el) =>
          el.classList.contains("den-sep")
            ? "/"
            : el.id === "org-crumb"
              ? `${el.querySelector(".den-k")?.textContent}:${el.querySelector(".den-org-name")?.textContent}`
              : el.id || el.className,
        ),
    );
    expect(parts.slice(0, 3)).toEqual(["/", "Org:Acme Corp", "/"]);
    // The brand precedes the scope; nothing before the product name.
    const brand = await p.evaluate(
      () =>
        document.querySelector(".den-top .den-brand")?.previousElementSibling
          ?.id,
    );
    expect(brand).toBe("den-menu-btn");
    expect(await p.getAttribute("#org-crumb", "title")).toBe(
      "Org: Acme Corp (acme)",
    );
    await p.context().close();
  });
});

// ── 0.3.0-dev.18 ─────────────────────────────────────────────────────────

type Shell = {
  setOrg(o: unknown): boolean;
  setOrgs(
    list: unknown[],
    cur: string,
    onSelect?: (id: string) => void,
  ): boolean;
  setWorkspaces(m: unknown): void;
  syncEnv(): void;
  pin(id: string): void;
  unpin(id: string): void;
  isPinned(id: string): boolean;
  registerGroup(g: unknown): void;
  registerNav(n: unknown): void;
};
const shell = (p: Page, fn: string, ...args: unknown[]) =>
  p.evaluate(
    ({ fn, args }) =>
      (
        (window as unknown as { denShell: Record<string, unknown> }).denShell[
          fn
        ] as (...a: unknown[]) => unknown
      )(...args),
    { fn, args },
  );
/** Stub the Workspace menu as header.js feeds it; records picks. */
async function stubWorkspaces(p: Page, items: unknown[], extra = {}) {
  await p.evaluate(
    ({ items, extra }) => {
      const w = window as unknown as {
        denShell: Shell;
        picked: string[];
        focused: string[];
      };
      w.picked = [];
      w.focused = [];
      w.denShell.setWorkspaces({
        label: "All active",
        title: "View",
        items,
        ...extra,
        // onSelect(value, focus): header.js makes a workspace the CLI
        // default too (0.4.11); the shell passes the current focus.
        onSelect: (v: string, f: string | null) => {
          w.picked.push(v);
          w.focused.push(String(f));
        },
      });
    },
    { items, extra },
  );
}
const visibleScope = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll(".den-top .den-scope > *")]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) =>
        el.classList.contains("den-sep")
          ? "/"
          : `${el.tagName === "BUTTON" ? "button" : "label"}:${el.textContent?.replace(/\s+/g, " ").trim()}`,
      ),
  );
const menuRows = (p: Page) =>
  p.$$eval(".den-pop .den-mi", (rows) =>
    rows.map((r) => ({
      text: r.textContent,
      role: r.getAttribute("role"),
      checked: r.getAttribute("aria-checked"),
    })),
  );
const focusedText = (p: Page) =>
  p.evaluate(() => document.activeElement?.textContent ?? "");

describe("the scope breadcrumb (R4)", () => {
  it("reads / ORG <org> / WORKSPACE <ws> ▾ / ENV <env> ▾, the org static with one org and one workspace", async () => {
    if (!browser) return;
    const { p } = await mount("services");
    await shell(p, "setOrg", { id: "acme", title: "Acme Corp" });
    await stubWorkspaces(
      p,
      [{ value: "solo", label: "solo", checked: true, focused: true }],
      { label: "solo" },
    );
    // The org part is outside anything that hides: visible with a single
    // active workspace (ORG-SPEC C4), static, no ▾.
    expect(await visibleScope(p)).toEqual([
      "/",
      "label:Org Acme Corp",
      "/",
      "button:Workspace solo ▾",
      "/",
      "button:Env local ▾",
    ]);
    // Each part is the prototype's .ib with an 11px mono uppercase .k.
    for (const sel of ["#ws-pill", "#env-btn"]) {
      expect(await p.getAttribute(sel, "aria-haspopup")).toBe("menu");
      expect(await p.getAttribute(sel, "aria-expanded")).toBe("false");
      expect(
        await p.$eval(`${sel} .den-k`, (k) => {
          const cs = getComputedStyle(k);
          return [cs.fontSize, cs.textTransform, cs.letterSpacing];
        }),
      ).toEqual(["11px", "uppercase", "0.66px"]);
      expect(
        await p.$eval(sel, (b) => [
          b.classList.contains("den-ib"),
          getComputedStyle(b).fontSize,
        ]),
      ).toEqual([true, "13px"]);
    }
    expect(await p.$$("#org-crumb[aria-haspopup]")).toHaveLength(0);
    expect(await p.$$("#scope-sel, #scope-wrap, .ws-menu")).toHaveLength(0);
    await p.context().close();
  });

  it("Workspace ▾: All active and the active workspaces, focus marked; no separate CLI-default item", async () => {
    if (!browser) return;
    const { p } = await mount("services");
    await stubWorkspaces(
      p,
      [
        {
          value: "all",
          label: "All active (2)",
          checked: false,
          focused: false,
        },
        { value: "ws-a", label: "ws-a", checked: false, focused: true },
        { value: "ws-b", label: "ws-b", checked: true, focused: false },
      ],
      { label: "ws-b", focus: "ws-a" },
    );
    await p.click("#ws-pill");
    expect(await p.getAttribute("#ws-pill", "aria-expanded")).toBe("true");
    const pop = await p.$eval(".den-pop", (e) => {
      const cs = getComputedStyle(e);
      return {
        role: e.getAttribute("role"),
        radius: cs.borderTopLeftRadius,
        label: e.querySelector(".den-ml")?.textContent,
        labelFont: getComputedStyle(e.querySelector(".den-ml")!).fontSize,
      };
    });
    expect(pop).toEqual({
      role: "menu",
      radius: "10px",
      label: "Workspace",
      labelFont: "11px",
    });
    expect(await menuRows(p)).toEqual([
      { text: "All active (2)", role: "menuitemradio", checked: "false" },
      { text: "ws-aCLI default", role: "menuitemradio", checked: "false" },
      { text: "ws-b", role: "menuitemradio", checked: "true" },
      { text: "Manage workspaces…", role: "menuitem", checked: null },
    ]);
    // ✓ on the checked row (R18), and focus starts there.
    expect(
      await p.$eval(
        '.den-pop [aria-checked="true"]',
        (e) => getComputedStyle(e, "::after").content,
      ),
    ).toBe('"✓" / ""'); // drawn, with no alt text: aria-checked says it
    expect(await focusedText(p)).toBe("ws-b");
    // ↑/↓ move (wrapping), Home and End.
    await p.keyboard.press("ArrowDown");
    expect(await focusedText(p)).toBe("Manage workspaces…");
    await p.keyboard.press("Home");
    expect(await focusedText(p)).toBe("All active (2)");
    await p.keyboard.press("ArrowUp");
    expect(await focusedText(p)).toBe("Manage workspaces…");
    // Escape closes and gives focus back to the button.
    await p.keyboard.press("Escape");
    expect(await p.$$(".den-pop")).toHaveLength(0);
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("ws-pill");
    expect(await p.getAttribute("#ws-pill", "aria-expanded")).toBe("false");
    // ↓ on the button opens it; Enter picks, with the current focus.
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("Home");
    await p.keyboard.press("Enter");
    expect(
      await p.evaluate(() => {
        const w = window as unknown as { picked: string[]; focused: string[] };
        return [w.picked, w.focused];
      }),
    ).toEqual([["all"], ["ws-a"]]);
    // A click outside closes.
    await p.click("#ws-pill");
    expect(await p.$$(".den-pop")).toHaveLength(1);
    await p.mouse.click(900, 600);
    expect(await p.$$(".den-pop")).toHaveLength(0);
    await p.context().close();
  });

  it("Env ▾ drives #env-sel: same options and value, and its change event", async () => {
    if (!browser) return;
    const { p } = await mount("services");
    await p.evaluate(() => {
      const sel = document.getElementById("env-sel") as HTMLSelectElement;
      sel.innerHTML =
        '<option value="local">local</option><option value="beta">beta</option>';
      sel.value = "beta";
      (window as unknown as { denShell: Shell }).denShell.syncEnv();
      (window as unknown as { changes: string[] }).changes = [];
      sel.addEventListener("change", () =>
        (window as unknown as { changes: string[] }).changes.push(sel.value),
      );
    });
    expect(await p.textContent("#env-btn")).toBe("Env beta ▾");
    await p.click("#env-btn");
    expect(await menuRows(p)).toEqual([
      { text: "local", role: "menuitemradio", checked: "false" },
      { text: "beta", role: "menuitemradio", checked: "true" },
    ]);
    await p.click('.den-pop .den-mi:has-text("local")');
    expect(
      await p.evaluate(() => [
        (document.getElementById("env-sel") as HTMLSelectElement).value,
        (window as unknown as { changes: string[] }).changes,
      ]),
    ).toEqual(["local", ["local"]]);
    expect(await p.textContent("#env-btn")).toBe("Env local ▾");
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("env-btn");
    await p.context().close();
  });

  it("Org ▾ opens only with two or more orgs (C4): a stubbed list, den:org on a pick", async () => {
    if (!browser) return;
    const { p } = await mount("services");
    await shell(p, "setOrgs", [{ id: "acme", title: "Acme" }], "acme");
    expect(
      await p.evaluate(() => document.getElementById("org-crumb")?.tagName),
    ).toBe("SPAN");
    expect(await p.textContent("#org-crumb")).toBe("Org Acme");
    await p.evaluate(() => {
      const w = window as unknown as { denShell: Shell; orgs: string[] };
      w.orgs = [];
      window.addEventListener("den:org", (e) =>
        w.orgs.push((e as CustomEvent).detail.id),
      );
      w.denShell.setOrgs(
        [
          { id: "acme", title: "Acme", workspaces: 3 },
          { id: "globex", title: "Globex", workspaces: 1 },
        ],
        "acme",
      );
    });
    expect(await p.getAttribute("#org-crumb", "aria-haspopup")).toBe("menu");
    expect(await p.textContent("#org-crumb")).toBe("Org Acme ▾");
    await p.click("#org-crumb");
    expect(await menuRows(p)).toEqual([
      { text: "Acme3 workspaces", role: "menuitemradio", checked: "true" },
      // en's .one (0.3.0-dev.40): it said "1 workspaces".
      { text: "Globex1 workspace", role: "menuitemradio", checked: "false" },
    ]);
    await p.click('.den-pop .den-mi:has-text("Globex")');
    expect(
      await p.evaluate(() => (window as unknown as { orgs: string[] }).orgs),
    ).toEqual(["globex"]);
    expect(await p.textContent("#org-crumb")).toBe("Org Globex ▾");
    await p.context().close();
  });

  it("narrow: ≤860px hides keys, separators and the org; ≤720px hides the scope", async () => {
    if (!browser) return;
    const { p } = await mount("services");
    await shell(p, "setOrg", { id: "acme", title: "Acme" });
    await stubWorkspaces(p, [], { label: "none" });
    await p.setViewportSize({ width: 800, height: 700 });
    expect(await visibleScope(p)).toEqual([
      "button:Workspace none ▾",
      "button:Env local ▾",
    ]);
    expect(await p.isVisible("#ws-pill .den-k")).toBe(false);
    await p.setViewportSize({ width: 700, height: 700 });
    expect(await p.isVisible(".den-scope")).toBe(false);
    await p.context().close();
  });
});

describe("pins (a consumer's dev.17 run)", () => {
  it("any pin change fires den:pins, and every pin toggle repaints from it", async () => {
    if (!browser) return;
    const { p } = await mount(
      "services",
      { shell: { pins: [], collapsed: false } },
      {
        after:
          '<button class="pin-btn" data-pin-toggle="shop-web" aria-pressed="false" aria-label="Pin shop-web">☆</button>',
      },
    );
    await p.evaluate(() => {
      (window as unknown as { seen: string[][] }).seen = [];
      window.addEventListener("den:pins", (e) =>
        (window as unknown as { seen: string[][] }).seen.push(
          (e as CustomEvent).detail.pins,
        ),
      );
    });
    await shell(p, "pin", "shop-web");
    const toggle = () =>
      p.$eval("[data-pin-toggle]", (b) => [
        b.textContent,
        b.getAttribute("aria-pressed"),
        b.getAttribute("aria-label"),
      ]);
    expect(await toggle()).toEqual(["★", "true", "Unpin shop-web"]);
    // Unpin from the rail (the ×): the page's toggle follows, no reload.
    await p.waitForSelector('[data-pin="shop-web"]');
    await p.click('[data-unpin="shop-web"]', { force: true });
    expect(await toggle()).toEqual(["☆", "false", "Pin shop-web"]);
    expect(
      await p.evaluate(() => (window as unknown as { seen: string[][] }).seen),
    ).toEqual([["shop-web"], []]);
    await p.context().close();
  });

  it("Delete moves focus to the next pinned row, else the previous, else the first item", async () => {
    if (!browser) return;
    const { p } = await mount("services", {
      shell: { pins: ["a", "b", "c"], collapsed: false },
    });
    await p.waitForSelector('[data-pin="c"]');
    const active = () =>
      p.evaluate(() => (document.activeElement as HTMLElement).dataset.nav);
    await p.focus('[data-pin="b"]');
    await p.keyboard.press("Delete");
    expect(await active()).toBe("pin-c");
    await p.keyboard.press("Delete");
    expect(await active()).toBe("pin-a");
    await p.keyboard.press("Delete");
    expect(await active()).toBe("local-dev");
    expect(
      await p.$$eval('.den-rail [tabindex="0"]', (e) =>
        e.map((x) => (x as HTMLElement).dataset.nav),
      ),
    ).toEqual(["local-dev"]);
    await p.context().close();
  });

  it("a pinned row is named by its id; the × is its own control, 'Unpin <id>'", async () => {
    if (!browser) return;
    const { p } = await mount("services", {
      shell: { pins: ["shop-web"], collapsed: false },
    });
    await p.waitForSelector('[data-pin="shop-web"]');
    expect(
      await p.getByRole("link", { name: "shop-web", exact: true }).count(),
    ).toBe(1);
    expect(
      await p.getAttribute('[data-pin="shop-web"]', "aria-keyshortcuts"),
    ).toBe("Delete");
    expect(
      await p
        .getByRole("button", { name: "Unpin shop-web", exact: true })
        .count(),
    ).toBe(1);
    // The × glyph is hidden from readers; the control isn't inside the link.
    expect(
      await p.$eval('[data-unpin="shop-web"]', (x) => [
        x.closest("a") === null,
        x.querySelector('[aria-hidden="true"]')?.textContent,
      ]),
    ).toEqual([true, "×"]);
    await p.context().close();
  });
});

describe("registration (a consumer's dev.17 run)", () => {
  it("a script before shell.js queues work on window.denShellQueue; den-shell:ready fires", async () => {
    if (!browser) return;
    const { p } = await mount("services", undefined, {
      before:
        "<script>window.ready = 0; addEventListener('den-shell:ready', () => window.ready++);" +
        "(window.denShellQueue = window.denShellQueue || []).push(function (sh) {" +
        "sh.registerGroup({ id: 'acme', label: 'Acme', order: 40, from: 'acme' });" +
        "sh.registerNav({ id: 'edge', label: 'Edge', group: 'acme', order: 1, href: '/p/edge' }); });</script>",
    });
    expect(await p.$$('[data-nav="edge"]')).toHaveLength(1);
    expect(
      await p.evaluate(() => (window as unknown as { ready: number }).ready),
    ).toBe(1);
    // A later push runs at once.
    await p.evaluate(() =>
      (
        window as unknown as { denShellQueue: { push(f: unknown): void } }
      ).denShellQueue.push((sh: Shell) =>
        sh.registerNav({
          id: "late",
          label: "Late",
          group: "acme",
          href: "/p/late",
        }),
      ),
    );
    expect(await p.$$('[data-nav="late"]')).toHaveLength(1);
    await p.context().close();
  });

  it("a distribution group is named once; its tag is a description", async () => {
    if (!browser) return;
    const { p } = await mount("services");
    await shell(p, "registerGroup", {
      id: "globex",
      label: "Globex",
      order: 40,
      from: "globex",
    });
    await shell(p, "registerNav", {
      id: "edge",
      label: "Edge",
      group: "globex",
      href: "/p/edge",
    });
    expect(
      await p.getByRole("group", { name: "Globex", exact: true }).count(),
    ).toBe(1);
    expect(await p.getAttribute(".den-tagx", "aria-hidden")).toBe("true");
    const desc = await p.getAttribute(
      '[aria-labelledby="den-gh-globex"]',
      "aria-describedby",
    );
    expect(await p.textContent(`#${desc}`)).toBe("from globex");
    await p.context().close();
  });

  it("warns on a non-number order and an unknown group, and keeps the page until its group arrives", async () => {
    if (!browser) return;
    const { p, warnings } = await mount("services");
    await shell(p, "registerNav", {
      id: "early",
      label: "Early",
      group: "later",
      order: "5",
      href: "/p/early",
    });
    expect(await p.$$('[data-nav="early"]')).toHaveLength(0);
    // A group still missing a tick after the queue has drained warns.
    await p.waitForTimeout(50);
    await shell(p, "registerGroup", { id: "later", label: "Later", order: 50 });
    expect(await p.$$('[data-nav="early"]')).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(/nav "early": order must be a number/);
    expect(warnings.join("\n")).toMatch(
      /nav "early": group "later" is not registered/,
    );
    await p.context().close();
  });
});

/** Chrome's own accessible names for a role (its accessibility tree). */
async function axNames(p: Page, role: string): Promise<string[]> {
  const cdp = await p.context().newCDPSession(p);
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes: {
      ignored?: boolean;
      role?: { value?: string };
      name?: { value?: string };
    }[];
  };
  await cdp.detach();
  return nodes
    .filter((n) => !n.ignored && n.role?.value === role)
    .map((n) => String(n.name?.value ?? ""));
}

describe("a consumer's dev.18 run (two consumers)", () => {
  it("a page queued before its group warns nothing; a truly unknown group warns a tick after ready", async () => {
    if (!browser) return;
    // A consumer's order: the page, then (another script) its group, both queued
    // before shell.js. Legitimate: no warning.
    const { p, warnings } = await mount("services", undefined, {
      before:
        "<script>(window.denShellQueue = window.denShellQueue || []).push(function (sh) {" +
        "sh.registerNav({ id: 'edge', label: 'Edge', group: 'acme', order: 1, href: '/p/edge' }); });" +
        "window.denShellQueue.push(function (sh) {" +
        "sh.registerGroup({ id: 'acme', label: 'Acme', order: 40, from: 'acme' }); });" +
        "window.denShellQueue.push(function (sh) {" +
        "sh.registerNav({ id: 'lost', label: 'Lost', group: 'nowhere', href: '/p/lost' }); });</script>",
    });
    await p.waitForTimeout(100);
    expect(await p.$$('[data-nav="edge"]')).toHaveLength(1);
    const all = warnings.join("\n");
    expect(all).not.toMatch(/group "acme"/);
    expect(all).toMatch(/nav "lost": group "nowhere" is not registered/);
    await p.context().close();
  });

  it("the rail's × moves focus as Delete does: next pin, else previous, else the first item", async () => {
    if (!browser) return;
    const { p } = await mount("services", {
      shell: { pins: ["a", "b", "c"], collapsed: false },
    });
    await p.waitForSelector('[data-pin="c"]');
    const active = () =>
      p.evaluate(() => (document.activeElement as HTMLElement).dataset.nav);
    // Keyboard: focus the × of a pin (as a screen reader user reaches it)
    // and press Enter.
    for (const [x, next] of [
      ["b", "pin-c"],
      ["c", "pin-a"],
      ["a", "local-dev"],
    ]) {
      await p.focus(`[data-unpin="${x}"]`);
      await p.keyboard.press("Enter");
      expect([x, await active()]).toEqual([x, next]);
    }
    await p.context().close();
  });

  it("≤720px: the drawer is a modal; focus moves in, the rest is inert, Escape or the scrim closes it", async () => {
    if (!browser) return;
    const { p } = await mount("services");
    await p.setViewportSize({ width: 700, height: 700 });
    await p.click("#den-menu-btn");
    expect(await p.getAttribute("#den-menu-btn", "aria-expanded")).toBe("true");
    const activeNav = () =>
      p.evaluate(() => (document.activeElement as HTMLElement).dataset?.nav);
    expect(await activeNav()).toBe("services");
    expect(
      await p.evaluate(() => [
        document.querySelector(".den-top")!.hasAttribute("inert"),
        document.getElementById("den-content")!.hasAttribute("inert"),
      ]),
    ).toEqual([true, true]);
    // Tab stays inside.
    await p.keyboard.press("Tab");
    expect(
      await p.evaluate(() =>
        document.getElementById("den-rail")!.contains(document.activeElement),
      ),
    ).toBe(true);
    await p.keyboard.press("Escape");
    expect(await p.getAttribute("#den-menu-btn", "aria-expanded")).toBe(
      "false",
    );
    expect(await p.evaluate(() => document.activeElement?.id)).toBe(
      "den-menu-btn",
    );
    expect(
      await p.evaluate(() =>
        document.getElementById("den-content")!.hasAttribute("inert"),
      ),
    ).toBe(false);
    // The scrim closes it too.
    await p.click("#den-menu-btn");
    await p.mouse.click(690, 400);
    expect(await p.getAttribute("#den-menu-btn", "aria-expanded")).toBe(
      "false",
    );
    expect(await p.evaluate(() => document.activeElement?.id)).toBe(
      "den-menu-btn",
    );
    await p.context().close();
  });

  it("names: a group by its label, a workspace row 'default, focus', scope buttons without ▾", async () => {
    if (!browser) return;
    const { p } = await mount("services");
    await shell(p, "registerGroup", {
      id: "globex",
      label: "Globex",
      order: 40,
      from: "globex",
    });
    await shell(p, "registerNav", {
      id: "edge",
      label: "Edge",
      group: "globex",
      href: "/p/edge",
    });
    await shell(p, "setOrg", { id: "acme", title: "Acme" });
    await stubWorkspaces(p, [
      { value: "all", label: "All active (2)", checked: false },
      { value: "default", label: "default", checked: true, focused: true },
      { value: "ws-b", label: "ws-b", checked: false },
    ]);
    const groups = await axNames(p, "group");
    // (Chrome names it as drawn: uppercase.) Not "Globexglobex".
    expect(
      groups.filter((g) => /globex/i.test(g)).map((g) => g.toLowerCase()),
    ).toEqual(["globex"]);
    const buttons = await axNames(p, "button");
    expect(buttons.filter((b) => b.includes("▾"))).toEqual([]);
    await p.click("#ws-pill");
    await p.waitForSelector(".den-pop");
    const items = await axNames(p, "menuitemradio");
    expect(items).toContain("default, CLI default");
    await p.context().close();
  });

  it("a scope button's aria-controls names its menu only while the menu is open", async () => {
    if (!browser) return;
    const { p } = await mount("services");
    await stubWorkspaces(p, [
      { value: "default", label: "default", checked: true },
    ]);
    expect(await p.getAttribute("#ws-pill", "aria-controls")).toBeNull();
    await p.click("#ws-pill");
    const id = await p.getAttribute("#ws-pill", "aria-controls");
    expect(id).toBeTruthy();
    expect(await p.$$(`#${id}.den-pop`)).toHaveLength(1);
    await p.keyboard.press("Escape");
    expect(await p.getAttribute("#ws-pill", "aria-controls")).toBeNull();
    await p.click("#env-btn");
    expect(await p.getAttribute("#env-btn", "aria-controls")).toBe(
      "den-pop-env",
    );
    await p.keyboard.press("Escape");
    expect(await p.getAttribute("#env-btn", "aria-controls")).toBeNull();
    await p.context().close();
  });
});

describe("Navigation prefs (R21)", () => {
  it("the rail leaves out hidden pages and follows your order within each group", async () => {
    if (!browser) return;
    const { p } = await mount("settings", {
      shell: {
        pins: [],
        collapsed: false,
        hidden: ["tests"],
        order: ["logs", "local-dev"],
      },
    });
    await p.waitForFunction(
      () => !document.querySelector('.den-rail [data-nav="tests"]'),
    );
    expect(await rail(p)).toEqual([
      {
        heading: "Develop",
        tag: null,
        items: ["logs", "local-dev", "graph", "agents", "services"],
      },
      { heading: "Ship", tag: null, items: ["environments", "release"] },
      "den-rail-grow",
      "settings",
      "collapse",
    ]);
    // The Settings page is current on /settings.
    expect(await p.getAttribute('[data-nav="settings"]', "aria-current")).toBe(
      "page",
    );
    await p.context().close();
  });

  it("setNavPrefs repaints the rail and saves shell.hidden / shell.order", async () => {
    if (!browser) return;
    const { p, posts } = await mount("services");
    await shell(p, "setNavPrefs", { hidden: ["release"] });
    expect(await p.$$('.den-rail [data-nav="release"]')).toHaveLength(0);
    await shell(p, "setNavPrefs", { hidden: [], order: ["environments"] });
    await shell(p, "setPins", ["shop", "billing/api"]);
    await p.waitForTimeout(50);
    expect(posts).toEqual(
      expect.arrayContaining([
        { shell: { hidden: ["release"] } },
        { shell: { hidden: [], order: ["environments"] } },
        { shell: { pins: ["shop", "billing/api"] } },
      ]),
    );
    expect(await p.$$('.den-rail [data-nav="release"]')).toHaveLength(1);
    await p.context().close();
  });
});
