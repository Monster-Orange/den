/* eslint-env browser */
// Live check for #793: every page and every pop-up uses the theme's sans font, never the browser's serif.
// Read only: reads each page's body font and What's new's fonts; opens and closes What's new.
export const readOnly = true;
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
          () => !!document.querySelector("dialog#cl-overlay[open]"),
        ),
      10000,
    );
    const r = await ctx.page.evaluate(() => {
      const d = document.querySelector("dialog#cl-overlay[open]");
      if (!d) return null;
      const font = (e) => getComputedStyle(e).fontFamily;
      const els = [...d.querySelectorAll("h2,h3,li,p,a,button")];
      const foot = [...d.querySelectorAll(".dk-ft button, .dk-ft a")];
      return {
        body: font(document.body),
        n: els.length,
        fonts: [...new Set(els.map(font))],
        footN: foot.length,
        foot: [...new Set(foot.map(font))],
      };
    });
    await ctx.shot(`whatsnew-${p.slice(1)}-${ctx.browser}-${ctx.width}`);
    await ctx.page.keyboard.press("Escape").catch(() => {});
    pops.push({
      p,
      ...(r || { body: "", n: 0, fonts: [], footN: 0, foot: [] }),
      found: !!r,
    });
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
            x.foot.length > 0 &&
            [...x.fonts, ...x.foot].every(
              (f) => !SERIF.test(f) && first(f) === first(x.body),
            ),
        ),
      ),
      detail: d((r) =>
        r.pops
          .map(
            (x) =>
              `${x.p}: ${x.found ? `${x.n} elements ${x.fonts.map(first).join("|")}, footer ${x.footN} ${x.foot.map(first).join("|")}` : "no What's new"} (body ${first(x.body)})`,
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
