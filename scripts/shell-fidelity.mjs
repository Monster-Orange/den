#!/usr/bin/env node
/**
 * Shell fidelity (0.3.0-dev.17): measure Den's real shell against the shell
 * prototype, element by element, instead of eyeballing screenshots.
 *
 *   node scripts/shell-fidelity.mjs --proto <den-shell.html> --real <url>
 *        [--page /services] [--widths 1440,1024] [--brand den|mo]
 *        [--mode dark|light] [--theme <id>] [--shots <dir>] [--json <file>]
 *        [--proto-fonts 1]
 *
 * Loads the prototype (file) and the real page (a running Den, demo data)
 * at the same viewport, finds matched element pairs (the top bar, brand,
 * scope parts (org, workspace, env, a part's hover) and the open
 * Workspace menu (.pop, its .ml label, an .mi row, the ✓), What's new,
 * the user menu, the search field and its ⌘K, the Status, Runs and lock
 * chips (0.3.0-dev.20), the open user menu, lock popover, status drawer
 * and ⌘K palette, the rail, its group
 * headings, items in their default, hover and current states, the icon,
 * the current bar, a pinned row and its dot, a badge, and the collapsed
 * rail; on --page /settings also the Settings page: page header, title
 * and sub line, the search box, sections and their headings and text, the
 * segmented buttons, a row and its label, the swatches and the navigation
 * list) and compares their computed font-size, font-weight, line-height,
 * letter-spacing, text-transform, padding, gap, border radius, height and
 * width. A mismatch beyond 1px (0.5px for type) fails, unless the
 * ALLOWLIST below names it with a reason. Colors are themes' business: a
 * state's color is checked against the page's own token (hover is
 * --sunken, the current bar is --accent) rather than across the two.
 *
 * --theme sets the real page's theme for the run (through /api/settings,
 * restored after); --brand picks the prototype's (den or mo).
 * --shots writes each pair of full-page screenshots side by side, and a
 * second pair with the Workspace menu open (-menu), and one each with the
 * user menu, the lock popover, the status drawer and the palette open
 * (-user, -lock, -drawer, -palette). The
 * prototype's web fonts are blocked (both sides use the fallbacks) unless
 * --proto-fonts 1: fonts are a theme's assets, not the shell's CSS.
 * Exit code 1 on any failure. Needs Playwright's chromium.
 */
/* eslint-env node, browser */
/* global DATA */
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
if (!args.proto || !args.real) {
  console.error(
    "usage: shell-fidelity.mjs --proto <den-shell.html> --real <url> [--page /services] [--widths 1440,1024] [--brand den|mo] [--mode dark|light] [--theme id] [--shots dir] [--json file] [--proto-fonts 1]",
  );
  process.exit(2);
}
const PAGE = args.page ?? "/services";
const WIDTHS = (args.widths ?? "1440,1024").split(",").map(Number);
const BRAND = args.brand ?? "den";
const MODE = args.mode ?? "dark";
const REAL = args.real.replace(/\/$/, "");

/** Den page → the prototype's page id. */
const PROTO_PAGE = {
  "/local-dev": "overview",
  "/services": "services",
  "/logs": "logs",
  "/tests": "tests",
  "/environments": "envs",
  "/release": "releases",
  "/settings": "settings",
};

// The plain rail item the pairs measure: Tests, or Logs on the Tests page
// itself (hovering the current page would measure its current tint).
const ITEM = PAGE === "/tests" ? "logs" : "tests";

const TYPE = [
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "textTransform",
];
const BOX = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "height",
];

/**
 * Matched pairs: [name, prototype selector, real selector, props, opts].
 * opts.state: "hover" | "collapsed"; opts.pseudo: "::before".
 */
