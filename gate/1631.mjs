/* eslint-env browser */
// Live check for #1631: Den's agents get the pstack skill pack by default, and one agent's off switch takes it away.
// One bed stub agent, made as gate-1631-packs and removed in teardown, with agents.gate-1631-packs.skill_packs set
// through the bed's CLI and removed in teardown. What an agent was given is read from the settings file Den wrote
// for its start (an Edit deny on the pack folder it passed), and the folder's own skills from the state folder.
export const issue = 1631;
export const clauses = [
  "a fresh Claude Code agent starts with Den's pinned pstack folder, and that folder holds pstack's skills",
  "after agents.<id>.skill_packs=off and its restart, the agent starts with no pack",
  "den doctor checks the installed pack against its pin and says which copy is in use",
  "den config skill_packs lists the pack, its pin and the agent with packs off",
  "Settings › Agents shows the pstack row with its pin and a link to its licence",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 240000;
const ID = "gate-1631-packs";
const KEY = `agents.${ID}.skill_packs`;

const parse = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
};
const cut = (s, n = 200) =>
  String(s ?? "")
    .trim()
    .slice(0, n);

/** The pack folders Den passed this agent's start: its settings file's Edit denies on a skill-packs folder. */
function packDirs(ctx) {
  const s = parse(ctx.readBed(`state:agent-files/${ID}/settings.json`));
  if (!s) return null;
  const deny = s?.permissions?.deny ?? [];
  return deny
    .map(
      (r) =>
        /^Edit\(\/(\/.*\/skill-packs\/[^/]+@[^/]+\/[^/]+)\/\*\*\)$/.exec(
          r,
        )?.[1],
    )
    .filter(Boolean);
}

/** The skills in the built folder Den shares between agents, read from the state folder. */
function builtSkills(ctx, dir) {
  const rel = /\/(skill-packs\/[^/]+@[^/]+\/[^/]+)$/.exec(dir)?.[1];
  return rel ? (ctx.listBed(`state:${rel}/skills`) ?? []) : [];
}

export async function setup(ctx) {
  const a = ctx.agent(ID);
  a.start("tester");
  const runMs = await a.running(30000);
  return { runMs };
}

export async function run(ctx, state) {
  const r = { runMs: state.runMs };
  const a = ctx.agent(ID);
  if (ctx.width && ctx.browser && ctx.browser !== "chromium") {
    r.page = await settingsRow(ctx);
    return r;
  }
  await ctx.until(() => packDirs(ctx) !== null, 20000);
  r.first = packDirs(ctx);
  r.firstSkills = r.first?.length ? builtSkills(ctx, r.first[0]) : [];
  r.doctor = await ctx.cli(["doctor"], { timeout: 60000 });
  r.set = await ctx.cli(["config", `${KEY}=off`]);
  r.summary = await ctx.cli(["config", "skill_packs"]);
  const before = cut(
    ctx.readBed(`state:agent-files/${ID}/settings.json`),
    4000,
  );
  a.restart();
  r.restartMs = await a.running(30000);
  await ctx.until(
    () =>
      cut(ctx.readBed(`state:agent-files/${ID}/settings.json`), 4000) !==
      before,
    20000,
  );
  r.after = packDirs(ctx);
  r.page = await settingsRow(ctx);
  return r;
}

/** The pstack row in Settings: its pin link (the commit) and its licence link, from the bed's own data. */
async function settingsRow(ctx) {
  const out = {};
  const data = await ctx.api("/api/settings");
  const pack = data?.skill_packs?.packs?.find((p) => p.name === "pstack");
  out.pin = pack?.commit ?? null;
  if (!pack) return out;
  const p = ctx.page;
  await ctx.goto(p, "/settings?category=agents&q=pstack");
  const tree = p.locator(`a[href$="/tree/${pack.commit}/${pack.path}"]`);
  const licence = p.locator(
    `a[href$="/blob/${pack.commit}/${pack.path}/LICENSE"]`,
  );
  await tree
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => undefined);
  out.treeText = (await tree.count())
    ? cut(await tree.first().textContent())
    : null;
  out.licence = await licence.count();
  out.license = pack.license;
  out.skillBoxes = await p.locator("input[data-skill]").count();
  out.skills = pack.skills?.length ?? 0;
  await ctx.shot(`settings-pstack-${ctx.browser}-${ctx.width}`);
  return out;
}

