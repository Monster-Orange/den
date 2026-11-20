/* eslint-env browser */
// Live check for #403: a filed report's screenshot reaches whoever fixes it, and is never downloaded.
// Nothing is filed: the page's send is answered by the check itself (page.route), so no issue is posted
// and Hub is never sent a screenshot. Everything else is a read.
export const issue = 403;
export const clauses = [
  "No download. Filing never saves the screenshot to the person's computer",
  "Copying to the clipboard only on an explicit Copy press, if it's kept at all",
  "Before filing, the person sees where the screenshot goes, and can uncheck it for this report",
  "report_screenshot(id) answers the operator",
  "another agent's token or a project agent is refused",
  "Kept for a Setting's number of days (default 30), then deleted",
  "The issue body names the report id and the tool, never an image URL, data: URL or private link",
  "en/es/ja for any new words",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;

const SHARE_TO = /^Your masked screenshot goes to \S/;
const TEXT_ONLY = "Text only; the screenshot stays on your machine.";
const NEW_WORDS = [
  "kit.report.shareTo",
  "kit.report.shareNo",
  "kit.report.shotWent",
  "kit.report.shotStayed",
  "kit.report.why.limit",
];

export async function setup() {
  return {};
}

export async function run(ctx) {
  const tag = `${ctx.browser}-${ctx.width}`;
  const page = ctx.page;
  const r = { tag };
  const info = await ctx.api("/api/report");
  r.enabled = info?.enabled !== false;
  const settings = await ctx.api("/api/settings");
  r.keepDays = settings?.reports?.screenshot_keep_days ?? null;
  // An id no report has: the operator gets 404 (allowed, nothing kept), never 403.
  r.shotStatus = (await ctx.fetch("/api/report/shots/ffffffffffffffff")).status;
  // An agent that leaves its token off (loopback, no credential, a claimed
  // name only) and one with a token this install never minted: both refused
  // before any lookup (401), so the unknown id never answers 404 to them.
  const bare = await fetch(
    new URL("/api/report/shots/ffffffffffffffff", ctx.url),
    { headers: { "x-den-actor": "agent:gate-403-probe" } },
  );
  r.noTokenStatus = bare.status;
  r.otherTokenStatus = (
    await ctx.fetch("/api/report/shots/ffffffffffffffff", {
      headers: { authorization: "Bearer den_at_gate403notatoken" },
    })
  ).status;
  if (!r.enabled) return r;

  // Count clipboard writes; nothing may copy the screenshot on its own.
  await page.addInitScript(() => {
    window.__gate403Copies = 0;
    const c = navigator.clipboard;
    if (c && c.write) {
      const w = c.write.bind(c);
      c.write = (...a) => {
        window.__gate403Copies++;
        return w(...a);
      };
    }
  });
  const sent = [];
  const fake = async (route) => {
    sent.push(route.request().postDataJSON?.() ?? {});
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, url: "", repo: "", added: false }),
    });
  };
  await page.route("**/api/report/send", fake);
  await page.route("**/api/report/github-send", fake);
  let downloads = 0;
  page.on("download", () => downloads++);
  try {
    await ctx.goto(page, "/settings");
    r.words = await page.evaluate(async (keys) => {
      const m = await import("/kit/strings.js");
      return ["en", "es", "ja"].map((l) => ({
        lang: l,
        missing: keys.filter((k) => !(k in m[l])),
      }));
    }, NEW_WORDS);
    await page.keyboard.press("ControlOrMeta+Shift+F");
    const dlg = page.locator("dialog.fb-dlg");
    await dlg.locator('[data-f="title"]').waitFor({ timeout: 30000 });
    r.shot = await dlg
      .locator("canvas[data-shot]")
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    await dlg.locator('[data-f="title"]').fill("Live check 403 (not filed)");
    await dlg.locator('[data-act="next"]').click();
    await dlg.locator('[data-act="review"]').click();
    await dlg.locator('[data-act="send"]').waitFor({ timeout: 15000 });
    if (r.shot) {
      await dlg
        .locator("[data-share]")
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      r.line = (
        (await dlg
          .locator("[data-share]")
          .textContent()
          .catch(() => null)) ?? ""
      ).trim();
      r.box = await dlg.locator('[data-f="shareshot"]').count();
      if (r.box) {
        // A tick per report: it starts unticked, and the check leaves it so.
        r.boxChecked = await dlg.locator('[data-f="shareshot"]').isChecked();
      }
    }
    await ctx.shot(`review-${tag}`);
    await dlg.locator('[data-act="send"]').click();
    await page
      .locator('dialog.fb-dlg[data-step="sent"]')
      .waitFor({ timeout: 15000 })
      .catch(() => {});
    await ctx.sleep(1000);
    r.sentStep = await page.locator('dialog.fb-dlg[data-step="sent"]').count();
    r.downloads = downloads;
    r.copies = await page.evaluate(() => window.__gate403Copies ?? 0);
    r.sentShot = sent[0]
      ? /^data:image\/png;base64,/.test(String(sent[0].shot ?? ""))
      : null;
    r.sentShare = sent[0]?.shareShot ?? null;
    await ctx.shot(`sent-${tag}`);
    await page.keyboard.press("Escape").catch(() => {});
  } finally {
    await page.unroute("**/api/report/send", fake).catch(() => {});
    await page.unroute("**/api/report/github-send", fake).catch(() => {});
  }
  return r;
}

