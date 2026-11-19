/* eslint-env browser */
// Live check for #271: Settings › Project › Hub project offers "Create a Hub project named <name>" first,
// with the name editable. Read only: Create is never pressed (it asks Hub, and Hub's Allow is a person's).
export const issue = 271;
export const clauses = [
  "the link picker's first option is \"Create a Hub project named <this project's name>\", with the name editable",
  "when the person is an owner, Den shows Hub's Allow in place and links once it's created",
  "otherwise it says who must approve and links on its own when they do",
  "the same works from the server agent (a held write)",
  "a person links a Den project to a new Hub project from Den alone, and agents in that project see it",
  "the picker's words have en, es and ja text",
];
const LANGS = ["en", "es", "ja"];

/** Den's settings through the bed's signed-in API (the person's token). */
async function settingsApi(ctx, body) {
  const r = await ctx.api(
    "/api/settings",
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  if (r && r.ok === false) throw new Error(`/api/settings: HTTP ${r.status}`);
  return typeof r?.json === "function" ? r.json() : r;
}

/** The Hub project row's words on the page now: its label, the first option, the button. */
const readWords = (page) =>
  page.evaluate(() => {
    const host = document.querySelector(
      '.set-row[data-setting="workspace.hub"]',
    );
    const t = (e) => (e?.textContent || "").trim();
    return {
      html: document.documentElement.lang || null,
      label: t(host?.querySelector(".l")),
      first: t(host?.querySelector("#hubp-sel")?.options?.[0]),
      name: host?.querySelector("#hubp-new")?.value ?? null,
      button: t(host?.querySelector("[data-hubp-action]")),
    };
  });
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280, 390] };
export const timeoutMs = 120000;

export async function setup() {
  return {};
}

export async function run(ctx) {
  await ctx.goto(ctx.page, "/settings");
  const row = ctx.page.locator('.set-row[data-setting="workspace.hub"]');
  await row.waitFor({ timeout: 15000 }).catch(() => {});
  await ctx.page
    .waitForSelector(
      '.set-row[data-setting="workspace.hub"] [data-hubp], .set-row[data-setting="workspace.hub"] [data-hubp-error]',
      { timeout: 20000 },
    )
    .catch(() => {});
  const r = await ctx.page.evaluate(() => {
    const host = document.querySelector(
      '.set-row[data-setting="workspace.hub"]',
    );
    if (!host) return { row: false };
    const box = host.querySelector("[data-hubp]");
    const sel = host.querySelector("#hubp-sel");
    const first = sel?.options?.[0] ?? null;
    const input = host.querySelector("#hubp-new");
    return {
      row: true,
      state:
        box?.getAttribute("data-hubp-state") ??
        (host.querySelector("[data-hubp-error]") ? "error" : null),
      firstValue: first?.value ?? null,
      firstText: first?.textContent?.trim() ?? null,
      inputValue: input?.value ?? null,
      inputEditable: !!input && !input.readOnly && !input.disabled,
    };
  });
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await ctx.shot(`hub-project-${ctx.browser}-${ctx.width}`);
  // The same row in en, es and ja (Den's language, put back), when it
  // offers Create.
  if (r.row && r.firstValue === "__create") {
    r.words = {};
    let was = null;
    try {
      was = (await settingsApi(ctx))?.language ?? null;
      for (const lang of LANGS) {
        await settingsApi(ctx, { language: lang });
        await ctx.goto(ctx.page, "/settings");
        await ctx.page
          .waitForSelector('.set-row[data-setting="workspace.hub"] #hubp-sel', {
            timeout: 20000,
          })
          .catch(() => {});
        r.words[lang] = await readWords(ctx.page);
        await ctx.shot(`hub-project-${lang}-${ctx.browser}-${ctx.width}`);
      }
    } catch (e) {
      r.words.error = String(e?.message ?? e);
    } finally {
      await settingsApi(ctx, { language: was }).catch(() => {});
    }
  }
  return r;
}

