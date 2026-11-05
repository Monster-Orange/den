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
 * the user menu, the chip, the rail, its group
 * headings, items in their default, hover and current states, the icon,
 * the current bar, a pinned row and its dot, a badge, and the collapsed
 * rail) and compares their computed font-size, font-weight, line-height,
 * letter-spacing, text-transform, padding, gap, border radius, height and
 * width. A mismatch beyond 1px (0.5px for type) fails, unless the
 * ALLOWLIST below names it with a reason. Colors are themes' business: a
 * state's color is checked against the page's own token (hover is
 * --sunken, the current bar is --accent) rather than across the two.
 *
 * --theme sets the real page's theme for the run (through /api/settings,
 * restored after); --brand picks the prototype's (den or mo).
 * --shots writes each pair of full-page screenshots side by side, and a
 * second pair with the Workspace menu open (-menu). The
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
    ".den-title",
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
  ["scope key (workspace)", '.scope [data-pop="ws"] .k', "#ws-pill .den-k", TYPE],
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
  [
    "status chip slot",
    '.chip[data-act="status"]',
    ".den-top > .health",
    [
      "fontSize",
      "paddingLeft",
      "paddingRight",
      "paddingTop",
      "paddingBottom",
      "borderTopLeftRadius",
      "borderTopWidth",
    ],
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
 * Deliberate deviations, each with its reason. Keyed "pair|prop".
 */
const ALLOWLIST = {
  // None needed in dev.17. An entry reads:
  // "pair|prop": "why the real shell differs (real data or a11y)",
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
async function measure(p, sel, props, pseudo) {
  return p.evaluate(
    ({ sel, props, pseudo }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el, pseudo || null);
      const r = el.getBoundingClientRect();
      // Resolve a token to the color the browser computes for it here.
      const token = (name) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${name})`;
        el.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      };
      const out = {};
      for (const prop of props) {
        if (prop.startsWith("@below")) {
          // The gap between the menu and the button that opened it.
          const btn = document.querySelector('[aria-expanded="true"], [data-pop="ws"]');
          const gap = btn ? Math.round(r.top - btn.getBoundingClientRect().bottom) : null;
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
    { sel, props, pseudo },
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
      }
      for (const [name, ps, rs, props, opts = {}] of PAIRS) {
        if (opts.state === "collapsed") {
          await proto.p.click('[data-act="collapse"]');
          await real.p.click('.den-rail [data-act="collapse"]');
          await proto.p.waitForTimeout(100);
          await real.p.waitForTimeout(100);
        }
        if (opts.state === "hover") {
          await proto.p.hover(ps);
          await real.p.hover(rs);
        }
        if (opts.state === "menu") await openMenus(proto.p, real.p);
        const a = await measure(proto.p, ps, props, opts.pseudo);
        const b = await measure(real.p, rs, props, opts.pseudo);
        if (opts.state === "hover") {
          await proto.p.mouse.move(0, 0);
          await real.p.mouse.move(0, 0);
        }
        if (opts.state === "menu") await closeMenus(proto.p, real.p);
        if (opts.state === "collapsed") {
          await proto.p.click('[data-act="collapse"]');
          await real.p.click('.den-rail [data-act="collapse"]');
          await proto.p.waitForTimeout(100);
          await real.p.waitForTimeout(100);
        }
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
