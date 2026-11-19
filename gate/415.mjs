// gate/415.mjs: the Report form says who can see a report (issue 415).
// The bed is a Den: its report targets are Den's own (the engine's repo,
// and the distribution's feedback.repo when it names one). GET /api/report
// must give each one its real visibility on GitHub (read with the bed's
// GitHub sign-in), and Review must show the matching pill: the public pill
// and the visible-to-everyone warning for a public repo, the private or
// internal pill and its audience note otherwise; a target whose visibility
// Den couldn't learn (its cache, read only, says unknown) as public. Each
// target is chosen in turn in the drop-down, in en, es and ja (Den's
// language setting, put back). Nothing is sent: Report closes with Esc and
// Discard.
export const issue = 415;
export const clauses = [
  "Den gives each report target its real visibility on GitHub",
  "a public target shows the Public repository pill and the visible-to-everyone warning",
  "a private or internal target shows its own pill and no public warning",
  "unknown visibility is treated as public: the pill and the warning show",
  "with several repos in the drop-down, the pill and note follow the selected repo",
  "the pill, the warning and the audience note have en, es and ja text",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
// Per cell: three languages, each a Review with every target.
export const timeoutMs = 240000;

const LANGS = ["en", "es", "ja"];

/** What GitHub says without a token: public, or not (private, internal). */
async function realVisibility(repo) {
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404) return "not-public";
    if (!r.ok) return null;
    const j = await r.json();
    return j.private ? "not-public" : "public";
  } catch {
    return null;
  }
}

/** Den's settings through the bed's signed-in API (the person's token). */
async function settings(ctx, body) {
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
  if (!r.ok) throw new Error(`/api/settings: HTTP ${r.status}`);
  return r.json();
}

/**
 * The targets Den couldn't learn the visibility of: its cache's entries
 * with no answer (report-visibility.ts), read only. Null: no cache.
 */
async function unknownTargets(ctx) {
  try {
    const text = await ctx.readBed("report-visibility.json");
    if (!text) return null;
    const j = JSON.parse(text);
    return Object.entries(j ?? {})
      .filter(([, e]) => e && e.v == null)
      .map(([repo]) => repo);
  } catch {
    return null;
  }
}

export async function setup(ctx) {
  const r = await ctx.api("/api/report");
  const info = r.ok ? await r.json() : {};
  const repos = Array.isArray(info.repos) ? info.repos : [];
  const real = {};
  for (const x of repos) real[x.repo] = await realVisibility(x.repo);
  const unknown = (await unknownTargets(ctx)) ?? [];
  return {
    enabled: r.ok && info.enabled !== false && repos.length > 0,
    signedIn: info.github?.signedIn === true,
    repos: repos.map((x) => ({
      repo: x.repo,
      visibility: x.visibility,
      unknown: unknown.includes(x.repo),
    })),
    real,
  };
}

/** Review's pill and notes for the target chosen now. */
const read = (page) =>
  page.evaluate(() => {
    const d = document.querySelector("dialog.fb-dlg");
    const pill = d?.querySelector(".fb-dest .fb-pill");
    const warn = d ? [...d.querySelectorAll(".fb-warn")] : [];
    const note = d ? [...d.querySelectorAll("[data-vis-note]")] : [];
    return {
      html: document.documentElement.lang || null,
      pill: (pill?.textContent || "").trim(),
      vis: pill?.getAttribute("data-vis") || null,
      warn: d ? warn.length : -1,
      note: d ? note.length : -1,
      warnText: warn.map((e) => (e.textContent || "").trim()).join(" "),
      noteText: note.map((e) => (e.textContent || "").trim()).join(" "),
    };
  });

/** Esc, then Discard the typed title: nothing sent. */
async function closeReport(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .locator('dialog.fb-dlg [data-act="discard"]')
    .click({ timeout: 2000 })
    .catch(() => {});
}