export async function teardown(ctx) {
  await ctx.cli(["config", "rm", KEY]).catch(() => undefined);
  try {
    ctx.agent(ID).remove();
  } catch {
    return;
  }
}

export function expect(cells) {
  const main =
    cells.find((c) => c.cell?.browser === "chromium")?.result ??
    cells[0]?.result ??
    {};
  const pages = cells.map((c) => ({
    cell: c.cell,
    page: c.result?.page ?? {},
  }));
  const rows = [];
  if (!main.runMs) {
    for (const clause of clauses)
      rows.push({ clause, ok: false, detail: "the stub agent didn't start" });
    return rows;
  }
  if (main.first === null) {
    rows.push(
      {
        clause: clauses[0],
        ok: null,
        skip: "needs-claude-runtime",
        detail: "no settings file: the bed's stub isn't started as Claude Code",
      },
      {
        clause: clauses[1],
        ok: null,
        skip: "needs-claude-runtime",
        detail: "no settings file",
      },
    );
  } else {
    const skills = main.firstSkills ?? [];
    rows.push({
      clause: clauses[0],
      ok:
        (main.first?.length ?? 0) === 1 &&
        /\/skill-packs\/pstack@[0-9a-f]{12}\//.test(main.first[0]) &&
        skills.includes("tdd") &&
        !skills.includes("statechart"),
      detail: `pack folders: ${JSON.stringify(main.first)}; ${skills.length} skills in it (tdd: ${skills.includes("tdd")}, statechart: ${skills.includes("statechart")})`,
    });
    rows.push({
      clause: clauses[1],
      ok:
        main.set?.code === 0 &&
        !!main.restartMs &&
        Array.isArray(main.after) &&
        main.after.length === 0,
      detail: `config set: ${main.set?.code}; restarted: ${!!main.restartMs}; pack folders after: ${JSON.stringify(main.after)}`,
    });
  }
  const doc = `${main.doctor?.out ?? ""}`;
  rows.push({
    clause: clauses[2],
    ok:
      /pstack pinned at [0-9a-f]{7}: \d+ files match the pin, MIT licence present/.test(
        doc,
      ) && /(Den's own copy|your own pstack plugin)/.test(doc),
    detail: cut(
      doc
        .split("\n")
        .filter((l) => l.includes("pstack"))
        .join(" | "),
      300,
    ),
  });
  const sum = `${main.summary?.out ?? ""}`;
  rows.push({
    clause: clauses[3],
    ok:
      main.summary?.code === 0 &&
      /pstack: MIT, pinned at [0-9a-f]{7}/.test(sum) &&
      sum.includes(`${ID}: set by the agent`),
    detail: cut(sum.replace(/\n/g, " | "), 300),
  });
  const bad = pages.filter(
    ({ page }) =>
      !page.pin ||
      page.treeText !== page.pin.slice(0, 7) ||
      page.licence < 1 ||
      page.license !== "MIT" ||
      page.skillBoxes !== page.skills,
  );
  rows.push({
    clause: clauses[4],
    ok: pages.length > 0 && bad.length === 0,
    evidence: pages.map(
      ({ cell }) => `settings-pstack-${cell?.browser}-${cell?.width}`,
    ),
    detail: pages
      .map(
        ({ cell, page }) =>
          `${cell?.browser}: pin ${page.treeText ?? "none"}, licence links ${page.licence ?? 0}, ${page.skillBoxes ?? 0} of ${page.skills ?? 0} skill boxes`,
      )
      .join("; "),
  });
  return rows;
}
