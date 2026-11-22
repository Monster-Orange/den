/* eslint-env browser */
// Live check for #441: an outside runner's gate results (its verdict file) are imported as a Verify run
// on an imported environment (verify.environments), and the Checks page shows that tag's answer there.
// Imports a sample verdict under its own tag (gate-441-sample), reads the run, the routes and the page in
// en, es and ja, and removes its runs in teardown. The language is put back after each cell. On a bed whose
// config names no imported environment, every clause is not run.
import * as fs from "node:fs";

export const issue = 441;
export const clauses = [
  "Import, pushed: verify import keeps a normal run record (the tag, its commit, an outside runner, one synthetic <repo>:gate/<issue> check per gate file), and an agent caller is refused",
  "Untrusted input: a file that isn't a verdict is refused, evidence paths are dropped, and every name and note is shown as text",
  "Module state: any FAIL is failed, an ERROR is error, all NOT_RUN is not run, otherwise passed with a count of the clauses that need a person",
  "Imported modules need no declaring, and are marked from imported results",
  "Verify-only environments: an import to an environment that isn't listed is refused, naming verify.environments, and Den runs nothing on a listed one",
  "Page: the answer line first, then failures, then Needs you, and the run view's clause rows, in en, es and ja at 1440 and 390",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1440, 390] };
export const timeoutMs = 240000;

const TAG = "gate-441-sample";
const AGENT_TAG = "gate-441-agent";
const HOSTILE = '<img src=x onerror="window.__gate441=1">';
const LANGS = ["en", "es", "ja"];

