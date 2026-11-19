/* eslint-env browser */
// Live check for #252: a person sets one agent's mode in the page, no CLI. One bed stub agent, made as
// gate-252-mode and removed in teardown. The person (the signed-in page) chooses a mode from the agent's ⋯
// menu; Den restarts it at its next idle in that mode, writes an audit row saying it did it and why, and
// the row says "from its own setting". Follow project (the same menu) returns it, restarted again.
// Agents › ⋯ › Mode is English on the bed (its language); the mode itself is read from data attributes.
export const issue = 252;
export const clauses = [
  "a Mode item in the agent's ⋯ menu, with the choices and Follow project; the busy pop-up shows while it applies and the result is said",
  "an audit row for each restart that follows a mode change, by Den itself",
  'the CLI says the agent restarts at its next idle, not "from its next start"',
  'choosing a mode restarts it at idle in that mode, and the row shows "from its own setting"; Follow project returns it to the project\'s mode',
];
export const matrix = { browsers: ["chromium"], widths: [1280] };
export const timeoutMs = 240000;
const ID = "gate-252-mode";
// The menu's radios, in order (agents-page.js): ask, edits, auto, all, then Follow project.
const ORDER = ["ask", "edits", "auto", "all"];
const SOURCE_WORDS = {
  own: "its own setting",
  project: "its project",
  install: "the Den-wide default",
  persona: "its persona",
  default: "Den's default",
};

export async function setup(ctx) {
  const a = ctx.agent(ID);
  a.start("tester");
  return { runMs: await a.running(20000) };
}

/** The stub's project and live session, from the sessions list. */
async function whereIs(ctx) {
  const d = await ctx.api("/api/sessions");
  const s = (d?.sessions ?? []).find(
    (x) => x.kind === "agent" && x.agent === ID && !x.exited,
  );
  return s ? { ws: s.workspace, session: s.id } : null;
}

/** Its mode on the project's view: the mode, where from, and the mode its process still runs in. */
async function modeOf(ctx, ws) {
  const v = await ctx.api(
    `/api/workspaces/${encodeURIComponent(ws)}/agent-modes`,
  );
  const m = (v?.agents ?? []).find((x) => x.agent === ID);
  return m
    ? {
        mode: m.mode,
        source: m.source,
        running: m.running ?? null,
        stopped: !!m.stopped,
        project: v.mode ?? null,
      }
    : null;
}

const auditDetails = (ctx) =>
  String(ctx.readBed("audit.jsonl") ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l).detail ?? "";
      } catch {
        return "";
      }
    });

/** Opens the agent's ⋯ › Mode; the radios' [label, checked]. */
async function openMode(ctx, ws) {
  const p = ctx.page;
  await ctx.goto(
    p,
    `/agents?project=${encodeURIComponent(ws)}&agent=${encodeURIComponent(ID)}`,
  );
  const row = `.agst[data-agent="${ID}"] .agr`;
  await p.waitForSelector(row, { timeout: 20000 });
  const more = '.pane [data-act="more"]';
  if (!(await p.locator(more).count())) await p.click(row);
  await p.waitForSelector(more, { timeout: 15000 });
  await p.click(more);
  await p
    .locator('.den-pop[role="menu"] .den-mi', { hasText: /^Mode/ })
    .first()
    .click();
  await p.waitForSelector('.den-pop[role="menu"] [role="menuitemradio"]', {
    timeout: 10000,
  });
  return p
    .locator('.den-pop[role="menu"] [role="menuitemradio"]')
    .evaluateAll((els) =>
      els.map((e) => [
        (
          e.querySelector(".den-mi-l")?.textContent ??
          e.textContent ??
          ""
        ).trim(),
        e.getAttribute("aria-checked"),
      ]),
    );
}