/** Report opened to Review; each target chosen in turn and read. */
async function review(ctx, state, lang, cell) {
  const page = ctx.page;
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
  const seen = [];
  const select = (await sel.count()) > 0;
  for (const [i, t] of state.repos.entries()) {
    if (select) await sel.selectOption(t.repo);
    else if (i > 0) break;
    await page.waitForTimeout(300);
    const shot = `report-${lang}-${i}-${cell}`;
    seen.push({ ...t, ...(await read(page)), shot, lang });
    await ctx.shot(shot);
  }
  // Back to the first, so a pill that only drew once shows here too.
  if (select && state.repos.length > 1) {
    await sel.selectOption(state.repos[0].repo);
    await page.waitForTimeout(300);
    seen.push({
      ...state.repos[0],
      ...(await read(page)),
      shot: `report-${lang}-back-${cell}`,
      lang,
      back: true,
    });
  }
  await closeReport(page);
  return { seen, select };
}

export async function run(ctx, state) {
  if (!state.enabled) return { skipped: true, state };
  // This cell's name, for its screenshots: the browser and the width.
  const b = ctx.browser;
  const cell = `${typeof b === "string" ? b : b?.browserType?.().name?.() || "browser"}-${ctx.width}`;
  const was = (await settings(ctx))?.language ?? null;
  const byLang = {};
  let select = false;
  try {
    for (const lang of LANGS) {
      await settings(ctx, { language: lang });
      const r = await review(ctx, state, lang, cell);
      byLang[lang] = r.seen;
      select = select || r.select;
    }
  } finally {
    await settings(ctx, { language: was }).catch(() => {});
  }
  // The en rows are the clauses' own; es and ja are for the words.
  return { seen: byLang.en ?? [], byLang, select, state };
}

export async function teardown(ctx) {
  const page = ctx.page;
  if (!page) return;
  await closeReport(page);
}

export function expect(cells) {
  const ran = cells.filter((c) => c.result && !c.result.skipped);
  if (!ran.length)
    return clauses.map((clause) => ({
      clause,
      ok: null,
      skip: "needs-report-target",
    }));
  // The page's rows (the same targets and API answers in every cell).
  const rows = ran.flatMap((c) => c.result.seen.filter((s) => !s.back));
  const pub = rows.filter(
    (s) => !s.unknown && (s.visibility ?? "public") === "public",
  );
  const priv = rows.filter((s) => (s.visibility ?? "public") !== "public");
  const unk = rows.filter((s) => s.unknown);
  const pageMatches = (s) =>
    s.vis === (s.visibility ?? "public") &&
    (s.vis === "public"
      ? s.warn === 1 && s.note === 0
      : s.warn === 0 && s.note === 1);
  return [
    expectApi(cells),
    pub.length
      ? {
          clause: clauses[1],
          ok: pub.every(pageMatches),
          evidence: pub.map((s) => s.shot),
        }
      : { clause: clauses[1], ok: null, skip: "needs-public-target" },
    priv.length
      ? {
          clause: clauses[2],
          ok: priv.every(pageMatches),
          evidence: priv.map((s) => s.shot),
        }
      : { clause: clauses[2], ok: null, skip: "needs-private-target" },
    unk.length
      ? {
          clause: clauses[3],
          ok: unk.every(
            (s) =>
              s.visibility === "public" &&
              s.vis === "public" &&
              s.warn === 1 &&
              s.note === 0,
          ),
          detail: unk
            .map(
              (s) =>
                `${s.repo}: Den ${s.visibility}, page ${s.vis}, warning ${s.warn}`,
            )
            .join("; "),
          evidence: unk.map((s) => s.shot),
        }
      : {
          clause: clauses[3],
          ok: null,
          skip: "needs-unknown-visibility-target",
        },
    follows(ran, pageMatches),
    words(ran),
  ];
}

/**
 * Clause 5: two or more targets of different visibility in one drop-down,
 * each pill and note right as it is chosen, and right again back on the
 * first.
 */
