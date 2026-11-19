/* eslint-env browser */
// Live check for issue 268: the two agent-mode rows say which is Den-wide and which is the project's
// override, and which wins. Read in a browser with one project overriding and one following, as the issue
// asks. One bed stub agent, gate-268-mode, removed in teardown. Its project is the one that overrides: if
// it follows, the check sets that project's mode (a person's act, through the person's token), and puts it
// back in teardown. The other project is one that already follows: the check never changes it. The page's
// language is changed for es and ja and put back in a finally.
export const issue = 268;
export const clauses = [
  'both rows name the layers the same way, "Den-wide default" and "this project (overrides the Den-wide default)", and each says the order once: the agent\'s own choice, the project, Den-wide, the persona',
  'each row shows what is in effect and where it comes from: "Following Den-wide: …" until the project sets one, then "Set for this project: … (Den-wide is …)", with "Use Den-wide" to clear it',
  'each row links to the other: "Change the Den-wide default" and "N projects override this"',
  "the Agents list uses the same words for each agent's mode source",
  "the rows' words are in en, es and ja",
  "from either row alone, a person can tell which mode an agent in this project runs in and why, with one project overriding and one following",
];
export const matrix = { browsers: ["chromium"], widths: [1280] };
export const timeoutMs = 240000;

const ID = "gate-268-mode";
const LANGS = ["en", "es", "ja"];
// The modes' words on the bed (English), as the rows say them.
const WORDS = {
  ask: "Ask for everything",
  edits: "Auto-approve edits in the worktree",
  auto: "Auto mode",
  all: "Auto-approve all",
  persona: "each persona's own mode",
};
const NAMES = { ask: "Ask", edits: "Edits", auto: "Auto", all: "All" };
const ORDER =
  /own setting, then the project, then the Den-wide default, then its persona/g;

const post = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
async function get(ctx, path) {
  try {
    const r = await ctx.fetch(path);
    return r.status === 200 ? r.body : null;
  } catch {
    return null;
  }
}
const modesPath = (ws) =>
  `/api/workspaces/${encodeURIComponent(ws)}/agent-modes`;

/** The stub's project, from the sessions list. */
async function stubProject(ctx) {
  const d = await get(ctx, "/api/sessions");
  return (
    (d?.sessions ?? []).find(
      (x) => x.kind === "agent" && x.agent === ID && !x.exited,
    )?.workspace ?? null
  );
}

export async function setup(ctx) {
  const s = {
    lang: (await get(ctx, "/api/settings"))?.language ?? null,
    set: null,
  };
  const a = ctx.agent(ID);
  a.start("tester");
  s.runMs = await a.running(20000);
  s.over = await stubProject(ctx);
  if (!s.over) return s;
  const view = await get(ctx, modesPath(s.over));
  s.overWas = view?.mode ?? null;
  // The other project: one that follows already. Never changed.
  const ws = Object.keys((await get(ctx, "/api/workspaces"))?.workspaces ?? {});
  for (const w of ws) {
    if (w === s.over) continue;
    const v = await get(ctx, modesPath(w));
    if (v && !v.mode) {
      s.follow = w;
      break;
    }
  }
  if (!s.follow) return s;
  // The stub's project overrides: a mode other than Den-wide's, when it has none of its own.
  if (!s.overWas) {
    const dw = view?.install ?? null;
    s.set = dw === "ask" ? "edits" : "ask";
    const r = await ctx.fetch(modesPath(s.over), post({ mode: s.set }));
    s.setStatus = r.status;
  }
  return s;
}

/** One settings row, read in the page: label, words, what is in effect, links and agents. */
function readRow(id) {
  const row = document.querySelector(`.set-row[data-setting="${id}"]`);
  const text = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!row) return { lang: document.documentElement.lang || null, row: null };
  const now = row.querySelector("[data-pmode-now]");
  return {
    lang: document.documentElement.lang || null,
    row: true,
    label: text(row.querySelector(".l")),
    desc: text(row.querySelector(".d")),
    dwNow: text(row.querySelector("[data-dw-now]")) || null,
    overrides: row.querySelector("[data-dw-overrides]")
      ? {
          n: Number(
            row
              .querySelector("[data-dw-overrides]")
              .getAttribute("data-dw-overrides"),
          ),
          text: text(row.querySelector("[data-dw-overrides]")),
          links: [...row.querySelectorAll("[data-dw-overrides] a[href]")].map(
            (a) => ({ href: a.getAttribute("href"), text: text(a) }),
          ),
        }
      : null,
    now: now
      ? { from: now.getAttribute("data-pmode-now"), text: text(now) }
      : null,
    dwLink: row.querySelector("[data-pmode-dw]")
      ? {
          href: row.querySelector("[data-pmode-dw]").getAttribute("href"),
          text: text(row.querySelector("[data-pmode-dw]")),
        }
      : null,
    useDw: text(row.querySelector('[data-pmode="none"]')) || null,
    pressed:
      row.querySelector('[aria-pressed="true"]')?.getAttribute("data-pmode") ??
      row.querySelector('[aria-pressed="true"]')?.getAttribute("data-dwmode") ??
      null,
    agents: [...row.querySelectorAll("[data-pmode-agent]")].map((li) => ({
      agent: li.getAttribute("data-pmode-agent"),
      source: li.getAttribute("data-pmode-source"),
      text: text(li),
    })),
  };
}

