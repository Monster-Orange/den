// gate/448.mjs: the rail's Terminal reuses the project's running shell
// (issue 448). In a project of the bed, through the page as a person uses
// it: the rail's Terminal twice, then the shell bar's New terminal, then
// the rail's Terminal after using the older shell. Every shell this check
// starts is closed again through the page; a shell the bed had already
// is only opened, never closed. The project in view is put back.
export const issue = 448;
export const clauses = [
  "Terminal opens and focuses the shell already running in that project, no new session",
  "with no running shell in that project, Terminal starts one",
  "New terminal in the shell's bar starts a second shell in one click",
  "with several shells running, Terminal opens the one used most recently",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 180000;

/** The shells this check started, by cell, for teardown. */
const started = new Set();

/** GET through the page (its own sign-in). */
const getJson = (page, path) =>
  page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { accept: "application/json" } });
    return r.ok ? r.json() : null;
  }, path);

/** POST through the page's own API helper. */
const post = (page, path, body) =>
  page.evaluate(
    async ([p, b]) => {
      try {
        await window.denShell.api("POST", p, b);
        return true;
      } catch {
        return false;
      }
    },
    [path, body],
  );

/** Project `ws`'s running plain shells, by id. */
async function shells(page, ws) {
  const d = await getJson(page, "/api/sessions");
  return (d?.sessions ?? [])
    .filter((s) => s.kind === "session" && s.workspace === ws && !s.exited)
    .map((s) => s.id);
}

/** The pane with the keyboard: its session id, or null. */
const keyed = (page) =>
  page.evaluate(
    () => document.activeElement?.closest(".pane[data-id]")?.dataset.id ?? null,
  );