const PAIRS = [
  [
    "top bar",
    ".top",
    ".den-top",
    [
      "height",
      "paddingLeft",
      "paddingRight",
      "columnGap",
      "borderBottomWidth",
      "fontSize",
      "lineHeight",
    ],
  ],
  [
    "brand title",
    ".brand",
    // A span, not an h1 (dev.20): the page's own h1 is its one.
    ".den-brand > span.den-title",
    ["fontSize", "fontWeight", "letterSpacing", "textTransform"],
  ],
  ["brand gap", ".brand", ".den-brand", ["columnGap"]],
  ["brand mark", ".mark", ".den-mark", ["width", "height"]],
  [
    "scope part (org)",
    '.scope [data-pop="org"]',
    "#org-crumb",
    [...TYPE, ...BOX, "columnGap"],
  ],
  ["scope key (org)", '.scope [data-pop="org"] .k', "#org-crumb .den-k", TYPE],
  [
    "scope part (workspace)",
    '.scope [data-pop="ws"]',
    "#ws-pill",
    [...TYPE, ...BOX, "columnGap", "borderTopLeftRadius"],
  ],
  [
    "scope key (workspace)",
    '.scope [data-pop="ws"] .k',
    "#ws-pill .den-k",
    TYPE,
  ],
  [
    "scope part (hover)",
    '.scope [data-pop="ws"]',
    "#ws-pill",
    ["height", "@bg=--sunken", "@color=--text"],
    { state: "hover" },
  ],
  [
    "scope part (env)",
    '.scope [data-pop="env"]',
    "#env-btn",
    [...TYPE, ...BOX, "columnGap"],
  ],
  ["scope key (env)", '.scope [data-pop="env"] .k', "#env-btn .den-k", TYPE],
  // The Workspace menu, open (R18 .pop, .ml, .mi and the ✓).
  [
    "popover",
    ".pop",
    ".den-pop",
    [
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopLeftRadius",
      "borderTopWidth",
      "minWidth",
      "fontSize",
      "lineHeight",
      "@bg=--raised",
    ],
    { state: "menu" },
  ],
  ["popover offset", ".pop", ".den-pop", ["@below=6"], { state: "menu" }],
  [
    "menu label",
    ".pop .ml",
    ".den-pop .den-ml",
    [...TYPE, ...BOX],
    { state: "menu" },
  ],
  [
    "menu item",
    ".pop .mi",
    ".den-pop .den-mi",
    [...TYPE, ...BOX, "columnGap", "borderTopLeftRadius", "@color=--text"],
    { state: "menu" },
  ],
  [
    "menu item (checked ✓)",
    '.pop .mi[aria-checked="true"]',
    '.den-pop .den-mi[aria-checked="true"]',
    ["content", "@color=--accent-text"],
    { state: "menu", pseudo: "::after" },
  ],
  [
    "scope separator",
    ".scope .sep",
    ".den-scope .den-sep",
    ["fontSize", "fontWeight"],
  ],
  ["what's new", ".whatsnew", "#version-pill", [...TYPE, ...BOX, "columnGap"]],
  [
    "what's new dot",
    ".whatsnew .badge-dot",
    "#version-pill .v-pip",
    ["width", "height"],
  ],
  [
    "user menu",
    '[data-pop="user"]',
    ".den-top .appearance-btn",
    [...TYPE, ...BOX],
  ],
  // The search field and the chips (0.3.0-dev.20: R5, R6, R7, R8).
  [
    "search",
    ".search",
    ".den-search",
    [
      ...TYPE,
      ...BOX,
      "columnGap",
      "maxWidth",
      "flexBasis",
      "flexGrow",
      "borderTopLeftRadius",
      "borderTopWidth",
      "@bg=--sunken",
      "@color=--faint",
    ],
  ],
  [
    "search kbd",
    ".search kbd",
    ".den-search kbd",
    [
      ...TYPE,
      ...BOX,
      "borderTopLeftRadius",
      "borderBottomWidth",
      "@bg=--surface",
      "@color=--muted",
    ],
  ],
  ["chips", ".chips", ".den-chips", ["columnGap"]],
  [
    "status chip",
    '.chip[data-act="status"]',
    "#den-status",
    [
      ...TYPE,
      ...BOX,
      "columnGap",
      "borderTopLeftRadius",
      "borderTopWidth",
      "@bg=--surface",
    ],
  ],
  [
    "status chip dot",
    '.chip[data-act="status"] .dot',
    "#den-status .den-dot",
    ["width", "height", "borderTopLeftRadius"],
  ],
  [
    "runs chip",
    '.chip[data-act="dock"]',
    "#den-runs",
    [...TYPE, ...BOX, "columnGap", "borderTopLeftRadius", "borderTopWidth"],
  ],
  [
    "runs chip dot",
    '.chip[data-act="dock"] .dot',
    "#den-runs .den-dot",
    ["width", "height", "@bg=--faint"],
  ],
  [
    "lock chip",
    '.chip[data-pop="lock"]',
    "#den-lock",
    [...TYPE, ...BOX, "columnGap", "borderTopLeftRadius", "borderTopWidth"],
  ],
  // The user menu, open (R10).
  [
    "user menu (open)",
    ".pop",
    ".den-pop",
    [
      "paddingTop",
      "paddingLeft",
      "borderTopLeftRadius",
      "borderTopWidth",
      "minWidth",
      "fontSize",
      "@bg=--raised",
    ],
    { state: "user" },
  ],
  [
    "user menu offset",
    ".pop",
    ".den-pop",
    ["@below=6"],
    { state: "user", anchor: ['[data-pop="user"]', "#appearance-btn"] },
  ],
  [
    "user menu label",
    ".pop .ml",
    ".den-pop .den-ml",
    [...TYPE, ...BOX],
    { state: "user" },
  ],
  [
    "user menu item",
    ".pop .mi",
    ".den-pop .den-mi",
    [...TYPE, ...BOX, "columnGap", "borderTopLeftRadius"],
    { state: "user" },
  ],
  [
    "user menu rule",
    ".pop .hr",
    ".den-pop .den-hr",
    ["height", "marginTop", "marginBottom", "@bg=--border"],
    { state: "user" },
  ],
  // The lock popover, locked (R8).
  [
    "lock form",
    ".pop form",
    ".den-pop form",
    [
      "rowGap",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "width",
    ],
    { state: "lock" },
  ],
  [
    "lock input",
    ".pop input",
    ".den-pop #den-lock-pw",
    [...TYPE, ...BOX, "borderTopLeftRadius", "borderTopWidth", "@bg=--bg"],
    { state: "lock" },
  ],
  [
    "lock button",
    ".pop form .btn",
    ".den-pop form .den-btn",
    [...TYPE, ...BOX, "borderTopLeftRadius"],
    { state: "lock" },
  ],
  [
    "lock note",
    ".pop .note",
    ".den-pop .den-note",
    ["fontSize", "lineHeight", "@color=--muted"],
    { state: "lock" },
  ],
  // The status drawer (R15).
  [
    "drawer",
    ".drawer",
    ".den-drawer",
    ["width", "borderLeftWidth", "@bg=--surface"],
    { state: "drawer" },
  ],
  [
    "drawer head",
    ".drawer .dh",
    ".den-drawer .den-dh",
    [...BOX, "columnGap", "borderBottomWidth"],
    { state: "drawer" },
  ],
  [
    "drawer title",
    ".drawer .dh h2",
    ".den-drawer .den-dh h2",
    TYPE,
    { state: "drawer" },
  ],
  [
    "drawer body",
    ".drawer .db",
    ".den-drawer .den-db",
    ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap"],
    { state: "drawer" },
  ],
  [
    "drawer section",
    ".drawer h2.sec",
    ".den-drawer .den-sec",
    [...TYPE, "marginBottom", "@color=--muted"],
    { state: "drawer" },
  ],
  [
    "problem card",
    ".prob-card",
    ".den-prob-card",
    [
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "rowGap",
      "borderTopLeftRadius",
      "borderTopWidth",
    ],
    { state: "drawer" },
  ],
  [
    "problem card button",
    ".prob-card .btn",
    ".den-prob-card .den-btn",
    [...TYPE, ...BOX, "borderTopLeftRadius"],
    { state: "drawer" },
  ],
  [
    "drawer group heading",
    ".grp h4",
    ".den-grp h3",
    [...TYPE, "marginBottom"],
    { state: "drawer" },
  ],
  [
    "drawer service row",
    ".svl button",
    ".den-svl button",
    [...TYPE, ...BOX, "columnGap", "borderTopLeftRadius"],
    { state: "drawer" },
  ],
  [
    "drawer service ms",
    ".svl .ms",
    ".den-svl .den-ms",
    ["fontSize", "@color=--faint"],
    { state: "drawer" },
  ],
  [
    "drawer scrim",
    ".scrim",
    ".den-scrim",
    ["backgroundColor"],
    { state: "drawer" },
  ],
  // The ⌘K palette (R17).
  [
    "palette",
    ".pal",
    ".den-pal",
    [
      "width",
      "borderTopLeftRadius",
      "borderTopWidth",
      "@below-top=12vh",
      "@bg=--raised",
    ],
    { state: "palette" },
  ],
  [
    "palette input",
    ".pal input",
    ".den-pal input",
    [...TYPE, ...BOX, "borderBottomWidth"],
    { state: "palette" },
  ],
  [
    "palette list",
    ".pal ul",
    ".den-pal ul",
    ["paddingTop", "paddingLeft", "maxHeight"],
    { state: "palette" },
  ],
  [
    "palette row",
    ".pal li",
    ".den-pal li",
    [...TYPE, ...BOX, "columnGap", "borderTopLeftRadius"],
    { state: "palette" },
  ],
  [
    "palette row (selected)",
    '.pal li[aria-selected="true"]',
    '.den-pal li[aria-selected="true"]',
    ["@bg=--accent 16%"],
    { state: "palette" },
  ],
  [
    "palette kind",
    ".pal li .kind",
    ".den-pal li .den-kind",
    [...TYPE, "@color=--faint"],
    { state: "palette" },
  ],
  [
    "palette foot",
    ".pal .foot",
    ".den-pal .den-foot",
    ["fontSize", "paddingTop", "paddingLeft", "columnGap", "borderTopWidth"],
    { state: "palette" },
  ],
  [
    "rail",
    ".rail",
    ".den-rail",
    [
      "width",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderRightWidth",
    ],
  ],
  [
    "group heading (first)",
    ".rail > .gh:first-child",
    ".den-rail > .den-rail-group:first-child > .den-gh",
    [...TYPE, ...BOX],
  ],
  [
    "group heading",
    ".rail > .gh:nth-of-type(2)",
    ".den-rail > .den-rail-group:nth-child(2) > .den-gh",
    [...TYPE, ...BOX],
  ],
  [
    "rail item",
    `.ni[data-nav="${ITEM}"]`,
    `.den-ni[data-nav="${ITEM}"]`,
    [...TYPE, ...BOX, "columnGap", "borderTopLeftRadius"],
  ],
  [
    "rail item (hover)",
    `.ni[data-nav="${ITEM}"]`,
    `.den-ni[data-nav="${ITEM}"]`,
    ["fontWeight", "height", "@bg=--sunken", "@color=--text"],
    { state: "hover" },
  ],
  [
    "rail item (current)",
    '.ni[aria-current="page"]',
    '.den-ni[aria-current="page"]',
    [...TYPE, ...BOX, "@color=--text"],
  ],
  [
    "current bar",
    '.ni[aria-current="page"]',
    '.den-ni[aria-current="page"]',
    ["width", "left", "top", "bottom", "borderTopLeftRadius", "@bg=--accent"],
    { pseudo: "::before" },
  ],
  [
    "rail icon",
    `.ni[data-nav="${ITEM}"] svg`,
    `.den-ni[data-nav="${ITEM}"] svg`,
    ["width", "height", "strokeWidth"],
  ],
  [
    "rail label",
    `.ni[data-nav="${ITEM}"] .lbl`,
    `.den-ni[data-nav="${ITEM}"] .den-lbl`,
    ["fontSize", "fontWeight", "lineHeight"],
  ],
  [
    "badge",
    '.ni[data-nav="services"] .bdg',
    '.den-ni[data-nav="services"] .den-bdg',
    [
      ...TYPE,
      "paddingLeft",
      "paddingRight",
      "height",
      "borderTopLeftRadius",
      "@color=--bad",
    ],
  ],
  [
    "pinned row",
    ".ni[data-svc]",
    ".den-ni[data-pin]",
    [...TYPE, ...BOX, "columnGap"],
  ],
  [
    "pinned dot",
    ".ni[data-svc] .dot",
    ".den-ni[data-pin] .den-dot",
    ["width", "height", "marginLeft", "marginRight"],
  ],
  [
    "pinned label",
    ".ni[data-svc] .lbl",
    ".den-ni[data-pin] .den-lbl",
    ["fontSize", "lineHeight"],
  ],
  ["collapsed rail", ".rail", ".den-rail", ["width"], { state: "collapsed" }],
  [
    "collapsed item",
    `.ni[data-nav="${ITEM}"]`,
    `.den-ni[data-nav="${ITEM}"]`,
    ["width", "height", "paddingLeft"],
    { state: "collapsed" },
  ],
];

