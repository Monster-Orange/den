/**
 * den-ui 0.7.3 (issue 307): a rail entry's kind tag. A pin or a link into
 * another product sets `kind` (project, den, service, hub, or an artifact
 * pin's own word) and the kit draws a small uppercase tag at the row's
 * end, in the scope labels' look (.den-k: the same token, no new colour).
 * Collapsed, its tooltip and accessible name read "<label> · <Kind>". A
 * project pin may show its initial in a disc in place of the icon. The nav
 * inventory records each entry's kind, so compareNav names a tag that
 * differs between two products.
 *
 *   L1  kind "project": the uppercase tag at the row's end, the kit token
 *   L2  no kind: no tag, the tooltip is the label alone
 *   L3  collapsed: tooltip and accessible name "<label> · Project"
 *   L4  es and ja words
 *   L5  the project's initial disc in place of the icon
 *   L6  the nav inventory reports the kind; compareNav fails when two
 *       products' tags differ
 *   L7  the kit owns the words: a host's tip, title or aria-label on an
 *       entry with a kind is not used ("<label> · <Kind>"); a badge says
 *       what it counts as data (`what`), in the kit's words
 *   L8  host text on any rail entry (title, aria-label, aria-labelledby,
 *       aria-description in attrs; a badge's label): navWarnings lists it
 *       and compareNav fails on it; data-* attrs stay allowed
 *   L9  a pin row's Delete shortcut is the kit's: no host attrs needed
 *   L10 a label that is its kind word (any case, in the language) reads
 *       once: "Hub", never "Hub · Hub"
 *   L11 (0.7.4, issue 326) `off`: the kit greys the entry (.den-off) and
 *       says why in its own words, in the tooltip and accessible name:
 *       "Acme Co · Hub, reconnect in Settings"; no `off`, not greyed
 *   L12 the off words in es and ja
 *   L13 an `off` the kit doesn't know is dropped (not greyed, no words); a
 *       host's own reason text is never needed; an entry without a kind
 *       reads "<label>, <why>"
 *   L14 the nav inventory records `off`; compareNav reports an `off`
 *       difference between two products
 *
 * On a bare page built from the kit's own files, in Chromium and WebKit.
 * DEN_PW_WS: Den's own Playwright server instead of a local browser.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import {
  collectNav,
  compareNav,
  navWarnings,
  type NavSnapshot,
} from "../../../packages/den-ui/inventory/nav-inventory.js";

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
      browsers[name] = await launchBrowser(kind);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

const STYLES = ["tokens", "fonts", "base", "shell"];

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${STYLES.map((s) => `<link rel="stylesheet" href="/kit/${s}.css">`).join("\n")}
<style>body { margin: 0; }</style>
</head>
<body class="den-has-shell"><div class="den-shell" id="den-shell"></div>
<main id="den-content"><p>Content</p></main>
<script type="module" src="/app.js"></script>
</body></html>`;

/**
 * The app: `?lang=es|ja` the kit's language; `?other` a second product
 * whose North pin says DEN, not PROJECT; `?red` a second product whose
 * tag is drawn in another colour; `?host` a host that passes its own
 * tooltip and name text (which the kit must not use, and the inventory
 * must flag); `?off=<why>` the company's Hub link is off for that reason.
 */
