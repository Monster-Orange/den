/* eslint-env browser */
// Live check for #394: a rail change is kept when the person leaves the page at once.
// Pins one made-up name, gate-394-pin, per cell; the person's pins are put back in teardown.
export const issue = 394;
export const clauses = [
  "a rail change, then a link clicked at once: the next page, after the server's copy arrives, shows the change",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;
const PIN = "gate-394-pin";

const shellOf = async (ctx) => (await ctx.api("/api/settings"))?.shell ?? {};
const savePins = (ctx, pins) =>
  ctx.api("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shell: { pins } }),
  });

export async function setup(ctx) {
  const pins = (await shellOf(ctx)).pins;
  return { pinsWas: Array.isArray(pins) ? pins : [] };
}

export async function run(ctx, s) {
  const tag = `${ctx.browser}-${ctx.width}`;
  const page = ctx.page;
  await savePins(ctx, [...s.pinsWas.filter((p) => p !== PIN), PIN]);
  await ctx.goto(page, "/settings");
  const sel = `#den-rail [data-pin="${PIN}"]`;
  const shown = await page
    .waitForSelector(sel, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  // Unpin, and in the same tick click a rail link.
  const clicked = await page.evaluate((id) => {
    const link = document.querySelector('#den-rail [data-nav="logs"]');
    if (!window.denShell || !link) return false;
    window.denShell.unpin(id);
    link.click();
    return true;
  }, PIN);
  await page.waitForURL(/\/logs(\?|$)/, { timeout: 15000 }).catch(() => {});
  // The next page settles: the server's copy is fetched and applied.
  await page
    .waitForResponse(
      (r) =>
        r.request().method() === "GET" &&
        new URL(r.url()).pathname === "/api/settings",
      { timeout: 10000 },
    )
    .catch(() => {});
  await page
    .waitForSelector("#den-rail[data-prefs-applied]", {
      state: "attached",
      timeout: 10000,
    })
    .catch(() => {});
  const afterLeave = (await page.$$(sel)).length;
  await page.reload();
  await page
    .waitForSelector("#den-rail[data-prefs-applied]", {
      state: "attached",
      timeout: 10000,
    })
    .catch(() => {});
  const afterReload = (await page.$$(sel)).length;
  const serverPins = (await shellOf(ctx)).pins ?? [];
  await ctx.shot(`rail-${tag}`);
  return {
    shown,
    clicked,
    at: new URL(page.url()).pathname,
    afterLeave,
    afterReload,
    onServer: serverPins.includes(PIN),
  };
}

export function expect(cells) {
  return [
    {
      clause: clauses[0],
      ok: cells.every(
        ({ result: r }) =>
          r.shown &&
          r.clicked &&
          r.at === "/logs" &&
          r.afterLeave === 0 &&
          r.afterReload === 0 &&
          !r.onServer,
      ),
      detail: cells
        .map(
          ({ cell, result: r }) =>
            `${cell.browser}: pinned shown ${r.shown}, clicked ${r.clicked}, on ${r.at}, pin rows after leaving ${r.afterLeave}, after reload ${r.afterReload}, still on the server ${r.onServer}`,
        )
        .join("; "),
      evidence: cells.map(
        ({ cell }) => `rail-${cell.browser}-${cell.width}.png`,
      ),
    },
  ];
}

export async function teardown(ctx, s) {
  if (s && Array.isArray(s.pinsWas))
    await savePins(ctx, s.pinsWas).catch(() => {});
}