async function denWide(ctx) {
  await ctx.goto(ctx.page, "/settings#agents.default_mode");
  await ctx.page
    .waitForSelector('[data-setting="agents.default_mode"] [data-dw-now]', {
      timeout: 20000,
    })
    .catch(() => {});
  return ctx.page.evaluate(readRow, "agents.default_mode");
}
async function projectRow(ctx, ws) {
  await ctx.goto(
    ctx.page,
    `/settings?project=${encodeURIComponent(ws)}#workspace.agents_mode`,
  );
  await ctx.page
    .waitForSelector(
      '[data-setting="workspace.agents_mode"] [data-pmode-now]',
      {
        timeout: 20000,
      },
    )
    .catch(() => {});
  return ctx.page.evaluate(readRow, "workspace.agents_mode");
}
async function agentTag(ctx, ws) {
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
            text: e.textContent.replace(/\s+/g, " ").trim(),
          }
        : null;
    }, sel)
    .catch(() => null);
}

export async function run(ctx, s) {
  const r = { ...s };
  if (!s.over || !s.follow) return r;
  r.api = {
    over: await get(ctx, modesPath(s.over)),
    follow: await get(ctx, modesPath(s.follow)),
    settings: await get(ctx, "/api/settings"),
  };
  r.dw = await denWide(ctx);
  await ctx.shot("den-wide-row");
  r.overRow = await projectRow(ctx, s.over);
  await ctx.shot("project-overrides-row");
  r.followRow = await projectRow(ctx, s.follow);
  await ctx.shot("project-follows-row");
  // The stub restarts at its next idle to take the project's mode; until then its tag says so.
  r.settleMs = await ctx.until(async () => {
    ctx.agent(ID).idlePrompt();
    const v = await get(ctx, modesPath(s.over));
    const m = (v?.agents ?? []).find((a) => a.agent === ID);
    return !m || !m.running;
  }, 90000);
  r.tag = await agentTag(ctx, s.over);
  await ctx.shot("agents-list-tag");
  r.words = {};
  try {
    for (const l of LANGS.slice(1)) {
      const set = await ctx.fetch("/api/settings", post({ language: l }));
      if (set.status !== 200)
        throw new Error(`language ${l}: HTTP ${set.status}`);
      r.words[l] = {
        dw: await denWide(ctx),
        over: await projectRow(ctx, s.over),
        tag: await agentTag(ctx, s.over),
      };
      await ctx.shot(`agents-tag-${l}`);
    }
  } catch (e) {
    r.words.error = String(e?.message ?? e);
  } finally {
    await ctx
      .fetch("/api/settings", post({ language: s.lang }))
      .catch(() => {});
  }
  return r;
}

export async function teardown(ctx, s) {
  if (s?.set && s.over)
    await ctx.fetch(modesPath(s.over), post({ mode: null })).catch(() => {});
  if (ctx.agent(ID).state()) ctx.agent(ID).remove();
}