const APP = `
import DenUI from "/kit/kit.js";
import { launchBrowser } from "../helpers/browser.js";
const q = new URLSearchParams(location.search);
const lang = q.get("lang") || "en";
DenUI.configure({ lang, product: { name: "Acme" } });
const host = q.has("host");
const nav = [
  { id: "p-north", label: "North", href: "#north", group: "pinned",
    kind: q.has("other") ? "den" : "project", icon: { initial: "north" }, pin: "north",
    ...(host ? { tip: "North on acme", attrs: { title: "Mine", "aria-label": "Mine",
      "aria-labelledby": "den-content", "aria-description": "Mine too", "data-x": "ok" } } : {}) },
  { id: "d-north", label: "North", href: "#den-north", group: "pinned", kind: "den", icon: "home",
    ...(host ? { badge: { n: 3, what: "waiting" } } : {}) },
  { id: "s-api", label: "api", href: "#api", group: "pinned", kind: "service", mono: true, pin: "api",
    ...(host ? { badge: { n: 2, label: "2 things" } } : {}) },
  { id: "a-spec", label: "Spec", href: "#spec", group: "pinned", kind: { artifact: "Mock" } },
  { id: "home", label: "Home", href: "#home", group: "work", icon: "home", current: true,
    ...(host ? { attrs: { title: "Host home" } } : {}) },
  ...(q.has("count")
    ? [
        { id: "hdocs", label: "Hub Docs", href: "#hd", group: "work", icon: "home", badge: { n: 4 } },
        { id: "rdocs", label: "Repo Docs", href: "#rd", group: "work", icon: "home", badge: { n: 1234 } },
        { id: "kco", label: "Acme Co", href: "#kc", group: "work", icon: "hub", kind: "hub", badge: { n: 4 } },
        { id: "none", label: "Empty", href: "#e", group: "work", icon: "home", badge: { n: "" } },
      ]
    : []),
];
const model = {
  product: { name: "Acme", version: "1.0.0", mark: { text: "A", label: "Acme" } },
  groups: [{ id: "pinned", label: "Pinned" }, { id: "work", label: "Work" }],
  nav,
  foot: [
    { id: "hub", label: "Hub", href: "#hub", icon: "hub", kind: "hub" },
    { id: "srv", label: lang === "es" ? "SERVICIO" : "service", href: "#srv", icon: "services", kind: "service" },
    { id: "co", label: "Acme Co", href: "#co", icon: "hub", kind: "hub",
      ...(q.get("off") ? { off: q.get("off") } : {}) },
    { id: "plain", label: "Docs", href: "#docs", icon: "home",
      ...(q.get("off") ? { off: q.get("off") } : {}) },
  ],
  slots: {
    start: DenUI.scopeHtml({ crumbs: [{ key: "ws", label: "Project", value: "North" }] }),
  },
};
if (q.has("red")) {
  const s = document.createElement("style");
  s.textContent = ".den-rail [data-nav-role=kind] { color: rgb(255, 0, 0) !important; }";
  document.head.appendChild(s);
}
window.shell = DenUI.mount(document.getElementById("den-shell"), model);
window.ready = true;
`;

async function open(b: Browser, query = "", width = 1280): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width, height: 800 },
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

/** One entry's tag: its words as drawn, its look, and where it sits. */
const tagOf = (p: Page, id: string) =>
  p.evaluate((id) => {
    const a = document.querySelector(`.den-rail [data-nav="${id}"]`)!;
    const tag = a.querySelector("[data-nav-role=kind]") as HTMLElement | null;
    if (!tag) return null;
    const label = a.querySelector(".den-lbl")!;
    const scopeKey = document.querySelector(".den-scope .den-k")!;
    const probe = document.createElement("span");
    probe.style.color = "var(--faint)";
    document.body.appendChild(probe);
    const faint = getComputedStyle(probe).color;
    probe.remove();
    const cs = getComputedStyle(tag);
    const ks = getComputedStyle(scopeKey);
    const ar = a.getBoundingClientRect();
    const tr = tag.getBoundingClientRect();
    const lr = label.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(a).paddingRight) || 0;
    return {
      text: tag.innerText,
      last: a.lastElementChild === tag,
      afterLabel: tr.left >= lr.right - 0.5,
      atEnd: Math.abs(ar.right - pad - tr.right) <= 1,
      look: {
        color: cs.color,
        font: cs.fontSize + " " + cs.fontFamily,
        transform: cs.textTransform,
      },
      scopeLook: {
        color: ks.color,
        font: ks.fontSize + " " + ks.fontFamily,
        transform: ks.textTransform,
      },
      faint,
      hidden: tag.getAttribute("aria-hidden"),
    };
  }, id);