/**
 * The Settings page (R21, dev.19). The prototype's settings page has no
 * row (.row/.l) or search box; their CSS is in the prototype, so the pair
 * measures an element made with the prototype's classes, injected into its
 * page (opts.inject: [parent selector, html]).
 */
const SETTINGS_PAIRS = [
  [
    "main padding",
    ".main",
    "#den-content",
    ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  ],
  ["page header", ".ph", ".ph", ["columnGap", "marginBottom"]],
  [
    "page title",
    ".ph h1",
    ".ph h1",
    ["fontSize", "fontWeight", "lineHeight", "marginTop", "marginBottom"],
  ],
  [
    "page sub line",
    ".ph .sub",
    ".ph .sub",
    ["fontSize", "marginTop", "@color=--muted"],
  ],
  [
    "search",
    '.ph input[type="search"]',
    "#set-q",
    [
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "width",
      "borderTopWidth",
      "borderTopLeftRadius",
      "@bg=--surface",
      "@color=--text",
    ],
    {
      inject: [
        ".ph",
        '<div class="act"><input type="search" placeholder="Search"></div>',
      ],
    },
  ],
  ["sections", ".set", ".set", ["rowGap", "maxWidth"]],
  [
    "section",
    ".set section",
    ".set section",
    [
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderTopLeftRadius",
      "@bg=--surface",
    ],
  ],
  [
    "section heading",
    ".set h3",
    ".set h3",
    ["fontSize", "fontWeight", "marginTop", "marginBottom"],
  ],
  [
    "section text",
    ".set section > p",
    ".set section > p",
    ["fontSize", "marginBottom", "@color=--muted"],
  ],
  [
    "segmented",
    ".set .seg",
    ".set .seg",
    ["borderTopWidth", "borderTopLeftRadius", "height"],
  ],
  [
    "segment",
    ".set .seg button",
    ".set .seg button",
    [
      "fontSize",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "@color=--muted",
    ],
  ],
  [
    "segment (pressed)",
    '.set .seg button[aria-pressed="true"]',
    '.set .seg button[aria-pressed="true"]',
    ["fontWeight", "@color=--text"],
  ],
  [
    "row",
    ".set section .row",
    ".set .set-row .row",
    ["columnGap", "paddingTop", "paddingBottom"],
    {
      inject: [
        ".set section",
        '<div class="row"><span class="l">Mode</span><span>x</span></div>',
      ],
    },
  ],
  [
    "row label",
    ".set section .row .l",
    ".set .set-row .row .l",
    ["width", "fontSize", "@color=--muted"],
    {
      inject: [
        ".set section",
        '<div class="row"><span class="l">Mode</span><span>x</span></div>',
      ],
    },
  ],
  [
    "swatches",
    ".swatches",
    ".swatches",
    ["columnGap", "marginTop", "paddingBottom"],
  ],
  [
    "swatch",
    ".sw",
    ".sw",
    ["width", "height", "borderTopLeftRadius", "borderTopWidth"],
  ],
  ["swatch label", ".sw span", ".sw span", ["fontSize", "top"]],
  [
    "navigation item",
    ".navlist .it",
    ".navlist .it",
    [
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "columnGap",
      "borderTopLeftRadius",
      "borderTopWidth",
      "@bg=--bg",
    ],
  ],
  [
    "navigation button",
    ".navlist .btn.sm",
    ".navlist .btn.sm",
    [
      "fontSize",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopLeftRadius",
    ],
  ],
];
if (PAGE === "/settings") PAIRS.push(...SETTINGS_PAIRS);

