/* eslint-env browser */
// Live check for #367: the push timeout and time-to-live are Settings › Notifications rows with permissive
// defaults, and doctor names the contact push services get (warning when there is no https address).
// The rows are read in en, es and ja: run switches the bed's language (the person's setting) and puts the
// value it found back, even when a read throws.
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
const LANGS = ["en", "es", "ja"];

async function setLanguage(ctx, language) {
  return ctx.api("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language }),
  });
}

async function language(ctx) {
  const r = await ctx.api("/api/settings");
  if (!r.ok) throw new Error(`/api/settings: HTTP ${r.status}`);
  return (await r.json())?.language ?? null;
}

export async function setup(ctx) {
  const d = ctx.cli(["doctor"]);
  const line =
    String(d.out + d.err)
      .split("\n")
      .find((l) => /^\s*push\s+[✓⚠]/.test(l))
      ?.trim() ?? null;
  return { push: line };
}

/** The push rows as the page draws them: each row's label and number, and the page's language. */
async function readRows(ctx) {
  await ctx.goto(ctx.page, "/settings#notifications");
  await ctx.page
    .waitForSelector(".set-row[data-setting]", { timeout: 15000 })
    .catch(() => {});
  return ctx.page.evaluate(
    (ids) => ({
      lang: document.documentElement.lang,
      rows: ids.map((id) => {
        const row = document.querySelector(`.set-row[data-setting="${id}"]`);
        const input = row?.querySelector('input[type="number"]');
        return {
          id,
          shown: !!row,
          label: row?.querySelector(".l")?.textContent.trim() ?? null,
          value: input ? Number(input.value) : null,
          min: input ? Number(input.min) : null,
          max: input ? Number(input.max) : null,
        };
      }),
    }),
    Object.keys(ROWS),
  );
}

const shotName = (l, browser, width) =>
  l === "en"
    ? `push-rows-${browser}-${width}`
    : `push-rows-${l}-${browser}-${width}`;

export async function run(ctx, s) {
  const was = await language(ctx);
  const by = {};
  try {
    for (const l of LANGS) {
      // A refused switch leaves the page in the bed's language: say that, not what the rows say.
      const set = await setLanguage(ctx, l);
      if (set && (set.ok === false || (set.status && set.status >= 400)))
        throw new Error(
          `the language switch to ${l} was refused (${set.status})`,
        );
      const seen = await readRows(ctx);
      by[l] = { lang: seen.lang, rows: seen.rows };
      await ctx.page
        .locator('.set-row[data-setting="notifications.push_timeout"]')
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      await ctx.shot(shotName(l, ctx.browser, ctx.width));
    }
  } finally {
    await setLanguage(ctx, was);
  }
  return { ...s, rows: by.en.rows, by };
}

/** Per language: each push row is shown with a label, on a page in that language; in es and ja the label is not the en one. */
function translated(by) {
  const en = Object.fromEntries(by.en.rows.map((x) => [x.id, x.label]));
  return LANGS.map((l) => {
    const r = by[l];
    const bad = r.rows
      .filter(
        (x) => !x.shown || !x.label || (l !== "en" && x.label === en[x.id]),
      )
      .map(
        (x) =>
          `${x.id} ${x.shown ? `${JSON.stringify(x.label)} (untranslated)` : "missing"}`,
      );
    if (r.lang !== l) bad.unshift(`the page is in "${r.lang}", not "${l}"`);
    return {
      l,
      ok: bad.length === 0,
      said: bad.length
        ? bad.join(", ")
        : r.rows.map((x) => JSON.stringify(x.label)).join(", "),
    };
  });
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
      ok: cells.every(({ result }) => translated(result.by).every((x) => x.ok)),
      detail: cells
        .map(
          ({ cell, result }) =>
            `${cell.browser}: ${translated(result.by)
              .map((x) => `${x.l} ${x.said}`)
              .join("; ")}`,
        )
        .join(" | "),
      evidence: cells.flatMap(({ cell }) =>
        LANGS.map((l) => `${shotName(l, cell.browser, cell.width)}.png`),
      ),
    },
  ];
}
