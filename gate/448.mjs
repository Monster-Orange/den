// gate/448.mjs: the rail's Terminal reuses the project's running shell
// (issue 448). In a project of the bed, through the page as a person uses
// it: the rail's Terminal twice, then the shell bar's New terminal, then
// the rail's Terminal after using the older shell. Then under All
// projects, a shell of its own in two projects, each used last in turn
// (Enter at its prompt), and the rail's Terminal after each. Then it ends
// shells of its own (`exit`, typed in the page that still shows them) and
// the rail's Terminal must never open one. Every shell this check starts
// is closed again through the page; a shell the bed had already is only
// opened, never typed in or closed. The view is put back.
import { allSessions } from "./lib/sessions.mjs";
export const issue = 448;
export const clauses = [
  "Terminal opens and focuses the shell already running in that project, no new session",
  "with no running shell in that project, Terminal starts one",
  "New terminal in the shell's bar starts a second shell in one click",
  "with several shells running, Terminal opens the one used most recently",
  "under All projects, Terminal opens the running shell used most recently, across projects",
  "Terminal never opens an exited shell; with none running in scope, it starts one",
  "every new string (New terminal and its tip) has en, es and ja text",
  "the e2e case: the rail's Terminal clicked twice gives one shell session and the same pane focused",
];
/** The page's languages, English first: its words are what es and ja must not be. */
const LANGS = ["en", "es", "ja"];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
// Per cell. Unloaded, a cell takes 70–85 s; on a busy machine more than 180 s.
export const timeoutMs = 360000;

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
 * The New terminal button of shell `id`, in each language: the page's
 * <html lang>, the button's words and its tip. The language is put back.
 */
async function wordsIn(ctx, page, ws, id, cell) {
  const was = (await settings(ctx))?.language ?? null;
  const seen = {};
  try {
    for (const lang of LANGS) {
      await settings(ctx, { language: lang });
      await visit(
        ctx,
        page,
        `/agents?project=${encodeURIComponent(ws)}&open=${encodeURIComponent(id)}`,
      );
      const btn = page
        .locator(`.pane[data-id="${id}"] [data-act="new-shell"]`)
        .first();
      await btn.waitFor({ timeout: 30000 }).catch(() => {});
      seen[lang] = {
        html: await page.evaluate(() => document.documentElement.lang),
        text: ((await btn.textContent().catch(() => "")) || "").trim(),
        tip: ((await btn.getAttribute("title").catch(() => "")) || "").trim(),
      };
      await ctx.shot(`words-${lang}-${cell}`);
    }
  } finally {
    await settings(ctx, { language: was });
  }
  return seen;
}

/** Project `ws`'s running plain shells, by id. */
async function shells(page, ws) {
  const d = await allSessions((u) => getJson(page, u));
  return (d?.sessions ?? [])
    .filter((s) => s.kind === "session" && s.workspace === ws && !s.exited)
    .map((s) => s.id);
}

/** Every running plain shell, in any project, by id. */
async function allShells(page) {
  const d = await allSessions((u) => getJson(page, u));
  return (d?.sessions ?? [])
    .filter((s) => s.kind === "session" && !s.exited)
    .map((s) => s.id);
}

/** Whether shell `id` has ended (exited, or no longer listed). */
async function ended(page, id) {
  const d = await allSessions((u) => getJson(page, u));
  const s = (d?.sessions ?? []).find((x) => x.id === id);
  return !s || s.exited === true;
}

/**
 * A person at shell `id`'s pane (already open on this page): a click,
 * then Enter at its prompt (runs nothing), or `exit` and Enter.
 */
