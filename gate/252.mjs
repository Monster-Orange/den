/* eslint-env browser */
// Live check for #252: a person sets one agent's mode in the page, no CLI. One bed stub agent, made as
// gate-252-mode and removed in teardown. The person (the signed-in page) chooses a mode from the agent's ⋯
// menu; Den restarts it at its next idle in that mode, writes an audit row saying it did it and why, and
// the row says "from its own setting". Follow project (the same menu) returns it, restarted again.
// Every control is found by its role and its words from the page's own catalog (denShell.t), never by
// English text, a styling class or its place; modes are read from data attributes.
import * as fs from "fs";
export const issue = 252;
export const clauses = [
  "a Mode item in the agent's ⋯ menu, with the choices and Follow project; the button shows busy while it applies and the result is said",
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
  const runMs = await a.running(20000);
  // Rows written before this run can't count (an old run's would pass).
  return { runMs, auditFrom: auditDetails(ctx).length };
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
  String(ctx.readBed("state:audit.jsonl") ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l).detail ?? "";
      } catch {
        return "";
      }
    });

/** The page's own words for `key` (its catalog, the page's language). */
const words = (p, key, vars) =>
  p.evaluate(([k, v]) => window.denShell.t(k, v), [key, vars ?? {}]);

async function agentRow(p) {
  const open = await words(p, "ag.openName", { id: "\u0000" });
  const [pre, post, extra] = open.split("\u0000");
  if (post === undefined || extra !== undefined)
    throw new Error(`the page's "ag.openName" has no one {id}: "${open}"`);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return p
    .getByRole("button", {
      name: new RegExp(`^${esc(pre)}.+ / .+${esc(post)}`),
    })
    .filter({ hasText: ID });
}

async function dump(ctx, what) {
  try {
    const seen = await ctx.page.evaluate(
      (id) => ({
        url: location.href,
        block:
          document.querySelector(`[data-agent="${id}"]`)?.outerHTML ?? null,
        buttons: [...document.querySelectorAll("button")]
          .map((b) => [
            b.getAttribute("aria-label"),
            b.textContent.replace(/\s+/g, " ").trim().slice(0, 160),
          ])
          .filter(([n, t]) => n || t),
      }),
      ID,
    );
    fs.writeFileSync(
      ctx.evidence(`dom-${what}.json`),
      JSON.stringify(seen, null, 2),
    );
    await ctx.shot(`timeout-${what}`);
  } catch {
    return;
  }
}

async function waitOr(ctx, loc, ms, what) {
  try {
    await loc.waitFor({ timeout: ms });
  } catch (e) {
    await dump(ctx, what);
    throw e;
  }
}

/** Opens the agent's ⋯ › Mode (`mode`: the one it shows); the radios' [mode or "follow", checked]. */
async function openMode(ctx, ws, mode) {
  const p = ctx.page;
  await ctx.goto(
    p,
    `/agents?project=${encodeURIComponent(ws)}&agent=${encodeURIComponent(ID)}`,
  );
  const row = await agentRow(p);
  await waitOr(ctx, row, 20000, "row");
  const more = p.getByRole("button", {
    name: await words(p, "ag.more", { id: ID }),
    exact: true,
  });
  if (!(await more.count())) await row.click();
  await waitOr(ctx, more, 15000, "more");
  await more.click();
  const [ipre, ipost] = (await words(p, "ag.mode.item", { m: "\u0000" })).split(
    "\u0000",
  );
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await p
    .getByRole("menuitem", {
      name: new RegExp(`^${esc(ipre)}.+${esc(ipost ?? "")}$`),
    })
    .click();
  const radios = p.getByRole("menuitemradio");
  await waitOr(
    ctx,
    p.getByRole("menuitemradio", { name: await words(p, "ag.mode.follow") }),
    10000,
    "radios",
  );
  const out = [];
  for (const m of ORDER) {
    const r = p.getByRole("menuitemradio", {
      name: await words(p, `pm.${m}`),
      exact: true,
    });
    out.push([
      m,
      (await r.count()) === 1 ? await r.getAttribute("aria-checked") : null,
    ]);
  }
  const follow = p.getByRole("menuitemradio", {
    name: await words(p, "ag.mode.follow"),
  });
  out.push([
    "follow",
    (await follow.count()) === 1
      ? await follow.getAttribute("aria-checked")
      : null,
  ]);
  return { radios: await radios.count(), items: out };
}

