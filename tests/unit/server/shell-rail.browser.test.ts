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
): Promise<{ p: Page; posts: unknown[] }> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 800 },
  });
  const p = await ctx.newPage();
  const posts: unknown[] = [];
  await p.route("http://den.test/**", async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === "/shell.js")
      return r.fulfill({ contentType: "text/javascript", body: SHELL });
    if (url.pathname === "/api/settings") {
      if (r.request().method() === "POST")
        posts.push(JSON.parse(r.request().postData() ?? "null"));
      return r.fulfill({ json: settings });
    }
    return r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head></head><body><div id="den-shell" data-page="${page}"></div><script src="/shell.js"></script><main id="content">page</main></body></html>`,
    });
  });
  await p.goto("http://den.test/x");
  await p.waitForSelector(".den-rail .den-ni");
  return { p, posts };
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
        items: ["local-dev", "services", "logs"],
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
      "/local-dev?settings=1",
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
      ["Develop", null, ["local-dev", "services", "logs"]],
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
    const gh = await p.$eval("#den-gh-develop", (e) => {
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