/**
 * Deliberate deviations, each with its reason. Keyed "pair|prop".
 */
const ALLOWLIST = {
  // An entry reads "pair|prop": "why the real shell differs (real data or
  // a11y)". Checked at 1440 and 1024.
  "menu item (checked ✓)|content":
    'the ✓ has alt text "" (content: "✓" / ""): drawn, not read; aria-checked says it (SA dev.18)',
};

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
function compare(prop, a, b) {
  if (prop.startsWith("@")) return a === b;
  const na = num(a);
  const nb = num(b);
  if (na == null || nb == null) return a === b;
  const tol = ["fontSize", "letterSpacing"].includes(prop) ? 0.5 : 1;
  return Math.abs(na - nb) <= tol;
}

/** Computed values for `props` of `sel` (or "missing"). */
async function measure(p, sel, props, pseudo, anchor) {
  return p.evaluate(
    ({ sel, props, pseudo, anchor }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el, pseudo || null);
      const r = el.getBoundingClientRect();
      // Resolve a token to the color the browser computes for it here.
      // (An input has no rendered children: probe beside it.) "--a 16%"
      // is the token mixed into transparent, as a selected row's tint.
      const token = (name) => {
        const probe = document.createElement("span");
        const [tok, pct] = name.split(" ");
        probe.style.backgroundColor = pct
          ? `color-mix(in srgb, var(${tok}) ${pct}, transparent)`
          : `var(${tok})`;
        // A void element (an input) renders no children: probe beside it.
        (el.matches("input, textarea, select, img")
          ? el.parentElement
          : el
        ).appendChild(probe);
        const c = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
      };
      const out = {};
      for (const prop of props) {
        if (prop.startsWith("@below-top")) {
          const want = Math.round(window.innerHeight * 0.12);
          const got = Math.round(r.top);
          out[prop] = Math.abs(got - want) <= 1 ? "12vh" : `${got}px`;
        } else if (prop.startsWith("@below")) {
          // The gap between the menu and the button that opened it.
          const btn = document.querySelector(
            anchor ?? '[aria-expanded="true"], [data-pop="ws"]',
          );
          const gap = btn
            ? Math.round(r.top - btn.getBoundingClientRect().bottom)
            : null;
          out[prop] = gap === 6 ? "6px below" : `${gap}px below`;
        } else if (prop.startsWith("@")) {
          const [what, tok] = prop.slice(1).split("=");
          const got = what === "bg" ? cs.backgroundColor : cs.color;
          out[prop] = got === token(tok) ? "matches " + tok : `${got} ≠ ${tok}`;
        } else if (prop === "height" && !pseudo)
          out[prop] = r.height.toFixed(1) + "px";
        else if (prop === "width" && !pseudo)
          out[prop] = r.width.toFixed(1) + "px";
        else out[prop] = cs[prop];
      }
      return out;
    },
    { sel, props, pseudo, anchor: anchor ?? null },
  );
}