/** en/es/ja: in each language the page is in it, the words are there, es and ja not English. */
function wordsRow(cells, first) {
  if (first.ok === null)
    return {
      clause: clauses[5],
      ok: null,
      skip: first.skip,
      detail: first.detail,
    };
  const bad = [];
  for (const { cell, result } of cells) {
    const w = result.words;
    const at = `${cell.browser} ${cell.width}`;
    if (!w) {
      bad.push(`${at}: not read`);
      continue;
    }
    if (w.error) bad.push(`${at}: ${w.error}`);
    for (const lang of LANGS) {
      const x = w[lang];
      if (!x) {
        bad.push(`${at} ${lang}: not read`);
        continue;
      }
      if (x.html !== lang) bad.push(`${at} ${lang}: page in ${x.html}`);
      if (!x.label || !x.first || !x.button || /^hubp\./.test(x.first))
        bad.push(`${at} ${lang}: no words ("${x.first}")`);
      if (x.name && !x.first.includes(x.name))
        bad.push(`${at} ${lang}: "${x.first}" doesn't name ${x.name}`);
      if (lang !== "en" && w.en) {
        if (x.first === w.en.first || x.label === w.en.label)
          bad.push(`${at} ${lang}: English ("${x.first}")`);
      }
    }
  }
  return {
    clause: clauses[5],
    ok: bad.length === 0,
    detail: bad.length
      ? bad.join("; ")
      : cells
          .map(({ cell, result }) =>
            LANGS.map(
              (l) =>
                `${cell.browser} ${cell.width} ${l}: "${result.words?.[l]?.first}"`,
            ).join("; "),
          )
          .join(" | "),
    evidence: cells.flatMap(({ cell }) =>
      LANGS.map((l) => `hub-project-${l}-${cell.browser}-${cell.width}.png`),
    ),
  };
}

export function expect(cells) {
  const states = cells.map(({ result }) => result.state);
  const shots = cells.map(
    ({ cell }) => `hub-project-${cell.browser}-${cell.width}.png`,
  );
  const d = cells
    .map(
      ({ cell, result: r }) =>
        `${cell.browser} ${cell.width}: ${r.row ? `${r.state}; first "${r.firstText}" (${r.firstValue}); name "${r.inputValue}" editable ${r.inputEditable}` : "row missing"}`,
    )
    .join("; ");
  const offline = cells.every(({ result }) => result.state === "offline");
  const linked = cells.every(({ result }) => result.state === "linked");
  const first = offline
    ? {
        clause: clauses[0],
        ok: null,
        skip: "needs-hub",
        detail: `this install isn't connected to a Hub: ${d}`,
      }
    : linked
      ? {
          clause: clauses[0],
          ok: null,
          skip: "needs-unlinked-project",
          detail: `the project is already linked: ${d}`,
        }
      : {
          clause: clauses[0],
          ok: cells.every(
            ({ result: r }) =>
              r.row &&
              r.firstValue === "__create" &&
              /^Create a Hub project named \S/.test(r.firstText || "") &&
              !!r.inputValue &&
              (r.firstText || "").endsWith(r.inputValue) &&
              r.inputEditable,
          ),
          detail: d,
          evidence: shots,
        };
  return [
    first,
    {
      clause: clauses[1],
      ok: null,
      skip: "person",
      detail: `Hub's Allow is an owner's act (states seen: ${[...new Set(states)].join(", ")})`,
    },
    {
      clause: clauses[2],
      ok: null,
      skip: "person",
      detail: "an owner's approval in Hub",
    },
    {
      clause: clauses[3],
      ok: null,
      skip: "person",
      detail: "the server agent's held write waits on the person's Allow",
    },
    {
      clause: clauses[4],
      ok: null,
      skip: "person",
      detail: "a person links the project and an owner allows it in Hub",
    },
    wordsRow(cells, first),
  ];
}
