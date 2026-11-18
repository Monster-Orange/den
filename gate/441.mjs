/* eslint-env browser */
// Live check for #441: an outside runner's gate results (its verdict file) are imported as a Verify run
// on an imported environment (verify.environments), and the Checks page shows that tag's answer there.
// Imports a sample verdict under its own tag (gate-441-sample), reads the page, and removes the run in
// teardown. On a bed whose config names no imported environment, every clause is not run.
import * as fs from "node:fs";

export const issue = 441;
export const clauses = [
  "an outside runner's verdict file imports as one run on an imported environment, with its clause counts",
  "the Checks page shows the tag's answer and clause counts on that environment",
  "a check's row opens its clauses, failed first, with the runner's notes as plain text",
  "removing the imported run takes its answer off the page",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280, 390] };
export const timeoutMs = 120000;

const TAG = "gate-441-sample";
const GONE = "gate-441-removed";
const HOSTILE = '<img src=x onerror="window.__gate441=1">';

function sample(tag) {
  const now = Date.now();
  return {
    tag,
    sha: "0000000",
    startedAt: new Date(now - 60000).toISOString(),
    endedAt: new Date(now).toISOString(),
    clauses: [
      {
        issue: 441,
        clause: "a sample clause that passed",
        verdict: "PASS",
        ms: 1200,
        note: "sample",
      },
      {
        issue: 441,
        clause: "a sample clause that failed",
        verdict: "FAIL",
        ms: 900,
        note: `sample ${HOSTILE}`,
      },
      {
        issue: 441,
        clause: "a sample clause for a person",
        verdict: "NOT_RUN",
        ms: null,
        note: "a person's act · skip: person",
      },
      {
        issue: 442,
        clause: "a sample clause the bed can't run",
        verdict: "NOT_RUN",
        ms: null,
        note: "skip: needs-sample",
      },
    ],
  };
}

async function overview(ctx) {
  try {
    return await ctx.api("/api/verify/overview");
  } catch {
    return null;
  }
}

const bedOf = (ov, env) => (ov?.envs || []).find((e) => e.env === env) || null;

export async function setup(ctx) {
  const ov = await overview(ctx);
  const env = (ov?.envs || []).find((e) => e.imported)?.env ?? null;
  if (!env) return { skip: true, project: ov?.project ?? null };
  const write = (tag) => {
    const file = ctx.evidence(`441-${tag}.json`);
    fs.writeFileSync(file, JSON.stringify(sample(tag)));
    return file;
  };
  // A tag imported, then removed: its answer goes, and nothing else is touched.
  const before = bedOf(ov, env)?.run?.tag ?? null;
  const gone = ctx.cli([
    "verify",
    "import",
    write(GONE),
    "--env",
    env,
    "--project",
    ov.project,
  ]);
  const shown = bedOf(await overview(ctx), env)?.run?.tag ?? null;
  const rm = ctx.cli(["verify", "remove", GONE, "--project", ov.project]);
  const afterRm = bedOf(await overview(ctx), env)?.run?.tag ?? null;
  const imp = ctx.cli([
    "verify",
    "import",
    write(TAG),
    "--env",
    env,
    "--project",
    ov.project,
  ]);
  const after = bedOf(await overview(ctx), env);
  return {
    env,
    project: ov.project,
    removal: {
      before,
      importCode: gone.code,
      shown,
      removeCode: rm.code,
      after: afterRm,
    },
    importCode: imp.code,
    importOut: String(imp.out + imp.err)
      .trim()
      .slice(0, 400),
    tag: after?.run?.tag ?? null,
    clauses: after?.clauses ?? null,
  };
}