/**
 * Picks `pick` (a mode, or "follow"); whether a button showed busy while it
 * applied, and whether the result was said in the page's words: the mode's
 * name, or for Follow project the project's (`then`).
 */
async function choose(ctx, pick, then) {
  const p = ctx.page;
  // The control the pick is pressed through: the agent's ⋯ (the menu's
  // anchor, which busyAction holds). Only its own aria-busy counts.
  const more = await words(p, "ag.more", { id: ID });
  await p.evaluate(
    ([label]) => {
      window.__busy252 = false;
      const b = [...document.querySelectorAll("button[aria-label]")].find(
        (e) => e.getAttribute("aria-label") === label,
      );
      if (!b) return;
      const o = new MutationObserver(() => {
        if (b.getAttribute("aria-busy") === "true") window.__busy252 = true;
      });
      o.observe(b, { attributes: true, attributeFilter: ["aria-busy"] });
      window.__busy252o = o;
    },
    [more],
  );
  const name =
    pick === "follow"
      ? await words(p, "ag.mode.follow")
      : await words(p, `pm.${pick}`);
  const posted = p
    .waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        /\/agents\/[^/]+\/mode$/.test(new URL(res.url()).pathname),
      { timeout: 15000 },
    )
    .catch(() => null);
  await p
    .getByRole("menuitemradio", { name, exact: pick !== "follow" })
    .click();
  const res = await posted;
  const answer = res
    ? {
        status: res.status(),
        code: (await res.json().catch(() => null))?.code ?? null,
      }
    : null;
  const want = await words(
    p,
    pick === "follow" ? "ag.mode.followS" : "ag.mode.setS",
    { id: ID, m: await words(p, `pm.name.${pick === "follow" ? then : pick}`) },
  );
  const said = await p
    .getByText(want, { exact: true })
    .waitFor({ timeout: 15000 })
    .then(() => want)
    .catch(() => null);
  const busy = await p.evaluate(() => {
    window.__busy252o?.disconnect();
    return window.__busy252 === true;
  });
  return { busy, said, want, answer };
}

