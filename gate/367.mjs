/* eslint-env browser */
// Live check for #367: the push timeout and time-to-live are Settings › Notifications rows with permissive
// defaults, and doctor names the contact push services get (warning when there is no https address).
// Read only.
export const issue = 367;
export const clauses = [
  "the push timeout and time-to-live are rows in Settings › Notifications, with the same permissive defaults",
  "push services are given this install's https address (web.url) as the contact when one is set, otherwise a mailto fallback",
  "doctor says plainly when push may not reach phones because there is no https address, and what to set",
  "en/es/ja",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;
const ROWS = {
  "notifications.push_timeout": [1, 3600],
  "notifications.push_ttl": [0, 2419200],
};

// Read only (issue 845): reads doctor's push line and Settings › Notifications' rows.
export const readOnly = true;

export async function setup(ctx) {
  const d = ctx.cli(["doctor"]);
  const line =
    String(d.out + d.err)
      .split("\n")
      .find((l) => /^\s*push\s+[✓⚠]/.test(l))
      ?.trim() ?? null;
  return { push: line };
}

export async function run(ctx, s) {
  await ctx.goto(ctx.page, "/settings#notifications");
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
          min: input ? Number(input.min) : null,
          max: input ? Number(input.max) : null,
        };
      }),
    Object.keys(ROWS),
  );
  await ctx.page
    .locator('.set-row[data-setting="notifications.push_timeout"]')
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await ctx.shot(`push-rows-${ctx.browser}-${ctx.width}`);
  return { ...s, rows };
}

export function expect(cells) {
  const r0 = cells[0].result;
  const push = r0.push ?? "";
  const https = /push services are given https:\/\/\S+ as the contact/.test(
    push,
  );
  const fallback =
    /push alerts may not reach phones: with no https address, push services are given mailto:\S+ as the contact/.test(
      push,
    );
  return [
    {
      clause: clauses[0],
      ok: cells.every(({ result }) =>
        result.rows.every(
          (x) =>
            x.shown &&
            x.value !== null &&
            x.min === ROWS[x.id][0] &&
            x.max === ROWS[x.id][1],
        ),
      ),
      detail:
        cells
          .map(
            ({ cell, result }) =>
              `${cell.browser}: ${result.rows.map((x) => `${x.id} ${x.shown ? `${x.value} (${x.min}..${x.max})` : "missing"}`).join(", ")}`,
          )
          .join("; ") + " (defaults 30 s and 86400 s)",
      evidence: cells.map(
        ({ cell }) => `push-rows-${cell.browser}-${cell.width}.png`,
      ),
    },
    {
      clause: clauses[1],
      ok: https || fallback,
      detail: push || "doctor has no push line",
    },
    fallback
      ? {
          clause: clauses[2],
          ok: /Set one in Settings › Den's address .*web url https:\/\//.test(
            push,
          ),
          detail: push,
        }
      : {
          clause: clauses[2],
          ok: null,
          skip: "needs-no-https-address",
          detail: `this install has an https address: ${push || "no push line"}`,
        },
    {
      clause: clauses[3],
      ok: null,
      skip: "needs-language-switch",
      detail: "reading es and ja means changing the bed's language setting",
    },
  ];
}
