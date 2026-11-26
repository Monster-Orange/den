/* eslint-env browser */
// Live check for #143: the readiness waits that were a fixed 1.5 s (and 45 s) are settings with permissive
// defaults, shown on Settings › Server; the clean-run clause reads CI's first attempt on the bed's commit.
export const issue = 143;
export const clauses = [
  "a fixed wait that is product behaviour becomes a setting with a permissive default",
  "a clean full run under the same load is the check, not a re-run",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 90000;
const ROWS = ["server.ready_probe", "server.start_wait"];

// Read only: reads /api/settings, Settings › Server's wait rows and GitHub's CI runs.
export const readOnly = true;

const GH = "https://api.github.com";
const CI_FILE = "ci.yml";
const SHARD = /^pr(-shards)? \(/;

function json(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function gh(path) {
  const r = await fetch(`${GH}${path}`, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${path}`);
  return r.json();
}

async function ciRun(ctx) {
  const dep =
    json(ctx.readBed("package.json"))?.dependencies?.["@monster-orange/den"] ??
    "";
  const short = /-([0-9a-f]{7,40})\.tgz$/.exec(dep)?.[1];
  if (!short)
    return {
      skip: "needs-bed-commit",
      detail: `the bed's Den isn't a packed build naming its commit (${dep || "no dependency"})`,
    };
  const repoUrl =
    json(ctx.readBed("node_modules/@monster-orange/den/package.json"))
      ?.repository?.url ?? "";
  const repo = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
    repoUrl,
  )?.[1];
  if (!repo)
    return {
      skip: "needs-bed-commit",
      detail: `the bed's Den names no GitHub repo (${repoUrl || "none"})`,
    };
  try {
    const sha = (await gh(`/repos/${repo}/commits/${short}`)).sha;
    const runs =
      (
        await gh(
          `/repos/${repo}/actions/workflows/${CI_FILE}/runs?head_sha=${sha}&per_page=20`,
        )
      ).workflow_runs ?? [];
    const run = runs[0];
    if (!run) return { ok: false, detail: `no ci run on ${short} (${repo})` };
    const at = `${CI_FILE} run ${run.html_url} on ${short}`;
    if (run.status !== "completed")
      return {
        skip: "needs-ci-finished",
        detail: `${at} is ${run.status}; judged once it ends`,
      };
    const jobs =
      (
        await gh(
          `/repos/${repo}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`,
        )
      ).jobs ?? [];
    const shards = jobs.filter((j) => SHARD.test(j.name));
    const bad = shards.filter((j) => j.conclusion !== "success");
    if (run.run_attempt > 1)
      return {
        ok: false,
        detail: `${at} was re-run (attempt ${run.run_attempt}); only a first attempt counts${bad.length ? `; attempt 1 failed ${bad.map((j) => j.name).join(", ")}` : ""}`,
      };
    if (!shards.length)
      return {
        ok: false,
        detail: `${at}: attempt 1 ran no unit or browser shard`,
      };
    if (bad.length)
      return {
        ok: false,
        detail: `${at}: attempt 1 failed ${bad.map((j) => `${j.name} (${j.conclusion})`).join(", ")}`,
      };
    return {
      ok: true,
      detail: `${at}: attempt 1, all ${shards.length} unit and browser shards succeeded (${shards.map((j) => j.name).join(", ")})`,
    };
  } catch (e) {
    return {
      skip: "needs-github-api",
      detail: `GitHub's API didn't answer: ${String(e?.message ?? e).slice(0, 200)}`,
    };
  }
}

export async function setup(ctx) {
  const s = await ctx.api("/api/settings");
  return { webReady: s?.web_ready ?? null, ci: await ciRun(ctx) };
}

export async function run(ctx, s) {
  await ctx.goto(ctx.page, "/settings");
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
          min: input?.min ?? null,
          max: input?.max ?? null,
        };
      }),
    ROWS,
  );
  const first = rows.find((r) => r.shown);
  if (first)
    await ctx.page
      .locator(`.set-row[data-setting="${first.id}"]`)
      .scrollIntoViewIfNeeded()
      .catch(() => {});
  await ctx.shot(`server-rows-${ctx.browser}-${ctx.width}`);
  return { ...s, rows };
}

export function expect(cells) {
  const ok = cells.every(({ result: r }) => {
    const w = r.webReady;
    return (
      !!w &&
      w.probeSeconds >= 1 &&
      w.startSeconds >= 1 &&
      r.rows.every((x) => x.shown && x.value !== null && x.max === "3600")
    );
  });
  const w = cells[0]?.result.webReady;
  return [
    {
      clause: clauses[0],
      ok,
      detail:
        `API web_ready ${JSON.stringify(w)} (defaults 10 s and 120 s, were 1.5 s and 45 s); ` +
        cells
          .map(
            ({ cell, result }) =>
              `${cell.browser}: ${result.rows.map((x) => `${x.id} ${x.shown ? `${x.value} (${x.min}..${x.max})` : "missing"}`).join(", ")}`,
          )
          .join("; "),
      evidence: cells.map(
        ({ cell }) => `server-rows-${cell.browser}-${cell.width}.png`,
      ),
    },
    (() => {
      const ci = cells.find((c) => c.result?.ci)?.result.ci ?? {
        skip: "needs-github-api",
        detail: "no CI reading",
      };
      return ci.skip
        ? { clause: clauses[1], ok: null, skip: ci.skip, detail: ci.detail }
        : { clause: clauses[1], ok: ci.ok, detail: ci.detail };
    })(),
  ];
}
