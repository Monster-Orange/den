/* eslint-env browser */
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
const first = (ff) => {
  const [head = ""] = (ff || "").split(",");
  return head.trim().replace(/"/g, "").toLowerCase();
};

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
    const opened = await ctx.page
      .click("#version-pill", { timeout: 10000 })
      .then(() => "chip")
      .catch((e) => `chip not clicked: ${String(e.message).split("\n", 1)}`);
    await ctx.until(
      () =>
        ctx.page.evaluate(
          () => !!document.querySelector("dialog#cl-overlay[open]"),
        ),
      10000,
    );
    const r = await ctx.page.evaluate(() => {
      const d = document.querySelector("dialog#cl-overlay[open]");
      if (!d)
        return {
          missing:
            [...document.querySelectorAll("dialog[open]")]
              .map((e) => e.id || e.className)
              .join(" ") || "no dialog open",
        };
      const font = (e) => getComputedStyle(e).fontFamily;
      const els = [...d.querySelectorAll("h2,h3,li,p,a,button")];
      const footer = d.querySelector("#cl-got-it-btn")?.parentElement;
      const foot = footer ? [...footer.querySelectorAll("button, a")] : [];
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
    pops.push(
      r.missing
        ? {
            p,
            found: false,
            why: `${opened}; ${r.missing}`,
            fonts: [],
            foot: [],
          }
        : { p, found: true, ...r },
    );
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
          .map((x) =>
            x.found
              ? `${x.p}: ${x.n} elements ${x.fonts.map(first).join("|")}, footer ${x.footN} ${x.foot.map(first).join("|")} (body ${first(x.body)})`
              : `${x.p}: no What's new (${x.why})`,
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