function follows(ran, pageMatches) {
  const kinds = (c) =>
    new Set(c.result.seen.filter((s) => !s.back).map((s) => s.vis ?? "?"));
  const many = ran.filter(
    (c) =>
      c.result.select &&
      c.result.seen.filter((s) => !s.back).length > 1 &&
      new Set(
        c.result.seen
          .filter((s) => !s.back)
          .map((s) => s.visibility ?? "public"),
      ).size > 1,
  );
  if (!many.length)
    return { clause: clauses[4], ok: null, skip: "needs-private-target" };
  return {
    clause: clauses[4],
    ok: many.every(
      (c) =>
        c.result.seen.every((s) =>
          s.unknown ? s.vis === "public" && s.warn === 1 : pageMatches(s),
        ) && kinds(c).size > 1,
    ),
    detail: many
      .map((c) =>
        c.result.seen
          .map((s) => `${s.back ? "back to " : ""}${s.repo}: ${s.vis}`)
          .join(" → "),
      )
      .join(" | "),
    evidence: many.flatMap((c) => c.result.seen.map((s) => s.shot)),
  };
}

/**
 * Clause 6: in each language the page is in that language, and the pill,
 * the warning and the note it shows have words (never a catalog key); es
 * and ja are not the English words. Judged for every visibility shown.
 */
function words(ran) {
  const key = /(^|\s)kit\.report\.|^\s*$/;
  const bad = [];
  const shown = new Set();
  for (const c of ran) {
    const by = c.result.byLang ?? {};
    for (const lang of LANGS) {
      const list = (by[lang] ?? []).filter((s) => !s.back);
      if (!list.length) bad.push(`${lang}: no Review read`);
      for (const [i, s] of list.entries()) {
        shown.add(s.vis);
        const text = s.vis === "public" ? s.warnText : s.noteText;
        if (s.html !== lang) bad.push(`${lang} ${s.repo}: page in ${s.html}`);
        if (key.test(s.pill) || key.test(text))
          bad.push(`${lang} ${s.repo}: "${s.pill}" / "${text}"`);
        const en = (by.en ?? [])[i];
        if (
          lang !== "en" &&
          en &&
          (s.pill === en.pill ||
            text === (en.vis === "public" ? en.warnText : en.noteText))
        )
          bad.push(`${lang} ${s.repo}: same words as en ("${s.pill}")`);
      }
    }
  }
  return {
    clause: clauses[5],
    ok: bad.length === 0,
    detail:
      (bad.length ? bad.join("; ") : "every pill and note in en, es and ja") +
      ` (shown: ${[...shown].join(", ")})`,
    evidence: ran.flatMap((c) =>
      LANGS.flatMap((l) => (c.result.byLang?.[l] ?? []).map((s) => s.shot)),
    ),
  };
}

/** Clause 1: GET /api/report's visibility against GitHub's own answer. */
function expectApi(cells) {
  // setup's state rides along on each cell's result: the API's answers
  // (repos[].visibility) and GitHub's (real).
  const c = cells.find((x) => x.result && !x.result.skipped);
  const st = c?.result?.state;
  if (!st || !st.signedIn)
    return { clause: clauses[0], ok: null, skip: "needs-github-access" };
  // A target Den couldn't learn is clause 4's, not this one's.
  const known = st.repos.filter((t) => st.real[t.repo] && !t.unknown);
  if (!known.length)
    return { clause: clauses[0], ok: null, skip: "needs-github-access" };
  return {
    clause: clauses[0],
    ok: known.every((t) =>
      st.real[t.repo] === "public"
        ? t.visibility === "public"
        : t.visibility === "private" || t.visibility === "internal",
    ),
    detail: known
      .map((t) => `${t.repo}: Den ${t.visibility}, GitHub ${st.real[t.repo]}`)
      .join("; "),
  };
}