async function typeAt(ctx, page, id, { exit = false } = {}) {
  const screen = page.locator(`.pane[data-id="${id}"] .xterm-screen`);
  await screen.waitFor({ timeout: 30000 }).catch(() => {});
  await screen.click().catch(() => {});
  await ctx.sleep(200);
  if (exit) await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await ctx.sleep(300);
  // ctx.until gives the ms it took (0 counts) or null on timeout.
  if (exit) return (await ctx.until(() => ended(page, id), 15000)) !== null;
  return true;
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
  const list = await allSessions((u) => getJson(page, u));
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
  out.projects = projects.length;
  const before = await shells(page, ws);
  out.before = before.length;
  const made = () =>
    shells(page, ws).then((ids) => ids.filter((x) => !before.includes(x)));
  // Every project's shells the bed had: never typed in, never closed.
  const beforeAll = await allShells(page);
  const own = (id) => Boolean(id) && !beforeAll.includes(id);
  const madeAll = () =>
    allShells(page).then((ids) => ids.filter((x) => own(x)));
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
    // Clause 7: the button and its tip in en, es and ja. A refused
    // settings call fails this clause only, with its reason.
    if (front)
      out.steps.words = await wordsIn(ctx, page, ws, front, cell).catch(
        (e) => ({ error: String(e?.message ?? e) }),
      );
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
    // Clause 5: All projects. A shell of the check's own in this project
    // and another one; each used last in turn (Enter at its prompt), then
    // the rail's Terminal with no project named.
    const other = projects.find((w) => w !== ws);
    if (other) {
      await post(page, "/api/scope", { scope: "all" });
      const mine = {};
      for (const w of [ws, other]) {
        await visit(ctx, page, `/agents?project=${encodeURIComponent(w)}`);
        await railTerminal(ctx, page);
        let id = await keyed(page);
        // The bed's own shell opened: one of the check's own beside it.
        if (id && !own(id)) {
          const nb = page.locator(
            `.pane[data-id="${id}"] [data-act="new-shell"]`,
          );
          if ((await nb.count()) > 0) {
            const was = await shells(page, w);
            await nb.first().click();
            await ctx.until(
              async () => (await shells(page, w)).length > was.length,
              30000,
            );
            await ctx.sleep(500);
            id = (await shells(page, w)).find((x) => !was.includes(x)) ?? null;
          } else id = null;
        }
        for (const x of await madeAll()) started.add(x);
        mine[w] = own(id) ? id : null;
      }
      out.steps.all = { ws, other, mine, rounds: [] };
      // The other project's first (it is listed after or before this
      // one: the first one listed loses one round either way), then this.
      for (const w of [other, ws]) {
        const target = mine[w];
        if (!target) continue;
        await visit(ctx, page, `/agents?open=${encodeURIComponent(target)}`);
        await typeAt(ctx, page, target);
        const count = (await allShells(page)).length;
        await visit(ctx, page, "/agents");
        await railTerminal(ctx, page);
        for (const x of await madeAll()) started.add(x);
        out.steps.all.rounds.push({
          used: target,
          keyed: await keyed(page),
          before: count,
          after: (await allShells(page)).length,
        });
        await ctx.shot(`all-projects-${w}-${cell}`);
      }
      if (scope?.scope && scope.scope !== "all")
        await post(page, "/api/scope", { scope: scope.scope });
    }
    // Clause 6: exited shells. (a) A shell of the check's own, used last,
    // ends in the page that still shows it running: the rail's Terminal
    // opens a running one instead. (b) With every shell in this project
    // the check's own, all of them end: the rail's Terminal starts one.
    const ownHere = (await shells(page, ws)).filter((x) => own(x));
    const gone = [];
    if (ownHere.length) {
      const e = ownHere.at(-1);
      await visit(
        ctx,
        page,
        `/agents?project=${encodeURIComponent(ws)}&open=${encodeURIComponent(e)}`,
      );
      await typeAt(ctx, page, e);
      const endedA = await typeAt(ctx, page, e, { exit: true });
      if (endedA) gone.push(e);
      const runningA = await shells(page, ws);
      await railTerminal(ctx, page);
      for (const x of await madeAll()) started.add(x);
      const keyedA = await keyed(page);
      out.steps.exited = {
        a: {
          ended: e,
          endedOk: endedA,
          keyed: keyedA,
          running: Boolean(keyedA) && (await shells(page, ws)).includes(keyedA),
          hadRunning: runningA.length,
        },
      };
      await ctx.shot(`exited-${cell}`);
      if (before.length === 0) {
        for (const x of (await shells(page, ws)).filter((y) => own(y))) {
          await visit(
            ctx,
            page,
            `/agents?project=${encodeURIComponent(ws)}&open=${encodeURIComponent(x)}`,
          );
          if (await typeAt(ctx, page, x, { exit: true })) gone.push(x);
        }
        const left = await shells(page, ws);
        await railTerminal(ctx, page);
        for (const x of await madeAll()) started.add(x);
        const keyedB = await keyed(page);
        const now = await shells(page, ws);
        out.steps.exited.b = {
          ended: [...gone],
          left: left.length,
          keyed: keyedB,
          fresh:
            Boolean(keyedB) &&
            own(keyedB) &&
            !gone.includes(keyedB) &&
            now.includes(keyedB) &&
            !left.includes(keyedB),
          count: now.length,
        };
        await ctx.shot(`none-running-${cell}`);
      }
    }
  } finally {
    for (const id of await made().catch(() => [])) started.add(id);
    for (const id of await madeAll().catch(() => [])) started.add(id);
    for (const id of [...started])
      if (
        (await post(page, `/api/sessions/${encodeURIComponent(id)}/close`)) ||
        (await ended(page, id).catch(() => false))
      )
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
    if (
      (await post(page, `/api/sessions/${encodeURIComponent(id)}/close`)) ||
      (await ended(page, id).catch(() => false))
    )
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
    allProjects(rows),
    exitedShells(rows, ev),
    words(rows),
    {
      clause: clauses[7],
      ok: rows.every(
        (r) =>
          r.steps.first?.count >= 1 &&
          r.steps.second?.count === r.steps.first.count &&
          Boolean(r.steps.first.keyed) &&
          r.steps.second.keyed === r.steps.first.keyed,
      ),
      detail: said(
        (r) =>
          `two clicks: shells ${r.steps.first?.count} then ${r.steps.second?.count}; pane ${r.steps.first?.keyed} then ${r.steps.second?.keyed}`,
      ),
      evidence: [...ev("first"), ...ev("second")],
    },
  ];
}

