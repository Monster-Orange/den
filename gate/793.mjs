/* eslint-env browser */
// Live check for #793: every page and every pop-up uses the theme's sans font, never the browser's serif.
// Read-only: opens pages and What's new, closes it again. No agents, no settings changed.
export const issue = 793;
export const clauses = [
  "every page's <body> uses the theme's sans font, never serif",
  "What's new opened on a page whose font sits on the main area (Agents, Settings) draws its text and buttons in the page body's font, never serif",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280, 390] };
export const timeoutMs = 120000;
const PAGES = [
  "/agents",
  "/settings",
  "/verify",
  "/edge",
  "/server-agent",
  "/services",
  "/releases",
  "/terminals",
];
const SERIF = /(^|,)\s*("?(times|times new roman|georgia|serif)"?)\s*(,|$)/i;
const first = (ff) =>
  (ff || "").split(",")[0].trim().replace(/"/g, "").toLowerCase();

export async function setup() {
  return {};
}

export async function run(ctx, s) {
  const pages = [];
  for (const p of PAGES) {
    await ctx.goto(ctx.page, p);
    const ff = await ctx.page.evaluate(
      () => getComputedStyle(document.body).fontFamily,
    );
    pages.push({ p, ff });
  }
  const pops = [];
  for (const p of ["/agents", "/settings"]) {
    await ctx.goto(ctx.page, p);
    await ctx.page.evaluate(
      () => window.openChangelog && window.openChangelog(),
    );
    await ctx.until(
      () =>
        ctx.page.evaluate(
          () => !!document.querySelector("dialog[open], [role=dialog]"),
        ),
      10000,
    );
    const r = await ctx.page.evaluate(() => {
      const d =
        document.querySelector("dialog[open]") ||
        document.querySelector("[role=dialog]");
      if (!d) return null;
      const els = [...d.querySelectorAll("h2,h3,li,p,button")].slice(0, 40);
      return {
        body: getComputedStyle(document.body).fontFamily,
        fonts: [...new Set(els.map((e) => getComputedStyle(e).fontFamily))],
      };
    });
    await ctx.shot(`whatsnew-${p.slice(1)}-${ctx.browser}-${ctx.width}`);
    await ctx.page.keyboard.press("Escape").catch(() => {});
    pops.push({ p, ...(r || { body: "", fonts: [] }), found: !!r });
  }
  return { ...s, pages, pops };
}

export function expect(cells) {
  const all = (f) => cells.every(({ result }) => f(result));
  const d = (f) =>
    cells
      .map(({ cell, result }) => `${cell.browser}@${cell.width}: ${f(result)}`)
      .join("; ");
  return [
    {
      clause: clauses[0],
      ok: all((r) => r.pages.every((x) => x.ff && !SERIF.test(x.ff))),
      detail: d((r) => r.pages.map((x) => `${x.p} ${first(x.ff)}`).join(", ")),
      evidence: [],
    },
    {
      clause: clauses[1],
      ok: all((r) =>
        r.pops.every(
          (x) =>
            x.found &&
            x.fonts.length > 0 &&
            x.fonts.every((f) => !SERIF.test(f) && first(f) === first(x.body)),
        ),
      ),
      detail: d((r) =>
        r.pops
          .map(
            (x) =>
              `${x.p}: ${x.found ? x.fonts.map(first).join("|") : "no dialog"} (body ${first(x.body)})`,
          )
          .join("; "),
      ),
      evidence: cells.flatMap(({ cell }) =>
        ["agents", "settings"].map(
          (p) => `whatsnew-${p}-${cell.browser}-${cell.width}.png`,
        ),
      ),
    },
  ];
}

export async function teardown(ctx) {
  await ctx.page?.keyboard.press("Escape").catch(() => {});
}