async function openProto(browser, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  await ctx.addInitScript(
    ({ brand, mode }) => {
      localStorage.setItem("denshell.brand", JSON.stringify(brand));
      localStorage.setItem("denshell.mode", JSON.stringify(mode));
      localStorage.setItem("denshell.collapsed", "false");
    },
    { brand: BRAND, mode: MODE },
  );
  // Web fonts are a theme's assets, not the shell's CSS: the prototype's
  // come from Google Fonts, so both sides measure with the fallbacks unless
  // --proto-fonts is given (a "normal" line-height follows the font).
  if (!args["proto-fonts"])
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const p = await ctx.newPage();
  await p.goto(pathToFileURL(path.resolve(args.proto)).href);
  await p.waitForSelector(".rail .ni");
  // One pin: the prototype's first demo service (its pins must exist).
  await p.evaluate(() => {
    const s = DATA.services[0];
    localStorage.setItem(
      "denshell.pins",
      JSON.stringify([`${s.repo}/${s.service}`]),
    );
  });
  await p.reload();
  await p.waitForSelector(".rail .ni[data-svc]");
  const id = PROTO_PAGE[PAGE] ?? "services";
  await p.click(`.ni[data-nav="${id}"]`).catch(() => {});
  await p.waitForTimeout(150);
  return { ctx, p };
}