/**
 * Clause 7: in each language the page is in that language, the button and
 * its tip have words, never a catalog key, and es and ja are not English.
 */
function words(rows) {
  const seen = rows.map((r) => [r.cell, r.steps.words]).filter(([, w]) => w);
  if (seen.length < rows.length)
    return {
      clause: clauses[6],
      ok: false,
      detail: `the button was read in ${seen.length} of ${rows.length} cells`,
    };
  const key = /^ag\.|^\s*$/;
  const good = (w) =>
    LANGS.every(
      (l) =>
        w[l] && w[l].html === l && !key.test(w[l].text) && !key.test(w[l].tip),
    ) &&
    ["es", "ja"].every((l) => w[l].text !== w.en.text && w[l].tip !== w.en.tip);
  return {
    clause: clauses[6],
    ok: seen.every(([, w]) => good(w)),
    detail: seen
      .map(
        ([c, w]) =>
          `${c}: ` +
          (w.error ? `${w.error}; ` : "") +
          LANGS.map(
            (l) => `${l} (html ${w[l]?.html}) "${w[l]?.text}" / "${w[l]?.tip}"`,
          ).join("; "),
      )
      .join(" | "),
    evidence: seen.flatMap(([c]) => LANGS.map((l) => `words-${l}-${c}`)),
  };
}

/** Clause 5: under All projects, each round's Terminal opened the shell used last. */
function allProjects(rows) {
  // A cell that threw has no steps: it counts, and fails.
  const two = rows.filter((r) => !(r.projects < 2));
  if (!two.length)
    return { clause: clauses[4], ok: null, skip: "needs-two-projects" };
  return {
    clause: clauses[4],
    ok: two.every(
      (r) =>
        r.steps.all?.rounds?.length === 2 &&
        r.steps.all.rounds.every(
          (x) => x.keyed === x.used && x.after === x.before,
        ),
    ),
    detail: two
      .map(
        (r) =>
          `${r.cell}: ` +
          (r.steps.all?.rounds ?? [])
            .map(
              (x) =>
                `used ${x.used}, Terminal opened ${x.keyed}, shells ${x.before} → ${x.after}`,
            )
            .join("; "),
      )
      .join(" | "),
    evidence: two.flatMap((r) =>
      [r.steps.all?.other, r.steps.all?.ws]
        .filter(Boolean)
        .map((w) => `all-projects-${w}-${r.cell}`),
    ),
  };
}

/** Clause 6: an exited shell never opened; with none running, a new one started. */
function exitedShells(rows, ev) {
  return {
    clause: clauses[5],
    ok: rows.every((r) => {
      const a = r.steps.exited?.a;
      const b = r.steps.exited?.b;
      return (
        Boolean(a) &&
        a.endedOk === true &&
        a.keyed !== a.ended &&
        a.running === true &&
        (r.before > 0 || (Boolean(b) && b.left === 0 && b.fresh === true))
      );
    }),
    detail: rows
      .map((r) => {
        const a = r.steps.exited?.a;
        const b = r.steps.exited?.b;
        return (
          `${r.cell}: ${a?.ended} ended (${a?.endedOk ? "listed as ended" : "never ended"}), ` +
          `Terminal opened ${a?.keyed} (${a?.running ? "running" : "not running"})` +
          (b
            ? `; all ${b.ended.length} ended, ${b.left} running, Terminal opened ${b.keyed} (${b.fresh ? "a new one" : "not a new one"})`
            : r.before > 0
              ? "; the bed's own shell runs here: the none-running half is not tried"
              : "; the none-running half never ran")
        );
      })
      .join(" | "),
    evidence: [...ev("exited"), ...ev("none-running")],
  };
}
