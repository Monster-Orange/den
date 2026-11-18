/**
 * Live check for issue 440: until Den's own checks are on it, Checks says
 * it is a preview, on the rail's row and on the page, in en, es and ja.
 * The same clauses as tests/unit/server/verify-preview.browser.test.ts.
 *
 * It only reads, except the page's language, which it sets for es and ja
 * and puts back (teardown too).
 */
export const issue = 440;
export const clauses = [
  "the rail's Checks row carries the Preview tag, and reads '<label> · Preview'",
  "the Checks page opens with a notice: the Preview tag and one line on what isn't there yet",
  "both in en, es and ja, with nothing scrolling sideways at 390 px",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280, 390] };
export const timeoutMs = 120000;

const WORDS = {
  en: { tag: "Preview", line: "Checks isn't finished" },
  es: { tag: "Vista previa", line: "Comprobaciones no está terminado" },
  ja: { tag: "プレビュー", line: "チェックはまだ完成していません" },
};

async function json(ctx, path, init) {
  const r = await ctx.api(path, init);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
const setLanguage = (ctx, language) =>
  json(ctx, "/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language }),
  });

export async function setup(ctx) {
  const settings = await json(ctx, "/api/settings");
  return { language: settings?.language ?? null };
}

const browserName = (ctx) =>
  typeof ctx.browser === "string"
    ? ctx.browser
    : (ctx.browser?.browserType?.().name?.() ?? "browser");

export async function run(ctx, state) {
  const p = ctx.page;
  const seen = { width: ctx.width, langs: {} };
  try {
    for (const lang of ["en", "es", "ja"]) {
      await setLanguage(ctx, lang);
      await p.goto(new URL("/verify", ctx.url).href);
      await p.waitForSelector('#verify-body[aria-busy="false"]');
      const row = p.locator('a.den-ni[data-nav="verify"]');
      const note = p.locator("#verify-preview");
      seen.langs[lang] = {
        kind: await row.getAttribute("data-nav-kind"),
        name: await row.getAttribute("aria-label"),
        label: ((await row.locator(".den-lbl").textContent()) ?? "").trim(),
        tag: ((await row.locator(".den-ni-kind").textContent()) ?? "").trim(),
        role: await note.getAttribute("role"),
        hidden: await note.isHidden(),
        note: ((await note.textContent()) ?? "").trim(),
        scroll: await p.evaluate(
          () => globalThis.document.documentElement.scrollWidth,
        ),
      };
      if (lang === "en")
        await ctx.shot?.(`checks-${browserName(ctx)}-${ctx.width}`);
    }
  } finally {
    await setLanguage(ctx, state.language);
  }
  return seen;
}

export async function teardown(ctx, state) {
  if (state) await setLanguage(ctx, state.language).catch(() => {});
}

function rows(s, cell) {
  const tag = cell ? `${cell.browser ?? ""}-${cell.width ?? ""}` : "";
  const l = s?.langs ?? {};
  const all = (f) => ["en", "es", "ja"].every((k) => l[k] && f(l[k], k));
  return [
    {
      clause: clauses[0],
      ok: all(
        (x, k) =>
          x.kind === "preview" &&
          x.tag === WORDS[k].tag &&
          x.name === `${x.label} · ${WORDS[k].tag}`,
      ),
      detail: `${tag} ${JSON.stringify(Object.fromEntries(Object.entries(l).map(([k, x]) => [k, [x.kind, x.name]])))}`,
    },
    {
      clause: clauses[1],
      ok: all(
        (x, k) =>
          x.role === "note" &&
          !x.hidden &&
          x.note.includes(WORDS[k].tag) &&
          x.note.includes(WORDS[k].line),
      ),
      detail: `${tag} ${l.en?.note ?? "no notice"}`,
    },
    {
      clause: clauses[2],
      ok: all((x) => (s.width === 390 ? x.scroll === 390 : true)),
      detail: `${tag} ${JSON.stringify(Object.fromEntries(Object.entries(l).map(([k, x]) => [k, x.scroll])))}`,
    },
  ];
}

export function expect(cells) {
  const list = Array.isArray(cells) ? cells : [{ result: cells }];
  const per = list.map((c) => rows(c?.result, c?.cell));
  const evidence = list
    .map((c) => c?.cell && `checks-${c.cell.browser}-${c.cell.width}`)
    .filter(Boolean);
  return clauses.map((clause, i) => ({
    clause,
    ok: per.every((r) => r[i].ok === true),
    detail: per.map((r) => r[i].detail).join(" | "),
    ...(i === 0 && evidence.length ? { evidence } : {}),
  }));
}