export function expect(cells) {
  const all = (f) => cells.every(({ result }) => f(result));
  const d = (f) =>
    cells.map(({ cell, result }) => `${cell.browser}: ${f(result)}`).join("; ");
  const off = cells.some(({ result }) => !result.enabled);
  const noShot = cells.some(({ result }) => result.enabled && !result.shot);
  const skipRow = (clause, skip, detail) => ({
    clause,
    ok: null,
    skip,
    detail,
  });
  if (off)
    return clauses.map((c, i) =>
      i === 3
        ? {
            clause: c,
            ok: all((r) => r.shotStatus === 404),
            detail: d(
              (r) => `GET /api/report/shots/<unknown> → ${r.shotStatus}`,
            ),
          }
        : i === 4
          ? {
              clause: c,
              ok: all(
                (r) => r.noTokenStatus === 401 && r.otherTokenStatus === 401,
              ),
              detail: d(
                (r) =>
                  `no token → ${r.noTokenStatus}, a token never minted → ${r.otherTokenStatus}`,
              ),
            }
          : i === 5
            ? {
                clause: c,
                ok: all(
                  (r) => r.keepDays === 30 || Number.isInteger(r.keepDays),
                ),
                detail: d((r) => `reports.screenshot_keep_days ${r.keepDays}`),
              }
            : skipRow(
                c,
                "needs-reports-on",
                "feedback.enabled is false on this bed",
              ),
    );
  return [
    {
      clause: clauses[0],
      ok: all((r) => r.sentStep === 1 && r.downloads === 0),
      detail: d(
        (r) =>
          `sent step ${r.sentStep ? "shown" : "not reached"}, downloads ${r.downloads}, screenshot ${r.shot ? "taken" : "not taken"}`,
      ),
      evidence: cells.map(
        ({ cell }) => `sent-${cell.browser}-${cell.width}.png`,
      ),
    },
    {
      clause: clauses[1],
      ok: all((r) => r.copies === 0),
      detail: d((r) => `clipboard writes ${r.copies}`),
    },
    noShot
      ? skipRow(
          clauses[2],
          "needs-capturable-page",
          "the page couldn't be captured here, so there was no screenshot to place",
        )
      : {
          clause: clauses[2],
          ok: all(
            (r) =>
              r.sentShot === true &&
              ((SHARE_TO.test(r.line) &&
                r.box === 1 &&
                r.boxChecked === false &&
                r.sentShare === false) ||
                (r.line === TEXT_ONLY && r.box === 0 && r.sentShare === false)),
          ),
          detail: d(
            (r) =>
              `"${r.line}", box ${r.box ? (r.boxChecked ? "ticked at the start" : "unticked at the start, left so") : "none"}, send carried the PNG ${r.sentShot}, shareShot ${r.sentShare}`,
          ),
          evidence: cells.map(
            ({ cell }) => `review-${cell.browser}-${cell.width}.png`,
          ),
        },
    {
      clause: clauses[3],
      ok: all((r) => r.shotStatus === 404),
      detail: d(
        (r) =>
          `GET /api/report/shots/<unknown id> as the operator → ${r.shotStatus} (404: allowed, none kept)`,
      ),
    },
    {
      clause: clauses[4],
      ok: all((r) => r.noTokenStatus === 401 && r.otherTokenStatus === 401),
      detail: d(
        (r) =>
          `no token (a claimed agent name only) → ${r.noTokenStatus}, a token this install never minted → ${r.otherTokenStatus} (a project agent's own token: 403, in the unit tests)`,
      ),
    },
    {
      clause: clauses[5],
      ok: all((r) => r.keepDays === 30 || Number.isInteger(r.keepDays)),
      detail: d(
        (r) =>
          `reports.screenshot_keep_days ${r.keepDays} (deletion after it: needs-time, in the unit tests)`,
      ),
    },
    skipRow(
      clauses[6],
      "needs-github-sandbox",
      "filing posts a public issue; the check never files one (the unit tests check every outcome's body)",
    ),
    {
      clause: clauses[7],
      ok: all((r) => (r.words ?? []).every((w) => w.missing.length === 0)),
      detail: d((r) =>
        (r.words ?? [])
          .map((w) => `${w.lang} missing ${w.missing.length}`)
          .join(", "),
      ),
    },
  ];
}