/** Waits until it runs in `mode` from `source` in a new session; how long, or null. */
async function restartedIn(ctx, ws, before, mode, source) {
  const a = ctx.agent(ID);
  let last = null;
  a.idlePrompt();
  const ms = await ctx.until(async () => {
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
  const ownWords = await words(ctx.page, "ag.mode.src.own");
  const tag = (await agentRow(ctx.page)).locator("[data-mode]");
  try {
    await waitOr(ctx, tag, 20000, "tag");
    return {
      mode: await tag.getAttribute("data-mode"),
      source: await tag.getAttribute("data-mode-source"),
      text: ((await tag.textContent()) ?? "").trim(),
      ownWords,
    };
  } catch {
    return null;
  }
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

  r.menu = await openMode(ctx, w.ws, start.mode);
  await ctx.shot("mode-menu");
  r.set = await choose(ctx, want);
  await ctx.shot("mode-chosen");
  r.toOwn = await restartedIn(ctx, w.ws, w.session, want, "own");
  r.tagOwn = await rowTag(ctx, w.ws);
  await ctx.shot("mode-own-row");

  const w2 = await whereIs(ctx);
  r.menu2 = await openMode(ctx, w.ws, want);
  r.follow = await choose(ctx, "follow", start.mode);
  r.back = await restartedIn(
    ctx,
    w.ws,
    w2?.session ?? null,
    start.mode,
    start.source,
  );
  r.tagBack = await rowTag(ctx, w.ws);
  await ctx.shot("mode-followed-row");
  // Only the rows this run wrote (setup counted the ones before it).
  r.audit = auditDetails(ctx).slice(s.auditFrom ?? 0);
  return r;
}

function permissionHelp(help) {
  const ls = String(help || "").split("\n");
  const at = ls.findIndex((l) => /agents permission <id>/.test(l));
  if (at < 0) return "";
  const lead = (l) => l.match(/^\s*/)[0].length;
  let end = at + 1;
  while (end < ls.length && lead(ls[end]) > lead(ls[at])) end++;
  return ls.slice(at, end).join("\n");
}

export function expect(cells) {
  // One cell (chromium at 1280): the one with a result.
  const r = cells.find((c) => c?.result)?.result ?? {};
  const said = permissionHelp(r.help);
  const help =
    /restarts at its next idle/.test(said) && !/from its next start/.test(said);
  const cli = {
    clause: clauses[2],
    ok: help,
    detail: help
      ? 'agents --help: "restarts at its next idle"'
      : `agents --help, its permission <id> part: ${JSON.stringify(said.slice(0, 300))}`,
  };
  // Setup started the agent, so no session now is a failure. Only a
  // runtime without modes (its project lists no mode for it) is skipped.
  if (r.missing === "session")
    return [
      ...[0, 1, 3].map((i) => ({
        clause: clauses[i],
        ok: false,
        detail: `${ID} has no running session on the bed, though setup started it`,
      })),
      cli,
    ].sort((a, b) => clauses.indexOf(a.clause) - clauses.indexOf(b.clause));
  if (r.missing)
    return [
      ...[0, 1, 3].map((i) => ({
        clause: clauses[i],
        ok: null,
        skip: "needs-mode-runtime",
        detail: `the bed stub's runtime has no permission modes, so its project lists no mode for it (project ${r.ws})`,
      })),
      cli,
    ].sort((a, b) => clauses.indexOf(a.clause) - clauses.indexOf(b.clause));
  // The five radios, each found by its words, exactly one checked: `checked`.
  const menuOk = (m, checked) =>
    m?.radios === 5 &&
    Array.isArray(m.items) &&
    m.items.length === 5 &&
    m.items.every(([, c]) => c === "true" || c === "false") &&
    m.items.filter(([, c]) => c === "true").length === 1 &&
    m.items.find(([k]) => k === checked)?.[1] === "true";
  const ownWords = `restarted ${ID} in ${r.ws} at idle to take mode ${r.want}, from ${SOURCE_WORDS.own}, by Den itself`;
  const backWords = `restarted ${ID} in ${r.ws} at idle to take mode ${r.start?.mode}, from ${SOURCE_WORDS[r.start?.source]}, by Den itself`;
  const audit = r.audit || [];
  const shots = [
    "mode-menu",
    "mode-chosen",
    "mode-own-row",
    "mode-followed-row",
  ].map((n) => `${n}.png`);
  const no = [r.set, r.follow].find((x) => x?.answer?.status === 403)?.answer;
  const refused = no
    ? `the bed refused the mode write (403 ${no.code ?? "no code"}); `
    : "";
  const told = (row) =>
    row === cli ? row : { ...row, detail: refused + row.detail };
  return [
    {
      clause: clauses[0],
      ok:
        menuOk(r.menu, r.start?.source === "own" ? r.start.mode : "follow") &&
        !!r.set?.said &&
        r.set?.busy === true &&
        menuOk(r.menu2, r.want) &&
        !!r.follow?.said &&
        r.follow?.busy === true,
      detail: `menu ${JSON.stringify(r.menu)}; busy in the button ${r.set?.busy}; said "${r.set?.said}" (wanted "${r.set?.want}"); after: ${JSON.stringify(r.menu2)}; Follow project busy ${r.follow?.busy}, said "${r.follow?.said}"`,
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
        // It starts from its project or the install, so a pick is a change.
        ["project", "install"].includes(r.start?.source) &&
        r.toOwn?.ms !== null &&
        r.tagOwn?.mode === r.want &&
        r.tagOwn?.source === "own" &&
        !!r.tagOwn?.ownWords &&
        String(r.tagOwn?.text ?? "").includes(r.tagOwn.ownWords) &&
        r.back?.ms !== null &&
        r.tagBack?.mode === r.start?.mode &&
        r.tagBack?.source === r.start?.source,
      detail:
        `started ${r.start?.mode} from ${r.start?.source} (project ${r.start?.project}); ` +
        `chose ${r.want}: restarted in it after ${r.toOwn?.ms} ms (${JSON.stringify(r.toOwn?.last)}), row "${r.tagOwn?.text}" (${r.tagOwn?.source}); ` +
        `Follow project: back to ${r.start?.mode} after ${r.back?.ms} ms (${JSON.stringify(r.back?.last)}), row "${r.tagBack?.text}" (${r.tagBack?.source})`,
      evidence: shots.slice(2),
    },
  ].map(told);
}

export async function teardown(ctx) {
  if (ctx.agent(ID).state()) ctx.agent(ID).remove();
}