/** The rail's Terminal, then the page done with ?terminal=. */
async function railTerminal(ctx, page) {
  await page.locator('#den-rail [data-nav="terminal"]').click();
  await page.waitForURL(/terminal=1/, { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(
    () => !location.search.includes("terminal="),
    null,
    {
      timeout: 30000,
    },
  );
  await page
    .waitForSelector(".pane[data-id] .xterm-rows", { timeout: 30000 })
    .catch(() => {});
  await ctx.until(async () => Boolean(await keyed(page)), 10000);
  await ctx.sleep(500);
}

/**
 * A bed page as the person sees it: What's new, if it opened over it, is
 * closed by its × (the page then remembers it as seen).
 */
async function visit(ctx, page, path) {
  await ctx.goto(page, path);
  await page.waitForSelector("#den-rail", { timeout: 30000 });
  try {
    await page.locator("#cl-overlay.open").waitFor({ timeout: 2500 });
    await page.click("#cl-close-btn");
    await page
      .locator("#cl-overlay.open")
      .waitFor({ state: "detached", timeout: 5000 });
  } catch {
    /* not shown */
  }
}

export async function setup() {
  return {};
}

export async function run(ctx) {
  const page = ctx.page;
  const b = ctx.browser;
  const cell = `${typeof b === "string" ? b : b?.browserType?.().name?.() || "browser"}-${ctx.width}`;
  const out = { cell, steps: {} };
  await visit(ctx, page, "/agents");
  const scope = await getJson(page, "/api/scope");
  const list = await getJson(page, "/api/sessions");
  const projects = (list?.workspaces ?? []).filter(Boolean);
  if (!projects.length) return { skipped: true, why: "needs-project" };
  // A project with no shell running proves clause 2; else the first one.
  let ws = projects[0];
  for (const w of projects)
    if (!(await shells(page, w)).length) {
      ws = w;
      break;
    }
  out.ws = ws;
  const before = await shells(page, ws);
  out.before = before.length;
  const made = () =>
    shells(page, ws).then((ids) => ids.filter((x) => !before.includes(x)));
  try {
    // First click.
    await visit(ctx, page, `/agents?project=${encodeURIComponent(ws)}`);
    await railTerminal(ctx, page);
    const one = await shells(page, ws);
    const firstKeyed = await keyed(page);
    for (const id of await made()) started.add(id);
    out.steps.first = { count: one.length, keyed: firstKeyed };
    await ctx.shot(`first-${cell}`);
    // Second click: the same shell, in front, with the keyboard.
    await railTerminal(ctx, page);
    const two = await shells(page, ws);
    for (const id of await made()) started.add(id);
    out.steps.second = { count: two.length, keyed: await keyed(page) };
    await ctx.shot(`second-${cell}`);
    // New terminal in the shell's bar.
    const front = out.steps.second.keyed;
    const btn = page.locator(
      `.pane[data-id="${front}"] [data-act="new-shell"]`,
    );
    const hasBtn = front ? (await btn.count()) > 0 : false;
    out.steps.newBtn = hasBtn
      ? (await btn.first().textContent())?.trim() || ""
      : null;
    if (hasBtn) {
      await btn.first().click();
      await ctx.until(
        async () => (await shells(page, ws)).length > two.length,
        30000,
      );
      await ctx.sleep(500);
    }
    const three = await shells(page, ws);
    for (const id of await made()) started.add(id);
    const newer = three.find((x) => !two.includes(x)) ?? null;
    out.steps.fresh = { count: three.length, id: newer };
    await ctx.shot(`new-terminal-${cell}`);
    // Use the older shell, then the rail's Terminal: that one again.
    if (front && newer) {
      await visit(
        ctx,
        page,
        `/agents?project=${encodeURIComponent(ws)}&open=${encodeURIComponent(front)}`,
      );
      const screen = page.locator(`.pane[data-id="${front}"] .xterm-screen`);
      await screen.waitFor({ timeout: 30000 }).catch(() => {});
      await screen.click().catch(() => {});
      await ctx.sleep(300);
      await railTerminal(ctx, page);
      out.steps.recent = {
        used: front,
        keyed: await keyed(page),
        count: (await shells(page, ws)).length,
      };
      await ctx.shot(`most-recent-${cell}`);
    }
  } finally {
    for (const id of await made().catch(() => [])) started.add(id);
    for (const id of [...started])
      if (await post(page, `/api/sessions/${encodeURIComponent(id)}/close`))
        started.delete(id);
    const now = await getJson(page, "/api/scope").catch(() => null);
    if (scope?.scope && now?.scope !== scope.scope)
      await post(page, "/api/scope", { scope: scope.scope });
    // Close ends a shell after its grace: what is left is a refused close.
    out.left = started.size;
  }
  return out;
}

export async function teardown(ctx) {
  // A shell run could not close (it threw first): closed here.
  const page = ctx.page;
  if (!page || !started.size) return;
  for (const id of [...started])
    if (await post(page, `/api/sessions/${encodeURIComponent(id)}/close`))
      started.delete(id);
}

export function expect(cells) {
  const ran = cells.filter((c) => c.result && !c.result.skipped);
  if (!ran.length)
    return clauses.map((clause) => ({
      clause,
      ok: null,
      skip: cells[0]?.result?.why || "needs-project",
    }));
  // A cell that threw has no steps: every clause it carries is false.
  const rows = ran.map((c) => ({ ...c.result, steps: c.result.steps ?? {} }));
  const ev = (k) => rows.map((r) => `${k}-${r.cell}`);
  const said = (f) => rows.map((r) => `${r.cell}: ${f(r)}`).join("; ");
  const empty = rows.filter((r) => r.before === 0);
  return [
    {
      clause: clauses[0],
      ok: rows.every(
        (r) =>
          r.steps.second &&
          r.steps.second.count === r.steps.first.count &&
          r.steps.first.count === Math.max(r.before, 1) &&
          r.steps.second.keyed &&
          r.steps.second.keyed === r.steps.first.keyed,
      ),
      detail: said(
        (r) =>
          `${r.ws}: shells ${r.before} → ${r.steps.first?.count} → ${r.steps.second?.count}; keyboard in ${r.steps.first?.keyed} then ${r.steps.second?.keyed}`,
      ),
      evidence: ev("second"),
    },
    empty.length
      ? {
          clause: clauses[1],
          ok: empty.every(
            (r) => r.steps.first?.count === 1 && Boolean(r.steps.first?.keyed),
          ),
          detail: said((r) => `${r.ws}: ${r.before} → ${r.steps.first?.count}`),
          evidence: ev("first"),
        }
      : { clause: clauses[1], ok: null, skip: "needs-project-without-shell" },
    {
      clause: clauses[2],
      ok: rows.every(
        (r) =>
          r.steps.newBtn !== null &&
          r.steps.fresh?.count === (r.steps.second?.count ?? 0) + 1 &&
          Boolean(r.steps.fresh?.id),
      ),
      detail: said(
        (r) =>
          `button "${r.steps.newBtn}"; shells ${r.steps.second?.count} → ${r.steps.fresh?.count}`,
      ),
      evidence: ev("new-terminal"),
    },
    {
      clause: clauses[3],
      ok: rows.every(
        (r) =>
          r.steps.recent &&
          r.steps.recent.keyed === r.steps.recent.used &&
          r.steps.recent.count === r.steps.fresh.count,
      ),
      detail: said(
        (r) =>
          `used ${r.steps.recent?.used}, newest ${r.steps.fresh?.id}, Terminal opened ${r.steps.recent?.keyed}; ${r.left} left after`,
      ),
      evidence: ev("most-recent"),
    },
  ];
}