for (const engine of ["chromium", "webkit"]) {
  describe(`den-ui 0.7.3 rail kind tag (${engine})`, () => {
    it("L1: kind project draws an uppercase tag at the row's end, in the kit's token", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      const t = await tagOf(p, "p-north");
      expect(t).not.toBeNull();
      expect(t!.text).toBe("PROJECT");
      expect(t!.last).toBe(true);
      expect(t!.afterLabel).toBe(true);
      expect(t!.atEnd).toBe(true);
      // The scope labels' look, in the --faint token.
      expect(t!.look).toEqual(t!.scopeLook);
      expect(t!.look.color).toBe(t!.faint);
      expect(t!.look.transform).toBe("uppercase");
      // The tag is not read on its own: the entry's name says the kind.
      expect(t!.hidden).toBe("true");
      // Every fixed kind, and an artifact's own word, uppercase.
      expect((await tagOf(p, "d-north"))!.text).toBe("DEN");
      expect((await tagOf(p, "s-api"))!.text).toBe("SERVICE");
      expect((await tagOf(p, "a-spec"))!.text).toBe("MOCK");
      expect((await tagOf(p, "hub"))!.text).toBe("HUB");
      await p.context().close();
    });

    it("L2: an entry without kind has no tag and its own tooltip", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      const got = await p.evaluate(() => {
        const a = document.querySelector('.den-rail [data-nav="home"]')!;
        return {
          tag: !!a.querySelector("[data-nav-role=kind]"),
          kind: a.getAttribute("data-nav-kind"),
          title: a.getAttribute("title"),
          label: a.getAttribute("aria-label"),
          svg: !!a.querySelector("svg"),
        };
      });
      expect(got).toEqual({
        tag: false,
        kind: null,
        title: "Home",
        label: null,
        svg: true,
      });
      await p.context().close();
    });

    it("L3: collapsed, the tooltip and accessible name read '<label> · Project'", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.evaluate(() =>
        (
          window as unknown as { shell: { setCollapsed(on: boolean): void } }
        ).shell.setCollapsed(true),
      );
      const got = await p.evaluate(() => {
        const one = (id: string) => {
          const a = document.querySelector(
            `.den-rail [data-nav="${id}"]`,
          ) as HTMLElement;
          const tag = a.querySelector("[data-nav-role=kind]") as HTMLElement;
          return {
            title: a.getAttribute("title"),
            tagShown: !!tag && tag.getBoundingClientRect().width > 1,
          };
        };
        return { project: one("p-north"), den: one("d-north") };
      });
      expect(got.project).toEqual({
        title: "North · Project",
        tagShown: false,
      });
      expect(got.den).toEqual({ title: "North · Den", tagShown: false });
      // The accessible names, as a screen reader gets them.
      expect(
        await p
          .getByRole("link", { name: "North · Project", exact: true })
          .count(),
      ).toBe(1);
      expect(
        await p.getByRole("link", { name: "North · Den", exact: true }).count(),
      ).toBe(1);
      await p.context().close();
    });

    it("L4: the kind words in es and ja", async () => {
      const b = browsers[engine];
      if (!b) return;
      for (const [lang, word, service] of [
        ["es", "Proyecto", "Servicio"],
        ["ja", "プロジェクト", "サービス"],
      ] as const) {
        const p = await open(b, `?lang=${lang}`);
        const t = await tagOf(p, "p-north");
        expect(t!.text).toBe(word.toUpperCase());
        expect((await tagOf(p, "s-api"))!.text).toBe(service.toUpperCase());
        const title = await p.evaluate(() =>
          document
            .querySelector('.den-rail [data-nav="p-north"]')!
            .getAttribute("title"),
        );
        expect(title).toBe(`North · ${word}`);
        expect(
          await p
            .getByRole("link", { name: `North · ${word}`, exact: true })
            .count(),
        ).toBe(1);
        await p.context().close();
      }
    });

    it("L5: a project pin's initial disc stands in for the icon", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      const got = await p.evaluate(() => {
        const a = document.querySelector('.den-rail [data-nav="p-north"]')!;
        const disc = a.querySelector(".den-ini") as HTMLElement | null;
        const svg = a.querySelector("svg");
        const home = document.querySelector('.den-rail [data-nav="d-north"]')!;
        const homeSvg = home.querySelector("svg")!.getBoundingClientRect();
        if (!disc) return { disc: false, svg: !!svg };
        const r = disc.getBoundingClientRect();
        const cs = getComputedStyle(disc);
        return {
          disc: true,
          svg: !!svg,
          first: a.firstElementChild === disc,
          text: disc.textContent,
          hidden: disc.getAttribute("aria-hidden"),
          w: Math.round(r.width),
          h: Math.round(r.height),
          iconW: Math.round(homeSvg.width),
          round: cs.borderTopLeftRadius === "50%",
        };
      });
      expect(got).toEqual({
        disc: true,
        svg: false,
        first: true,
        // One letter, uppercase, from what the host gave.
        text: "N",
        hidden: "true",
        w: got.iconW,
        h: got.iconW,
        iconW: 18,
        round: true,
      });
      await p.context().close();
    });

    it("L6: the nav inventory reports the kind; compareNav fails when the tags differ", async () => {
      const b = browsers[engine];
      if (!b) return;
      const snap = async (q: string): Promise<NavSnapshot> => {
        const p = await open(b, q);
        const s = await collectNav(p);
        await p.context().close();
        return s;
      };
      const a = await snap("");
      const row = a.elements.find((e) => e.key === '[data-nav="p-north"]');
      expect(row?.kind).toBe("project");
      expect(
        a.elements.find((e) => e.key === '[data-nav="d-north"]')?.kind,
      ).toBe("den");
      expect(
        a.elements.find((e) => e.key === '[data-nav="a-spec"]')?.kind,
      ).toBe("artifact");
      expect(
        a.elements.find((e) => e.key === '[data-nav="home"]')?.kind,
      ).toBeUndefined();
      // The tag itself is listed, as the kit's "kind" role.
      expect(a.elements.some((e) => e.host?.role === "kind")).toBe(true);

      // The same product twice: no kind difference.
      const same = compareNav(await snap(""), a);
      expect(same.filter((d) => /kind/.test(d.property))).toEqual([]);
      expect(same).toEqual([]);

      // Another product calls North a Den: the kind differs.
      const other = compareNav(await snap("?other"), a);
      expect(
        other.filter(
          (d) => d.property === "kind" && d.key === '[data-nav="p-north"]',
        ),
      ).toEqual([
        {
          key: '[data-nav="p-north"]',
          slot: "rail",
          property: "kind",
          reference: "project",
          actual: "den",
        },
      ]);

      // Another product draws its tag in another colour: that fails too.
      const red = compareNav(await snap("?red"), a);
      expect(
        red.some(
          (d) =>
            d.property === "style.color" &&
            d.actual === "rgb(255, 0, 0)" &&
            /\[data-nav="p-north"\]/.test(d.key),
        ),
      ).toBe(true);
    });

    it("L7: the kit owns the words: a host's tip, title or aria-label on a kind entry is not used", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, "?host");
      const got = await p.evaluate(() => {
        const one = (id: string) => {
          const a = document.querySelector(`.den-rail [data-nav="${id}"]`)!;
          return [a.getAttribute("title"), a.getAttribute("aria-label")];
        };
        return {
          project: one("p-north"),
          den: one("d-north"),
          api: one("s-api"),
        };
      });
      expect(got.project).toEqual(["North · Project", "North · Project"]);
      // The badge's words are the kit's, from what it counts.
      expect(got.den).toEqual(["North · Den", "North · Den, 3 waiting"]);
      // A badge's own label (host text) is not used; its count still reads.
      expect(got.api).toEqual(["api · Service", "api · Service, 2"]);
      await p.context().close();
      for (const [lang, words] of [
        ["es", "North · Den, 3 en espera"],
        ["ja", "North · Den, 3 件待機中"],
      ] as const) {
        const q = await open(b, `?host&lang=${lang}`);
        expect(
          await q.evaluate(() =>
            document
              .querySelector('.den-rail [data-nav="d-north"]')!
              .getAttribute("aria-label"),
          ),
        ).toBe(words);
        await q.context().close();
      }
    });

    it("L8: a host's title or aria-label in an entry of the rail: listed, and compareNav fails", async () => {
      const b = browsers[engine];
      if (!b) return;
      const snap = async (q: string): Promise<NavSnapshot> => {
        const p = await open(b, q);
        const s = await collectNav(p);
        await p.context().close();
        return s;
      };
      const clean = await snap("");
      expect(navWarnings(clean)).toEqual([]);
      const host = await snap("?host");
      const warned = navWarnings(host);
      expect(warned.some((w) => w.includes('[data-nav="home"]'))).toBe(true);
      expect(warned.some((w) => w.includes('[data-nav="p-north"]'))).toBe(true);
      const diffs = compareNav(host, clean).filter(
        (d) => d.property === "hostText",
      );
      expect(diffs).toEqual(
        expect.arrayContaining([
          {
            key: '[data-nav="home"]',
            slot: "rail",
            property: "hostText",
            reference: "none",
            actual: "title",
          },
          {
            key: '[data-nav="p-north"]',
            slot: "rail",
            property: "hostText",
            reference: "none",
            actual: "title,aria-label,aria-labelledby,aria-description",
          },
          {
            key: '[data-nav="s-api"]',
            slot: "rail",
            property: "hostText",
            reference: "none",
            actual: "badge.label",
          },
        ]),
      );
      // A data-* attribute is data: kept, and not flagged.
      expect(diffs.some((d) => d.key === '[data-nav="d-north"]')).toBe(false);
    });

    it("L9: a pin row's Delete shortcut is the kit's, with no host attrs", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      const got = await p.evaluate(() =>
        ["p-north", "s-api", "d-north"].map((id) =>
          document
            .querySelector(`.den-rail [data-nav="${id}"]`)!
            .getAttribute("aria-keyshortcuts"),
        ),
      );
      expect(got).toEqual(["Delete", "Delete", null]);
      await p.context().close();
    });

    it("L10: a label that is its kind word reads once, never '<word> · <word>'", async () => {
      const b = browsers[engine];
      if (!b) return;
      for (const [lang, srv] of [
        ["en", "service"],
        ["es", "SERVICIO"],
      ] as const) {
        const p = await open(b, `?lang=${lang}`);
        const got = await p.evaluate(() =>
          ["hub", "srv"].map((id) => {
            const a = document.querySelector(`.den-rail [data-nav="${id}"]`)!;
            return [a.getAttribute("title"), a.getAttribute("aria-label")];
          }),
        );
        expect(got).toEqual([
          ["Hub", "Hub"],
          [srv, srv],
        ]);
        await p.context().close();
      }
    });
    it("L11: off greys the entry and the kit says why: 'Acme Co · Hub, reconnect in Settings'", async () => {
      const b = browsers[engine];
      if (!b) return;
      const one = (p: Page) =>
        p.evaluate(() => {
          const a = document.querySelector('.den-rail [data-nav="co"]')!;
          return {
            title: a.getAttribute("title"),
            name: a.getAttribute("aria-label"),
            off: a.classList.contains("den-off"),
            opacity: Number(getComputedStyle(a).opacity),
          };
        });
      const p0 = await open(b);
      expect(await one(p0)).toEqual({
        title: "Acme Co · Hub",
        name: "Acme Co · Hub",
        off: false,
        opacity: 1,
      });
      await p0.context().close();
      for (const [off, why] of [
        ["connect", "connect in Settings"],
        ["reconnect", "reconnect in Settings"],
        ["forbidden", "ask an admin for access"],
        ["unreachable", "can't be reached right now"],
        ["config", "check Settings"],
      ] as const) {
        const p = await open(b, `?off=${off}`);
        const got = await one(p);
        expect([off, got.title, got.name, got.off]).toEqual([
          off,
          `Acme Co · Hub, ${why}`,
          `Acme Co · Hub, ${why}`,
          true,
        ]);
        expect(got.opacity).toBeLessThan(1);
        expect(
          await p
            .getByRole("link", { name: `Acme Co · Hub, ${why}`, exact: true })
            .count(),
        ).toBe(1);
        await p.context().close();
      }
    });

    it("L12: the off words in es and ja", async () => {
      const b = browsers[engine];
      if (!b) return;
      for (const [lang, words] of [
        ["es", "Acme Co · Hub, vuelve a conectarlo en Ajustes"],
        ["ja", "Acme Co · Hub, 設定で再接続してください"],
      ] as const) {
        const p = await open(b, `?off=reconnect&lang=${lang}`);
        expect(
          await p.evaluate(() => {
            const a = document.querySelector('.den-rail [data-nav="co"]')!;
            return [a.getAttribute("title"), a.getAttribute("aria-label")];
          }),
        ).toEqual([words, words]);
        await p.context().close();
      }
    });

    it("L13: an off the kit doesn't know is dropped; an entry without a kind reads '<label>, <why>'", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, "?off=Hub%20is%20down");
      expect(
        await p.evaluate(() => {
          const a = document.querySelector('.den-rail [data-nav="co"]')!;
          return [
            a.getAttribute("title"),
            a.getAttribute("aria-label"),
            a.classList.contains("den-off"),
            a.hasAttribute("data-nav-off"),
          ];
        }),
      ).toEqual(["Acme Co · Hub", "Acme Co · Hub", false, false]);
      await p.context().close();
      const q = await open(b, "?off=unreachable");
      expect(
        await q.evaluate(() => {
          const a = document.querySelector('.den-rail [data-nav="plain"]')!;
          return [
            a.getAttribute("title"),
            a.getAttribute("aria-label"),
            a.classList.contains("den-off"),
          ];
        }),
      ).toEqual([
        "Docs, can't be reached right now",
        "Docs, can't be reached right now",
        true,
      ]);
      await q.context().close();
    });

    it("L14: the nav inventory records off; compareNav reports an off difference", async () => {
      const b = browsers[engine];
      if (!b) return;
      const snap = async (q: string): Promise<NavSnapshot> => {
        const p = await open(b, q);
        const s = await collectNav(p);
        await p.context().close();
        return s;
      };
      const on = await snap("");
      const re = await snap("?off=reconnect");
      const co = (s: NavSnapshot) =>
        s.elements.find((e) => e.key === '[data-nav="co"]');
      expect(co(on)?.off).toBeUndefined();
      expect(co(re)?.off).toBe("reconnect");
      expect(compareNav(await snap("?off=reconnect"), re)).toEqual([]);
      const offDiffs = (a: NavSnapshot, r: NavSnapshot) =>
        compareNav(a, r).filter(
          (d) => d.property === "off" && d.key === '[data-nav="co"]',
        );
      expect(offDiffs(await snap("?off=unreachable"), re)).toEqual([
        {
          key: '[data-nav="co"]',
          slot: "foot",
          property: "off",
          reference: "reconnect",
          actual: "unreachable",
        },
      ]);
      expect(offDiffs(on, re)).toEqual([
        {
          key: '[data-nav="co"]',
          slot: "foot",
          property: "off",
          reference: "reconnect",
          actual: "(none)",
        },
      ]);
    });

    it("L15: a plain count (no what) reads its number: 'Hub Docs, 4'", async () => {
      const b = browsers[engine];
      if (!b) return;
      for (const [lang, big] of [
        ["en", "1,234"],
        ["es", "1234"],
        ["ja", "1,234"],
      ] as const) {
        const p = await open(b, `?count&lang=${lang}`);
        const got = await p.evaluate(() =>
          ["hdocs", "rdocs", "kco", "none"].map((id) =>
            document
              .querySelector(`.den-rail [data-nav="${id}"]`)!
              .getAttribute("aria-label"),
          ),
        );
        const hub =
          lang === "en" ? "Hub" : got[2]!.split(" · ")[1].split(",")[0];
        expect({ lang, got }).toEqual({
          lang,
          got: [
            "Hub Docs, 4",
            `Repo Docs, ${big}`,
            `Acme Co · ${hub}, 4`,
            null,
          ],
        });
        await p.context().close();
      }
    });
  });
}