async function openReal(browser, width) {
  const ctx = await browser.newContext({
    viewport: { width, height: 800 },
    colorScheme: MODE,
  });
  // The rail expanded, as the prototype starts.
  await fetch(`${REAL}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shell: { collapsed: false } }),
  });
  const p = await ctx.newPage();
  // Demo health: everything up but one, so the Services badge shows.
  const real = await (await fetch(`${REAL}/api/health`)).json().catch(() => []);
  const rows = real.map((r, i) => ({
    ...r,
    ok: i !== 1,
    status: 200,
    url: `http://${r.repo}/healthz`,
    checkType: "http",
  }));
  const sse =
    rows
      .map((r) => `data: ${JSON.stringify({ type: "result", result: r })}\n\n`)
      .join("") + 'data: {"type":"done"}\n\n';
  await p.route("**/api/health/stream**", (r) =>
    r.fulfill({ status: 200, contentType: "text/event-stream", body: sse }),
  );
  await p.route(/\/api\/health(\?|$)/, (r) => r.fulfill({ json: rows }));
  // Locked, as the prototype starts (this machine's sudo state aside).
  await p.route("**/api/sudo-password/status", (r) =>
    r.fulfill({ json: { set: false, passwordless: false } }),
  );
  await p.route("**/api/sudo-password/vault-status", (r) =>
    r.fulfill({ json: { opAvailable: false, hasStored: false } }),
  );
  await p.goto(REAL + PAGE);
  await p.waitForSelector(".den-rail .den-ni");
  await p.waitForTimeout(1800);
  await p.evaluate(() => window.closeChangelog?.());
  await p.evaluate(() => document.activeElement?.blur());
  // The Workspace part shows once header.js has the workspaces.
  await p.waitForSelector("#ws-pill:not([hidden])").catch(() => {});
  // The prototype always shows the unread dot; show ours to measure it.
  await p.evaluate(() => {
    const pip = document.getElementById("v-pip");
    if (pip) pip.style.display = "block";
  });
  await p.waitForTimeout(200);
  return { ctx, p };
}