export async function run(ctx, s) {
  if (s.skip) return s;
  await ctx.goto(ctx.page, "/verify");
  // A new version's "What's new" may cover the page: close it, as a person would.
  try {
    await ctx.page.locator("#cl-overlay.open").waitFor({ timeout: 2500 });
    await ctx.page.click("#cl-close-btn");
    await ctx.page
      .locator("#cl-overlay.open")
      .waitFor({ state: "detached", timeout: 5000 });
  } catch {
    /* not shown */
  }
  const card = `#verify-body [data-env="${s.env}"][data-imported]`;
  await ctx.page.waitForSelector(card, { timeout: 15000 }).catch(() => {});
  const seen = await ctx.page.evaluate((sel) => {
    const c = document.querySelector(sel);
    if (!c) return null;
    const counts = {};
    for (const li of c.querySelectorAll("[data-count]"))
      counts[li.dataset.count] = li.querySelector("b")?.textContent ?? "";
    return {
      say: c.querySelector(".vf-say")?.textContent ?? "",
      counts,
      rows: c.querySelectorAll("a.vf-row").length,
    };
  }, card);
  await ctx.shot(`bed-card-${ctx.browser}-${ctx.width}`);
  let why = null;
  const row = ctx.page.locator(`${card} a.vf-row[href$="#gate-441"]`);
  if (await row.count()) {
    await row.first().click();
    await ctx.page
      .waitForSelector("#gate-441", { timeout: 15000 })
      .catch(() => {});
    why = await ctx.page.evaluate(() => {
      const g = document.getElementById("gate-441");
      return {
        url: location.search + location.hash,
        focused: document.activeElement === g,
        results: g
          ? [...g.querySelectorAll("tr[data-result]")].map(
              (r) => r.dataset.result,
            )
          : [],
        firstList:
          document.querySelector("#verify-body .vf-clist h3")?.textContent ??
          "",
        imgs: document.querySelectorAll("#verify-body img").length,
        ran: window.__gate441 ?? 0,
        sideways: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    await ctx.shot(`bed-why-${ctx.browser}-${ctx.width}`);
  }
  return { ...s, seen, why };
}

export async function teardown(ctx, s) {
  if (!s || s.skip || !s.project) return;
  for (const tag of [TAG, GONE])
    ctx.cli(["verify", "remove", tag, "--project", s.project]);
}

export function expect(cells) {
  const r0 = cells[0].result;
  if (r0.skip) {
    const row = (clause) => ({
      clause,
      ok: null,
      skip: "needs-imported-environment",
      detail:
        "the bed's config names no imported environment (verify.environments)",
    });
    return clauses.map(row);
  }
  const want = { passed: 1, failed: 1, needsPerson: 1, cantRun: 1, total: 4 };
  const c = r0.clauses || {};
  return [
    {
      clause: clauses[0],
      ok:
        r0.importCode === 0 &&
        r0.tag === TAG &&
        Object.entries(want).every(([k, v]) => c[k] === v),
      detail: `import ${r0.importCode}: ${r0.importOut}; overview tag ${r0.tag}, clauses ${JSON.stringify(c)}`,
    },
    {
      clause: clauses[1],
      ok: cells.every(
        ({ result: r }) =>
          !!r.seen &&
          r.seen.say.includes(TAG) &&
          r.seen.counts.passed === "1" &&
          r.seen.counts.failed === "1" &&
          r.seen.counts["needs-person"] === "1" &&
          r.seen.counts["cant-run"] === "1",
      ),
      detail: cells
        .map(
          ({ cell, result: r }) =>
            `${cell.browser} ${cell.width}: ${r.seen ? `${r.seen.say} ${JSON.stringify(r.seen.counts)}` : "no card"}`,
        )
        .join("; "),
      evidence: cells.map(
        ({ cell }) => `bed-card-${cell.browser}-${cell.width}.png`,
      ),
    },
    {
      clause: clauses[2],
      ok: cells.every(
        ({ result: r }) =>
          !!r.why &&
          r.why.url.endsWith("#gate-441") &&
          r.why.focused &&
          r.why.results.join() === "passed,failed,needs-person" &&
          /^Failed|^Falló|^失敗/.test(r.why.firstList) &&
          r.why.imgs === 0 &&
          r.why.ran === 0 &&
          !r.why.sideways,
      ),
      detail: cells
        .map(
          ({ cell, result: r }) =>
            `${cell.browser} ${cell.width}: ${r.why ? JSON.stringify(r.why) : "no row for gate/441"}`,
        )
        .join("; "),
      evidence: cells.map(
        ({ cell }) => `bed-why-${cell.browser}-${cell.width}.png`,
      ),
    },
    {
      clause: clauses[3],
      ok:
        r0.removal.importCode === 0 &&
        r0.removal.shown === GONE &&
        r0.removal.removeCode === 0 &&
        r0.removal.after === r0.removal.before,
      detail: `the answer's tag: ${r0.removal.before} before, ${r0.removal.shown} after the import, ${r0.removal.after} after the remove (${r0.removal.removeCode})`,
    },
  ];
}
