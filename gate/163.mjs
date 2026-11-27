/* eslint-env browser */
// Live check for #163: Settings has "Keep agents running after logout", on by default (or offered over an
// install that ran at login before). A real logout is never asked for, so the survive clauses are not run.
// Read only.
export const issue = 163;
export const clauses = [
  "Den's agents and sessions host survive logout and come back on login with no person action",
  "the person sees which agents ran while they were away",
  "a Setting (on by default) to turn it off",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 90000;

// Read only (issue 845): reads /api/settings and Settings' keep-running switch.
export const readOnly = true;

export async function setup(ctx) {
  const s = await ctx.api("/api/settings");
  return {
    keep: s?.keep_running_after_logout ?? null,
    unset: s?.keep_running_unset ?? null,
  };
}

export async function run(ctx, s) {
  await ctx.goto(ctx.page, "/settings");
  const row = ctx.page.locator('.set-row[data-setting="agents.keep_running"]');
  await row.waitFor({ timeout: 15000 }).catch(() => {});
  await ctx.page
    .waitForSelector(
      '.set-row[data-setting="agents.keep_running"] [data-keep-on]',
      { timeout: 15000 },
    )
    .catch(() => {});
  const seen = await ctx.page.evaluate(() => {
    const r = document.querySelector(
      '.set-row[data-setting="agents.keep_running"]',
    );
    const box = r?.querySelector('input[type="checkbox"][data-keep-on]');
    return { row: !!r, box: !!box, checked: box ? box.checked : null };
  });
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await ctx.shot(`keep-running-${ctx.browser}-${ctx.width}`);
  return { ...s, ...seen };
}

export function expect(cells) {
  const r0 = cells[0].result;
  return [
    {
      clause: clauses[0],
      ok: null,
      skip: "needs-logout",
      detail:
        "proven only by a real logout or reboot, which a gate never asks for",
    },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-logout",
      detail: "needs agents that ran while the person was logged out",
    },
    {
      clause: clauses[2],
      ok:
        typeof r0.keep === "boolean" &&
        (r0.keep === true || r0.unset === true) &&
        cells.every(({ result: r }) => r.row && r.box && r.checked === r.keep),
      detail:
        `API keep_running_after_logout ${r0.keep}, unset over a login install ${r0.unset}; ` +
        cells
          .map(
            ({ cell, result: r }) =>
              `${cell.browser}: row ${r.row}, switch ${r.box ? (r.checked ? "on" : "off") : "missing"}`,
          )
          .join("; "),
      evidence: cells.map(
        ({ cell }) => `keep-running-${cell.browser}-${cell.width}.png`,
      ),
    },
  ];
}
