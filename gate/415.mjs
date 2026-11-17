// gate/415.mjs: the Report form says who can see a report (issue 415).
// The bed is a Den: its report targets are Den's own. Opens Report, walks
// to Review, reads the pill and the line above Send, and closes it
// without sending anything.
export const issue = 415;
export const clauses = [
  "a public target shows the Public repository pill and the visible-to-everyone warning",
  "a private or internal target shows its own pill and no public warning",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;

export async function setup(ctx) {
  const r = await ctx.api("/api/report");
  const info = r.ok ? await r.json() : {};
  const repos = Array.isArray(info.repos) ? info.repos : [];
  const vis = (x) =>
    x.visibility === "private" || x.visibility === "internal"
      ? x.visibility
      : "public";
  return {
    enabled: info.enabled !== false && r.ok,
    pub: repos.find((x) => vis(x) === "public")?.repo || null,
    priv: repos.find((x) => vis(x) !== "public")?.repo || null,
  };
}

/** Review's pill and notes for the target chosen now. */
const read = (page) =>
  page.evaluate(() => {
    const d = document.querySelector("dialog.fb-dlg");
    const txt = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    return {
      pill: txt(d?.querySelector(".fb-dest .fb-pill")),
      vis: d?.querySelector(".fb-dest .fb-pill")?.getAttribute("data-vis"),
      warn: d ? d.querySelectorAll(".fb-warn").length : -1,
      note: d ? d.querySelectorAll("[data-vis-note]").length : -1,
    };
  });

export async function run(ctx, state) {
  if (!state.enabled || !state.pub) return { skipped: true };
  const page = ctx.page;
  // This cell's name, for its screenshots: the browser and the width.
  const b = ctx.browser;
  const cell = `${typeof b === "string" ? b : b?.browserType?.().name?.() || "browser"}-${ctx.width}`;
  const shots = {
    pub: `report-public-${cell}`,
    priv: `report-private-${cell}`,
  };
  await page.goto(ctx.url);
  await page.locator("[data-den-report]").first().click();
  const dlg = page.locator("dialog.fb-dlg");
  await dlg.locator('[data-f="title"]').fill("issue 415 live check");
  await dlg.locator('[data-act="next"]').click();
  await dlg.locator('[data-act="review"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector("dialog.fb-dlg")?.getAttribute("data-step") ===
      "review",
  );
  const sel = dlg.locator('select[data-f="repo"]');
  const pick = async (repo) => {
    if (await sel.count()) await sel.selectOption(repo);
    await page.waitForTimeout(300);
  };
  await pick(state.pub);
  const pub = await read(page);
  await ctx.shot(shots.pub);
  let priv = null;
  if (state.priv) {
    await pick(state.priv);
    priv = await read(page);
    await ctx.shot(shots.priv);
  }
  return { pub, priv, shots };
}

export async function teardown(ctx) {
  // Nothing was sent: Esc, then Discard the typed title.
  const page = ctx.page;
  if (!page) return;
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .locator('dialog.fb-dlg [data-act="discard"]')
    .click({ timeout: 2000 })
    .catch(() => {});
}

export function expect(cells) {
  const ran = cells.filter((c) => c.result && !c.result.skipped);
  if (!ran.length)
    return [
      { clause: clauses[0], ok: null, skip: "needs-report-target" },
      { clause: clauses[1], ok: null, skip: "needs-private-target" },
    ];
  const pubOk = ran.every(
    (c) =>
      c.result.pub.vis === "public" &&
      c.result.pub.warn === 1 &&
      c.result.pub.note === 0,
  );
  const withPriv = ran.filter((c) => c.result.priv);
  return [
    {
      clause: clauses[0],
      ok: pubOk,
      evidence: ran.map((c) => c.result.shots.pub),
    },
    withPriv.length
      ? {
          clause: clauses[1],
          ok: withPriv.every(
            (c) =>
              c.result.priv.vis !== "public" &&
              c.result.priv.warn === 0 &&
              c.result.priv.note === 1,
          ),
          evidence: withPriv.map((c) => c.result.shots.priv),
        }
      : { clause: clauses[1], ok: null, skip: "needs-private-target" },
  ];
}