export function expect(cells) {
  const r = cells[0]?.result ?? {};
  if (!r.over || !r.follow || (r.set && r.setStatus !== 200)) {
    const [skip, detail] = !r.over
      ? [
          "needs-stub-project",
          `${ID} has no running session, so no project of its own`,
        ]
      : !r.follow
        ? [
            "needs-two-projects",
            `the bed has no project besides ${r.over} that follows the Den-wide default`,
          ]
        : [
            "needs-project-mode",
            `setting ${r.over}'s mode was refused: HTTP ${r.setStatus}`,
          ];
    return clauses.map((clause) => ({ clause, ok: null, skip, detail }));
  }
  const dw = r.dw ?? {};
  const over = r.overRow ?? {};
  const fol = r.followRow ?? {};
  const install = r.api?.over?.install ?? null;
  const mode = r.api?.over?.mode ?? null;
  const dwWords = WORDS[install ?? "persona"] ?? install;
  const overWords = WORDS[mode] ?? mode;
  const once = (t) => (String(t ?? "").match(ORDER) ?? []).length === 1;

  // 0. The layers' names and the order, once in each row.
  const names =
    /Den-wide default/.test(dw.label ?? "") &&
    /this project \(overrides the Den-wide default\)/.test(over.label ?? "") &&
    once(dw.desc) &&
    once(over.desc);

  // 1. In effect, and from where.
  const inEffect =
    dw.dwNow === `In effect Den-wide: ${dwWords}` &&
    fol.now?.from === "den-wide" &&
    fol.now?.text === `Following Den-wide: ${dwWords}` &&
    over.now?.from === "project" &&
    over.now?.text ===
      `Set for this project: ${overWords} (Den-wide is ${dwWords})` &&
    over.useDw === "Use Den-wide" &&
    over.pressed === mode;

  // 2. Each row links to the other.
  const overrides = r.api?.settings?.agents_mode_overrides ?? [];
  const n = overrides.length;
  const links = dw.overrides?.links ?? [];
  const toOver = `/settings?project=${encodeURIComponent(r.over)}#workspace.agents_mode`;
  const toFollow = `/settings?project=${encodeURIComponent(r.follow)}#workspace.agents_mode`;
  const linked =
    [over, fol].every(
      (x) =>
        x.dwLink?.href === "/settings#agents.default_mode" &&
        x.dwLink?.text === "Change the Den-wide default",
    ) &&
    dw.overrides?.n === n &&
    n >= 1 &&
    new RegExp(`^${n} projects? overrides? this:`).test(
      dw.overrides?.text ?? "",
    ) &&
    links.some((l) => l.href === toOver) &&
    !links.some((l) => l.href === toFollow);

  // 3. The Agents list: the same words for where the stub's mode comes from.
  const li = (over.agents ?? []).find((a) => a.agent === ID);
  const tag = r.tag;

  // 4. es and ja.
  const w = r.words ?? {};
  const differs = (l, pick) => {
    const v = pick(w[l]);
    const e = pick({ dw, over, tag });
    return !!v && v !== e;
  };
  const picks = {
    "Den-wide label": (x) => x?.dw?.label,
    "Den-wide in effect": (x) => x?.dw?.dwNow,
    "project label": (x) => x?.over?.label,
    "project in effect": (x) => x?.over?.now?.text,
    "project's link": (x) => x?.over?.dwLink?.text,
    "Use Den-wide": (x) => x?.over?.useDw,
  };
  const langOk =
    !w.error &&
    ["es", "ja"].every(
      (l) =>
        w[l]?.dw?.lang === l &&
        Object.values(picks).every((p) => differs(l, p)),
    );

  const shots = (...n) => n.map((x) => `${x}.png`);
  const rows = [
    {
      clause: clauses[0],
      ok: names,
      detail: `Den-wide: "${dw.label}" (order said ${(String(dw.desc).match(ORDER) ?? []).length}×); project: "${over.label}" (order said ${(String(over.desc).match(ORDER) ?? []).length}×)`,
      evidence: shots("den-wide-row", "project-overrides-row"),
    },
    {
      clause: clauses[1],
      ok: inEffect,
      detail: `Den-wide row "${dw.dwNow}"; ${r.follow}: "${fol.now?.text}" (${fol.now?.from}); ${r.over}: "${over.now?.text}" (${over.now?.from}), pressed ${over.pressed}, clear "${over.useDw}"`,
      evidence: shots("project-follows-row", "project-overrides-row"),
    },
    {
      clause: clauses[2],
      ok: linked,
      detail: `${r.over}'s link ${JSON.stringify(over.dwLink)}; ${r.follow}'s ${JSON.stringify(fol.dwLink)}; Den-wide row "${dw.overrides?.text}" (n ${dw.overrides?.n}, Den says ${n}: ${overrides.join(", ")})`,
      evidence: shots("den-wide-row"),
    },
  ];
  if (!li)
    rows.push({
      clause: clauses[3],
      ok: null,
      skip: "needs-mode-runtime",
      detail: `the bed stub's runtime has no permission modes, so ${r.over}'s row lists no mode for ${ID}`,
    });
  else
    rows.push({
      clause: clauses[3],
      ok:
        li.source === "project" &&
        /from the project$/.test(li.text) &&
        tag?.source === "project" &&
        /from the project$/.test(tag?.text ?? ""),
      detail: `Settings: "${li.text}" (${li.source}); Agents list: "${tag?.text}" (${tag?.source})`,
      evidence: shots("agents-list-tag"),
    });
  rows.push({
    clause: clauses[4],
    ok: langOk,
    detail: w.error
      ? `language switch: ${w.error}`
      : ["es", "ja"]
          .map(
            (l) =>
              `${l} (html ${w[l]?.dw?.lang}): ` +
              Object.entries(picks)
                .map(([k, p]) => `${k} "${p(w[l])}"`)
                .join(", "),
          )
          .join("; "),
    evidence: shots("agents-tag-es", "agents-tag-ja"),
  });
  // 5. Either row alone: the project's row names the agent's mode and why; the Den-wide row names the
  // project that overrides and not the one that follows.
  rows.push({
    clause: clauses[5],
    ok:
      inEffect &&
      linked &&
      (!li ||
        (li.source === "project" &&
          li.text.endsWith(`: ${NAMES[mode]}, from the project`))),
    detail: `${r.over} overrides (${mode}), ${r.follow} follows (${install ?? "persona"}); ${li ? `${ID}: "${li.text}"` : `${ID} not listed (stub without modes)`}`,
    evidence: shots(
      "den-wide-row",
      "project-overrides-row",
      "project-follows-row",
    ),
  });
  return rows;
}