async function main() {
  const browser = await chromium.launch();
  let restoreTheme = null;
  if (args.theme) {
    const cur = await (await fetch(`${REAL}/api/settings`)).json();
    restoreTheme = cur.appearance?.theme ?? null;
    await fetch(`${REAL}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appearance: { theme: args.theme, mode: MODE } }),
    });
  }
  const rows = [];
  let failed = 0;
  try {
    for (const width of WIDTHS) {
      const proto = await openProto(browser, width);
      const real = await openReal(browser, width);
      if (args.shots) {
        await sideBySide(browser, proto.p, real.p, width);
        await openMenus(proto.p, real.p);
        await sideBySide(browser, proto.p, real.p, width, "-menu");
        await closeMenus(proto.p, real.p);
        for (const state of Object.keys(OVERLAYS)) {
          await openOverlay(proto.p, real.p, state);
          await sideBySide(browser, proto.p, real.p, width, `-${state}`);
          await closeMenus(proto.p, real.p);
        }
      }
      for (const [name, ps, rs, props, opts = {}] of PAIRS) {
        if (opts.state === "collapsed") await toggleRail(proto.p, real.p);
        if (opts.state === "hover") {
          await proto.p.hover(ps);
          await real.p.hover(rs);
        }
        if (opts.state === "menu") await openMenus(proto.p, real.p);
        if (OVERLAYS[opts.state])
          await openOverlay(proto.p, real.p, opts.state);
        if (opts.inject)
          await proto.p.evaluate(([parent, html]) => {
            const host = document.querySelector(parent);
            if (host && !host.querySelector("[data-fid]")) {
              const box = document.createElement("div");
              box.dataset.fid = "1";
              box.innerHTML = html;
              host.append(...box.children);
              host.dataset.fid = "1";
            }
          }, opts.inject);
        const a = await measure(
          proto.p,
          ps,
          props,
          opts.pseudo,
          opts.anchor?.[0],
        );
        const b = await measure(
          real.p,
          rs,
          props,
          opts.pseudo,
          opts.anchor?.[1],
        );
        if (opts.state === "hover") {
          await proto.p.mouse.move(0, 0);
          await real.p.mouse.move(0, 0);
        }
        if (opts.state === "menu" || OVERLAYS[opts.state])
          await closeMenus(proto.p, real.p);
        if (opts.state === "collapsed") await toggleRail(proto.p, real.p);
        for (const prop of props) {
          const pv = a ? a[prop] : "missing";
          const rv = b ? b[prop] : "missing";
          const same = a && b && compare(prop, pv, rv);
          const allowed = ALLOWLIST[`${name}|${prop}`];
          const ok = same || !!allowed;
          if (!ok) failed++;
          rows.push({
            width,
            pair: name,
            prop,
            proto: pv,
            real: rv,
            result: same ? "ok" : allowed ? "allowed: " + allowed : "FAIL",
          });
        }
      }
      await proto.ctx.close();
      await real.ctx.close();
    }
  } finally {
    if (args.theme)
      await fetch(`${REAL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appearance: { theme: restoreTheme } }),
      });
    await browser.close();
  }
  const w = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(
    `shell fidelity: ${PAGE}, prototype brand ${BRAND}, real theme ${args.theme ?? "(current)"}, ${MODE}`,
  );
  console.log(
    w("width", 6) +
      w("pair", 24) +
      w("prop", 22) +
      w("prototype", 26) +
      w("real", 26) +
      "result",
  );
  for (const r of rows)
    console.log(
      w(r.width, 6) +
        w(r.pair, 24) +
        w(r.prop, 22) +
        w(r.proto, 26) +
        w(r.real, 26) +
        r.result,
    );
  console.log(`${rows.length} checks, ${failed} failed`);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(rows, null, 2));
  process.exit(failed ? 1 : 0);
}