function sample(tag) {
  const now = Date.now();
  return {
    tag,
    sha: "0000000",
    startedAt: new Date(now - 60000).toISOString(),
    endedAt: new Date(now).toISOString(),
    clauses: [
      // gate/441: a FAIL among the others → failed.
      {
        issue: 441,
        clause: "a sample clause that passed",
        verdict: "PASS",
        ms: 1200,
        note: "sample",
        evidence: ["../../outside.png"],
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
      // gate/442: nothing ran → not run.
      {
        issue: 442,
        clause: "a sample clause the bed can't run",
        verdict: "NOT_RUN",
        ms: null,
        note: "skip: needs-sample",
      },
      // gate/443: passed, one clause for a person.
      {
        issue: 443,
        clause: "a sample clause that passed too",
        verdict: "PASS",
        ms: 300,
      },
      {
        issue: 443,
        clause: "a second clause for a person",
        verdict: "NOT_RUN",
        ms: null,
        note: "skip: person",
      },
      // gate/444: an ERROR → error.
      {
        issue: 444,
        clause: "a sample clause that errored",
        verdict: "ERROR",
        ms: null,
        note: "shape: no expect",
      },
    ],
  };
}

const json = (init, body) => ({
  ...init,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function overview(ctx) {
  try {
    return await ctx.api("/api/verify/overview");
  } catch {
    return null;
  }
}

async function language(ctx, l) {
  if (l === undefined)
    return (await ctx.api("/api/settings"))?.language ?? null;
  await ctx.api("/api/settings", json({}, { language: l }));
  return l;
}

const bedOf = (ov, env) => (ov?.envs || []).find((e) => e.env === env) || null;
const short = (r) =>
  String((r.out || "") + (r.err || ""))
    .trim()
    .slice(0, 300);

export async function setup(ctx) {
  const ov = await overview(ctx);
  const env = (ov?.envs || []).find((e) => e.imported)?.env ?? null;
  if (!env) return { skip: true, project: ov?.project ?? null };
  const project = ov.project;
  const write = (name, body) => {
    const file = ctx.evidence(`441-${name}`);
    fs.writeFileSync(
      file,
      typeof body === "string" ? body : JSON.stringify(body),
    );
    return file;
  };
  const imp = (file, e, opts) =>
    ctx.cli(["verify", "import", file, "--env", e, "--project", project], opts);

  // Clause 1: an agent is refused (Den's agent marker alone, no token).
  const agent = imp(write(`${AGENT_TAG}.json`, sample(AGENT_TAG)), env, {
    env: { DEN_AGENT: "gate-441" },
  });
  const agentRun = await ctx.fetch(
    `/api/verify/runs/${AGENT_TAG}?project=${encodeURIComponent(project)}`,
  );
  // Clause 2: a file that isn't a verdict.
  const bad = imp(write("not-a-verdict.json", "not json"), env);
  // Clause 5: an environment that isn't listed, and a plan on a listed one.
  const unlisted = imp(
    write(`${TAG}-unlisted.json`, sample(TAG)),
    "gate-441-unlisted",
  );
  const plan = await ctx.fetch("/api/verify/plan", json({}, { project, env }));
  // The sample, kept.
  const ok = imp(write(`${TAG}.json`, sample(TAG)), env);
  const rec = await ctx
    .api(`/api/verify/runs/${TAG}?project=${encodeURIComponent(project)}`)
    .catch(() => null);
  const after = bedOf(await overview(ctx), env);
  return {
    env,
    project,
    agent: {
      code: agent.code,
      said: short(agent),
      kept: agentRun.status !== 404,
    },
    bad: { code: bad.code, said: short(bad) },
    unlisted: { code: unlisted.code, said: short(unlisted) },
    plan: {
      status: plan.status,
      error: String(plan.body?.error ?? "").slice(0, 200),
    },
    importCode: ok.code,
    importOut: short(ok),
    rec: rec
      ? {
          runId: rec.runId,
          commit: rec.commit,
          startedBy: rec.startedBy,
          source: rec.source,
          modules: (rec.modules || []).map((m) => ({
            id: m.id,
            kind: m.kind,
            state: m.state,
            needs: (m.clauses || []).filter((c) => c.result === "needs-person")
              .length,
            evidence: (m.clauses || []).some((c) => "evidence" in c),
          })),
        }
      : null,
    tag: after?.run?.tag ?? null,
    clauses: after?.clauses ?? null,
  };
}

async function closeWhatsNew(page) {
  try {
    await page.locator("dialog#cl-overlay[open]").waitFor({ timeout: 2500 });
    await page.click("#cl-close-btn");
    await page
      .locator("dialog#cl-overlay[open]")
      .waitFor({ state: "detached", timeout: 5000 });
  } catch {
    /* not shown */
  }
}

async function readCard(ctx, s, lang) {
  await ctx.goto(ctx.page, "/verify");
  await closeWhatsNew(ctx.page);
  const card = `#verify-body [data-env="${s.env}"][data-imported]`;
  await ctx.page.waitForSelector(card, { timeout: 15000 }).catch(() => {});
  const seen = await ctx.page.evaluate((sel) => {
    const c = document.querySelector(sel);
    if (!c) return null;
    // What comes first in the card, in order: the answer line, then each list.
    const order = [...c.querySelectorAll('[data-part="say"], [data-list]')].map(
      (el) => el.dataset.list ?? "say",
    );
    return {
      lang: document.documentElement.lang,
      say: c.querySelector('[data-part="say"]')?.textContent ?? "",
      order,
      from: !!c.querySelector('[data-part="from"]'),
      rows: [...c.querySelectorAll("a[data-check]")].map(
        (a) => a.dataset.check,
      ),
      imgs: c.querySelectorAll("img").length,
      sideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  }, card);
  await ctx.shot(`bed-card-${lang}-${ctx.browser}-${ctx.width}`);
  return seen;
}

async function readWhy(ctx, s, lang) {
  const card = `#verify-body [data-env="${s.env}"][data-imported]`;
  const row = ctx.page.locator(`${card} a[data-check="gate/441"]`);
  if ((await row.count()) !== 1) return null;
  await row.click();
  await ctx.page
    .waitForSelector("#gate-441", { timeout: 15000 })
    .catch(() => {});
  const why = await ctx.page.evaluate(() => {
    const g = document.getElementById("gate-441");
    return {
      url: location.search + location.hash,
      focused: document.activeElement === g,
      results: g
        ? [...g.querySelectorAll("tr[data-result]")].map(
            (r) => r.dataset.result,
          )
        : [],
      from: !!g?.querySelector('[data-part="from"]'),
      hostile: g?.textContent?.includes("<img src=x") ?? false,
      imgs: document.querySelectorAll("#verify-body img").length,
      ran: window.__gate441 ?? 0,
      sideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  await ctx.shot(`bed-why-${lang}-${ctx.browser}-${ctx.width}`);
  return why;
}

export async function run(ctx, s) {
  if (s.skip) return s;
  const was = await language(ctx);
  const byLang = {};
  try {
    for (const lang of LANGS) {
      await language(ctx, lang);
      const card = await readCard(ctx, s, lang);
      const why = card ? await readWhy(ctx, s, lang) : null;
      byLang[lang] = { card, why };
    }
  } finally {
    await language(ctx, was ?? "en").catch(() => {});
  }
  return { ...s, byLang };
}

export async function teardown(ctx, s) {
  if (!s || s.skip || !s.project) return;
  for (const tag of [TAG, AGENT_TAG])
    ctx.cli(["verify", "remove", tag, "--project", s.project]);
}

const STATES = {
  "gate/441": "failed",
  "gate/442": "notrun",
  "gate/443": "passed",
  "gate/444": "error",
};

export function expect(cells) {
  const r0 = cells.map((c) => c.result).find(Boolean);
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
  const mods = r0.rec?.modules ?? [];
  const byName = Object.fromEntries(
    mods.map((m) => [m.id.split(":").pop(), m]),
  );
  const each = (fn) =>
    cells.every(({ result: r }) =>
      LANGS.every((l) => fn(r.byLang?.[l] ?? {}, l)),
    );
  const cellDetail = (fn) =>
    cells
      .map(
        ({ cell, result: r }) =>
          `${cell.browser} ${cell.width}: ${LANGS.map((l) => `${l} ${JSON.stringify(fn(r.byLang?.[l] ?? {}))}`).join(" | ")}`,
      )
      .join("; ");
  const shots = (kind) =>
    cells.flatMap(({ cell }) =>
      LANGS.map((l) => `bed-${kind}-${l}-${cell.browser}-${cell.width}.png`),
    );
  const enSay = new RegExp(
    `^${TAG} on ${r0.env} failed: 2 clauses passed, 2 need a person, 2 failed\\.$`,
  );
  return [
    {
      clause: clauses[0],
      ok:
        r0.importCode === 0 &&
        r0.rec?.runId === TAG &&
        r0.rec?.commit === "0000000" &&
        r0.rec?.startedBy?.kind === "runner" &&
        r0.rec?.source === "import" &&
        mods.length === 4 &&
        mods.every(
          (m) =>
            m.kind === "synthetic" &&
            m.id === `${r0.project}:gate/${m.id.split("/").pop()}`,
        ) &&
        r0.agent.code === 1 &&
        /agent can't change/.test(r0.agent.said) &&
        !r0.agent.kept,
      detail: `import ${r0.importCode}: ${r0.importOut}; record ${JSON.stringify(r0.rec && { runId: r0.rec.runId, commit: r0.rec.commit, startedBy: r0.rec.startedBy, ids: mods.map((m) => `${m.id} ${m.kind}`) })}; an agent: ${r0.agent.code} "${r0.agent.said}", kept ${r0.agent.kept}`,
    },
    {
      clause: clauses[1],
      ok:
        r0.bad.code === 1 &&
        /nothing kept/.test(r0.bad.said) &&
        mods.length > 0 &&
        mods.every((m) => !m.evidence) &&
        each(
          (x) =>
            !!x.why &&
            x.why.hostile &&
            x.why.imgs === 0 &&
            x.why.ran === 0 &&
            x.card?.imgs === 0,
        ),
      detail: `not a verdict: ${r0.bad.code} "${r0.bad.said}"; evidence kept: ${mods.some((m) => m.evidence)}; ${cellDetail((x) => x.why && { hostile: x.why.hostile, imgs: x.why.imgs, ran: x.why.ran })}`,
    },
    {
      clause: clauses[2],
      ok:
        Object.entries(STATES).every(([k, v]) => byName[k]?.state === v) &&
        byName["gate/443"]?.needs === 1,
      detail: mods
        .map(
          (m) =>
            `${m.id}: ${m.state}${m.needs ? `, ${m.needs} need a person` : ""}`,
        )
        .join("; "),
    },
    {
      clause: clauses[3],
      ok: each(
        (x) =>
          !!x.card && x.card.from && x.card.rows.length === 4 && !!x.why?.from,
      ),
      detail: cellDetail(
        (x) =>
          x.card && {
            from: x.card.from,
            rows: x.card.rows,
            whyFrom: x.why?.from,
          },
      ),
      evidence: shots("card"),
    },
    {
      clause: clauses[4],
      ok:
        r0.unlisted.code === 1 &&
        /verify\.environments/.test(r0.unlisted.said) &&
        r0.plan.status === 400 &&
        /imported/.test(r0.plan.error),
      detail: `an unlisted environment: ${r0.unlisted.code} "${r0.unlisted.said}"; a plan on ${r0.env}: ${r0.plan.status} "${r0.plan.error}"`,
    },
    {
      clause: clauses[5],
      ok: each(
        (x, l) =>
          !!x.card &&
          x.card.lang === l &&
          x.card.say.includes(TAG) &&
          (l !== "en" || enSay.test(x.card.say.trim())) &&
          x.card.order.join() === "say,failed,needs-person,cant-run" &&
          !x.card.sideways &&
          !!x.why &&
          x.why.url.endsWith("#gate-441") &&
          x.why.focused &&
          x.why.results.join() === "passed,failed,needs-person" &&
          !x.why.sideways,
      ),
      detail: cellDetail(
        (x) =>
          x.card && {
            lang: x.card.lang,
            say: x.card.say,
            order: x.card.order,
            sideways: x.card.sideways,
            results: x.why?.results,
          },
      ),
      evidence: [...shots("card"), ...shots("why")],
    },
  ];
}