/** Clicks radio `i`; whether the busy pop-up showed, and the result said. */
async function choose(ctx, i) {
  const p = ctx.page;
  const busy = p
    .waitForSelector("den-busy", { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  await p
    .locator('.den-pop[role="menu"] [role="menuitemradio"]')
    .nth(i)
    .click();
  const said = await p
    .getByText(/Den restarts it at its next idle to take it\./)
    .first()
    .textContent({ timeout: 15000 })
    .catch(() => null);
  return { busy: await busy, said: said?.replace(/\s+/g, " ").trim() ?? null };
}

/** Waits until it runs in `mode` from `source` in a new session; how long, or null. */
async function restartedIn(ctx, ws, before, mode, source) {
  const a = ctx.agent(ID);
  let last = null;
  const ms = await ctx.until(async () => {
    a.idlePrompt();
    const w = await whereIs(ctx);
    last = { ...(await modeOf(ctx, ws)), session: w?.session ?? null };
    return (
      last.mode === mode &&
      last.source === source &&
      !last.running &&
      !last.stopped &&
      !!w &&
      w.session !== before
    );
  }, 90000);
  return { ms, last };
}

/** The agent's row tag on the page now: data-mode, data-mode-source, its words. */
async function rowTag(ctx, ws) {
  await ctx.goto(
    ctx.page,
    `/agents?project=${encodeURIComponent(ws)}&agent=${encodeURIComponent(ID)}`,
  );
  const sel = `.agst[data-agent="${ID}"] [data-mode]`;
  await ctx.page.waitForSelector(sel, { timeout: 20000 }).catch(() => {});
  return ctx.page
    .evaluate((s) => {
      const e = document.querySelector(s);
      return e
        ? {
            mode: e.getAttribute("data-mode"),
            source: e.getAttribute("data-mode-source"),
            text: e.textContent.trim(),
          }
        : null;
    }, sel)
    .catch(() => null);
}

export async function run(ctx, s) {
  const r = { ...s, help: null };
  const h = ctx.cli(["agents", "--help"]);
  r.help = `${h.out}\n${h.err}`;
  const w = await whereIs(ctx);
  if (!w) return { ...r, missing: "session" };
  r.ws = w.ws;
  const start = await modeOf(ctx, w.ws);
  if (!start) return { ...r, missing: "mode" };
  r.start = start;
  const want = start.mode === "edits" ? "ask" : "edits";
  r.want = want;

  r.menu = await openMode(ctx, w.ws);
  await ctx.shot("mode-menu");
  r.set = await choose(ctx, ORDER.indexOf(want));
  await ctx.shot("mode-chosen");
  r.toOwn = await restartedIn(ctx, w.ws, w.session, want, "own");
  r.tagOwn = await rowTag(ctx, w.ws);
  await ctx.shot("mode-own-row");

  const w2 = await whereIs(ctx);
  r.menu2 = await openMode(ctx, w.ws);
  r.follow = await choose(ctx, ORDER.length);
  r.back = await restartedIn(
    ctx,
    w.ws,
    w2?.session ?? null,
    start.mode,
    start.source,
  );
  r.tagBack = await rowTag(ctx, w.ws);
  await ctx.shot("mode-followed-row");
  r.audit = auditDetails(ctx);
  return r;
}

export function expect(cells) {
  const r = cells[0]?.result ?? {};
  const help =
    /restarts at its next idle/.test(r.help || "") &&
    !/from its next start/.test(r.help || "");
  const cli = {
    clause: clauses[2],
    ok: help,
    detail: help
      ? 'agents --help: "restarts at its next idle"'
      : `agents --help: ${String(r.help || "").slice(0, 200)}`,
  };
  if (r.missing)
    return [
      ...[0, 1, 3].map((i) => ({
        clause: clauses[i],
        ok: null,
        skip: "needs-mode-runtime",
        detail:
          r.missing === "session"
            ? `${ID} has no running session on the bed`
            : `the bed stub's runtime has no permission modes, so its project lists no mode for it (project ${r.ws})`,
      })),
      cli,
    ].sort((a, b) => clauses.indexOf(a.clause) - clauses.indexOf(b.clause));
  const menuOk = (m, checked) =>
    Array.isArray(m) &&
    m.length === 5 &&
    /^Follow project/.test(m[4][0] || "") &&
    m.every(([l]) => !!l) &&
    m.filter(([, c]) => c === "true").length === 1 &&
    m[checked]?.[1] === "true";
  const ownWords = `restarted ${ID} in ${r.ws} at idle to take mode ${r.want}, from ${SOURCE_WORDS.own}, by Den itself`;
  const backWords = `restarted ${ID} in ${r.ws} at idle to take mode ${r.start?.mode}, from ${SOURCE_WORDS[r.start?.source]}, by Den itself`;
  const audit = r.audit || [];
  const shots = [
    "mode-menu",
    "mode-chosen",
    "mode-own-row",
    "mode-followed-row",
  ].map((n) => `${n}.png`);
  return [
    {
      clause: clauses[0],
      ok:
        menuOk(r.menu, 4) &&
        new RegExp(
          `^${ID}: \\w+, its own setting\\. Den restarts it at its next idle`,
        ).test(r.set?.said || "") &&
        menuOk(r.menu2, ORDER.indexOf(r.want)) &&
        !!r.follow?.said,
      detail: `menu ${JSON.stringify(r.menu)}; working pop-up opened ${r.set?.busy} (a fast answer is said in a toast instead, the kit's rule); said "${r.set?.said}"; after: ${JSON.stringify(r.menu2)}; Follow project busy ${r.follow?.busy}, said "${r.follow?.said}"`,
      evidence: shots.slice(0, 2),
    },
    {
      clause: clauses[1],
      ok: audit.includes(ownWords) && audit.includes(backWords),
      detail: `"${ownWords}": ${audit.includes(ownWords)}; "${backWords}": ${audit.includes(backWords)}`,
    },
    cli,
    {
      clause: clauses[3],
      ok:
        r.toOwn?.ms !== null &&
        r.tagOwn?.mode === r.want &&
        r.tagOwn?.source === "own" &&
        /from its own setting/.test(r.tagOwn?.text || "") &&
        r.back?.ms !== null &&
        r.tagBack?.mode === r.start?.mode &&
        r.tagBack?.source === r.start?.source,
      detail:
        `started ${r.start?.mode} from ${r.start?.source} (project ${r.start?.project}); ` +
        `chose ${r.want}: restarted in it after ${r.toOwn?.ms} ms (${JSON.stringify(r.toOwn?.last)}), row "${r.tagOwn?.text}" (${r.tagOwn?.source}); ` +
        `Follow project: back to ${r.start?.mode} after ${r.back?.ms} ms (${JSON.stringify(r.back?.last)}), row "${r.tagBack?.text}" (${r.tagBack?.source})`,
      evidence: shots.slice(2),
    },
  ];
}

export async function teardown(ctx) {
  if (ctx.agent(ID).state()) ctx.agent(ID).remove();
}