/** Open the Workspace menu on both sides (the prototype's and Den's). */
async function openMenus(protoPage, realPage) {
  await protoPage.click('.scope [data-pop="ws"]');
  await realPage.click("#ws-pill");
  await protoPage.waitForSelector(".pop");
  await realPage.waitForSelector(".den-pop");
  // Measure rest states: no row hovered or focused-tinted.
  await protoPage.mouse.move(0, 0);
  await realPage.mouse.move(0, 0);
  await realPage.evaluate(() => document.querySelector(".den-pop")?.focus());
}
async function closeMenus(protoPage, realPage) {
  await protoPage.keyboard.press("Escape");
  await realPage.keyboard.press("Escape");
  await protoPage.waitForTimeout(50);
}

/**
 * Collapse or expand the rail on both sides, waiting for Den to store it:
 * two toggles in flight can land out of order and leave the fixture's
 * user.yml collapsed for the next run.
 */
async function toggleRail(protoPage, realPage) {
  await protoPage.click('[data-act="collapse"]');
  await Promise.all([
    realPage
      .waitForResponse(
        (r) =>
          r.url().endsWith("/api/settings") && r.request().method() === "POST",
        { timeout: 5000 },
      )
      .catch(() => {}),
    realPage.click('.den-rail [data-act="collapse"]'),
  ]);
  await protoPage.waitForTimeout(100);
  await realPage.waitForTimeout(100);
}

/**
 * The top bar's overlays (0.3.0-dev.20): what opens each on both sides,
 * and what to wait for.
 */
const OVERLAYS = {
  user: ['[data-pop="user"]', ".pop", "#appearance-btn", ".den-pop"],
  lock: ['[data-pop="lock"]', ".pop form", "#den-lock", "#den-lock-pop form"],
  drawer: ['[data-act="status"]', ".drawer", "#den-status", ".den-drawer"],
  palette: ['[data-act="palette"]', ".pal", "#den-search", ".den-pal"],
};
async function openOverlay(protoPage, realPage, state) {
  const [pOpen, pWait, rOpen, rWait] = OVERLAYS[state];
  await protoPage.click(pOpen);
  await realPage.click(rOpen);
  await protoPage.waitForSelector(pWait);
  await realPage.waitForSelector(rWait);
  await protoPage.mouse.move(0, 0);
  await realPage.mouse.move(0, 0);
  await protoPage.waitForTimeout(50);
}

/** One PNG: the prototype on the left, the real page on the right. */
async function sideBySide(browser, protoPage, realPage, width, suffix = "") {
  fs.mkdirSync(args.shots, { recursive: true });
  const a = (await protoPage.screenshot()).toString("base64");
  const b = (await realPage.screenshot()).toString("base64");
  const ctx = await browser.newContext({
    viewport: { width: width * 2 + 24, height: 860 },
  });
  const p = await ctx.newPage();
  await p.setContent(
    `<body style="margin:0;background:#888;display:flex;gap:24px;font:12px sans-serif">` +
      `<figure style="margin:0"><figcaption style="padding:4px">prototype (${BRAND})</figcaption><img src="data:image/png;base64,${a}"></figure>` +
      `<figure style="margin:0"><figcaption style="padding:4px">Den (${args.theme ?? "theme"})</figcaption><img src="data:image/png;base64,${b}"></figure></body>`,
  );
  const name = `${PAGE.replace(/\W+/g, "") || "home"}-${width}-${BRAND}-${MODE}${suffix}.png`;
  await p.screenshot({ path: path.join(args.shots, name), fullPage: true });
  await ctx.close();
}

await main();
