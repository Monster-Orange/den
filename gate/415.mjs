// gate/415.mjs: the Report form says who can see a report (issue 415).
// The bed is a Den: its report targets are Den's own. GET /api/report
// must give each one its real visibility on GitHub (read with the bed's
// GitHub sign-in), and Review must show the matching pill: the public pill
// and the visible-to-everyone warning for a public repo, the private or
// internal pill and no warning otherwise. Nothing is sent: Report closes
// with Esc and Discard.
export const issue = 415;
export const clauses = [
  "Den gives each report target its real visibility on GitHub",
  "a public target shows the Public repository pill and the visible-to-everyone warning",
  "a private or internal target shows its own pill and no public warning",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;

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

export async function setup(ctx) {
  const r = await ctx.api("/api/report");
  const info = r.ok ? await r.json() : {};
  const repos = Array.isArray(info.repos) ? info.repos : [];
  const real = {};
  for (const x of repos) real[x.repo] = await realVisibility(x.repo);
  return {
    enabled: r.ok && info.enabled !== false && repos.length > 0,
    signedIn: info.github?.signedIn === true,
    repos: repos.map((x) => ({ repo: x.repo, visibility: x.visibility })),
    real,
  };
}

/** Review's pill and notes for the target chosen now. */
const read = (page) =>
  page.evaluate(() => {
    const d = document.querySelector("dialog.fb-dlg");
    const pill = d?.querySelector(".fb-dest .fb-pill");
    return {
      pill: (pill?.textContent || "").trim(),
      vis: pill?.getAttribute("data-vis") || null,
      warn: d ? d.querySelectorAll(".fb-warn").length : -1,
      note: d ? d.querySelectorAll("[data-vis-note]").length : -1,
    };
  });

export async function run(ctx, state) {
  if (!state.enabled) return { skipped: true, state };
  const page = ctx.page;
  // This cell's name, for its screenshots: the browser and the width.
  const b = ctx.browser;
  const cell = `${typeof b === "string" ? b : b?.browserType?.().name?.() || "browser"}-${ctx.width}`;
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
  for (const [i, t] of state.repos.entries()) {
    if (await sel.count()) await sel.selectOption(t.repo);
    else if (i > 0) break;
    await page.waitForTimeout(300);
    const shot = `report-${i}-${cell}`;
    seen.push({ ...t, ...(await read(page)), shot });
    await ctx.shot(shot);
  }
  return { seen, state };
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
    return clauses.map((clause) => ({
      clause,
      ok: null,
      skip: "needs-report-target",
    }));
  // The page's rows (the same targets and API answers in every cell).
  const rows = ran.flatMap((c) => c.result.seen);
  const pub = rows.filter((s) => (s.visibility ?? "public") === "public");
  const priv = rows.filter((s) => (s.visibility ?? "public") !== "public");
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
  ];
}

/** Clause 1: GET /api/report's visibility against GitHub's own answer. */
function expectApi(cells) {
  // setup's state rides along on each cell's result: the API's answers
  // (repos[].visibility) and GitHub's (real).
  const c = cells.find((x) => x.result && !x.result.skipped);
  const st = c?.result?.state;
  if (!st || !st.signedIn)
    return { clause: clauses[0], ok: null, skip: "needs-github-access" };
  const known = st.repos.filter((t) => st.real[t.repo]);
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
