/* eslint-env browser */
// Live check for #393: Settings › Browser sign-in has a Sign in button (never "run a command"), and no
// Settings row tells the person to run, type or paste a command, in en, es or ja. Run switches the bed's
// language (the person's setting) for es and ja and puts the value it found back, even when a read throws.
export const issue = 393;
export const clauses = [
  "not signed in, the row shows a Sign in button that opens Den's own sign-in page",
  "signed in, the row has Sign out and no Sign in",
  "no Settings string tells the person to run, type or paste a command",
  "en/es/ja",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;
const LANGS = ["en", "es", "ja"];

// A code element right after "run", "type", "paste" or "enter" in a row's words is a chore.
const chores = () => ({
  lang: document.documentElement.lang,
  chores: [...document.querySelectorAll(".set-row")].flatMap((row) =>
    [...row.querySelectorAll("code")]
      .filter((c) => {
        const before = c.previousSibling?.textContent ?? "";
        return /\b(run|type|paste|enter|ejecuta|escribe|pega|実行|入力|貼り付け)\b\s*:?\s*$/i.test(
          before,
        );
      })
      .map(
        (c) =>
          `${row.getAttribute("data-setting")}: …${(c.previousSibling?.textContent ?? "").slice(-30)}${c.textContent}`,
      ),
  ),
});

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

export async function setup() {
  return {};
}

/** The signed-in Settings page (the cell's own page) in the bed's current language. */
async function read(ctx, shot) {
  const r = {};
  await ctx.goto(ctx.page, "/settings#cli");
  await ctx.page
    .locator("#set-signout, #set-signin")
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  r.inSignout = await ctx.page.locator("#set-signout").count();
  r.inSignin = await ctx.page.locator("#set-signin").count();
  await ctx.page
    .waitForSelector(".set-row[data-setting]", { timeout: 15000 })
    .catch(() => {});
  const seen = await ctx.page.evaluate(chores);
  r.lang = seen.lang;
  r.chores = seen.chores;
  r.rows = await ctx.page.locator(".set-row[data-setting]").count();
  await ctx.shot(shot);
  return r;
}

const shotName = (l, browser, width) =>
  l === "en"
    ? `signed-in-${browser}-${width}`
    : `signed-in-${l}-${browser}-${width}`;

export async function run(ctx) {
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
      by[l] = await read(ctx, shotName(l, ctx.browser, ctx.width));
    }
  } finally {
    await setLanguage(ctx, was);
  }
  return { ...by.en, by };
}

export function expect(cells) {
  const all = (f) => cells.every(({ result }) => f(result));
  const d = (f) =>
    cells.map(({ cell, result }) => `${cell.browser}: ${f(result)}`).join("; ");
  const shots = (p) =>
    cells.map(({ cell }) => `${p}-${cell.browser}-${cell.width}.png`);
  const inLang = (r, l) => r.by[l].lang === l;
  const clean = (r) => r.rows > 0 && r.chores.length === 0;
  return [
    {
      clause: clauses[0],
      ok: null,
      skip: "needs-loopback-browser",
      detail:
        "through the edge a signed-out browser is sent to /signin before Settings draws; only a loopback browser sees the signed-out row",
    },
    {
      clause: clauses[1],
      ok: all((r) => r.inSignout > 0 && r.inSignin === 0),
      detail: d((r) => `Sign out ${r.inSignout}, Sign in ${r.inSignin}`),
      evidence: shots("signed-in"),
    },
    {
      clause: clauses[2],
      ok: all(clean),
      detail: d(
        (r) =>
          `${r.rows} rows; ${r.chores.length ? r.chores.join(" | ") : "none tells the person to run a command"}`,
      ),
      evidence: shots("signed-in"),
    },
    {
      clause: clauses[3],
      ok: all((r) => LANGS.every((l) => inLang(r, l) && clean(r.by[l]))),
      detail: d((r) =>
        LANGS.map((l) => {
          const x = r.by[l];
          if (!inLang(r, l)) return `${l} the page is in "${x.lang}"`;
          return `${l} ${x.rows} rows, ${x.chores.length ? x.chores.join(" | ") : "no command to run"}`;
        }).join("; "),
      ),
      evidence: cells.flatMap(({ cell }) =>
        LANGS.map((l) => `${shotName(l, cell.browser, cell.width)}.png`),
      ),
    },
  ];
}
