/* eslint-env browser */
// Live check for #143: the readiness waits that were a fixed 1.5 s (and 45 s) are settings with permissive
// defaults, shown on Settings › Server. Read only: nothing is saved.
export const issue = 143;
export const clauses = [
  "a fixed wait that is product behaviour becomes a setting with a permissive default",
  "a clean full run under the same load is the check, not a re-run",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 90000;
const ROWS = ["server.ready_probe", "server.start_wait"];

// Read only (issue 845): reads /api/settings and Settings › Server's wait rows.
export const readOnly = true;

export async function setup(ctx) {
  const s = await ctx.api("/api/settings");
  return { webReady: s?.web_ready ?? null };
}

export async function run(ctx, s) {
  await ctx.goto(ctx.page, "/settings");
  await ctx.page
    .waitForSelector(".set-row[data-setting]", { timeout: 15000 })
    .catch(() => {});
  const rows = await ctx.page.evaluate(
    (ids) =>
      ids.map((id) => {
        const row = document.querySelector(`.set-row[data-setting="${id}"]`);
        const input = row?.querySelector('input[type="number"]');
        return {
          id,
          shown: !!row,
          value: input ? Number(input.value) : null,
          min: input?.min ?? null,
          max: input?.max ?? null,
        };
      }),
    ROWS,
  );
  const first = rows.find((r) => r.shown);
  if (first)
    await ctx.page
      .locator(`.set-row[data-setting="${first.id}"]`)
      .scrollIntoViewIfNeeded()
      .catch(() => {});
  await ctx.shot(`server-rows-${ctx.browser}-${ctx.width}`);
  return { ...s, rows };
}

export function expect(cells) {
  const ok = cells.every(({ result: r }) => {
    const w = r.webReady;
    return (
      !!w &&
      w.probeSeconds >= 1 &&
      w.startSeconds >= 1 &&
      r.rows.every((x) => x.shown && x.value !== null && x.max === "3600")
    );
  });
  const w = cells[0]?.result.webReady;
  return [
    {
      clause: clauses[0],
      ok,
      detail:
        `API web_ready ${JSON.stringify(w)} (defaults 10 s and 120 s, were 1.5 s and 45 s); ` +
        cells
          .map(
            ({ cell, result }) =>
              `${cell.browser}: ${result.rows.map((x) => `${x.id} ${x.shown ? `${x.value} (${x.min}..${x.max})` : "missing"}`).join(", ")}`,
          )
          .join("; "),
      evidence: cells.map(
        ({ cell }) => `server-rows-${cell.browser}-${cell.width}.png`,
      ),
    },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-loaded-full-test-run",
      detail: "a full test-suite run on a loaded machine is CI's, not a bed's",
    },
  ];
}
