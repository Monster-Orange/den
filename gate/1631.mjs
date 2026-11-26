export const issue = 1631;
export const clauses = [
  "a fresh Claude Code agent starts with Den's pinned pstack folder, and that folder holds pstack's skills",
  "after den config agents.<id>.skill_packs=off, Den restarts the agent on its own and it runs with no pack",
  "den doctor checks the installed pack against its pin and says which copy is in use",
  "den config skill_packs lists the pack, its pin and the agent with packs off",
  "Settings › Agents shows the pstack row with its pin and a link to its licence",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 360000;
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
  r.autoMs = await ctx.until(
    () =>
      cut(ctx.readBed(`state:agent-files/${ID}/settings.json`), 4000) !==
      before,
    120000,
  );
  r.restartMs = await a.running(30000);
  r.after = packDirs(ctx);
  r.page = await settingsRow(ctx);
  return r;
}

async function settingsRow(ctx) {
  const out = {};
  const data = await ctx.api("/api/settings");
  const pack = data?.skill_packs?.packs?.find((p) => p.name === "pstack");
  out.pin = pack?.commit ?? null;
  if (!pack) return out;
  const p = ctx.page;
  await ctx.goto(p, "/settings?category=agents&q=pstack");
  const tree = p.getByRole("link", {
    name: pack.commit.slice(0, 7),
    exact: true,
  });
  const licenceWord = await p.evaluate(() =>
    globalThis.denShell.t("set.ui.skillPackLicence"),
  );
  const licence = p.getByRole("link", { name: licenceWord, exact: true });
  await tree.waitFor({ timeout: 20000 }).catch(() => undefined);
  out.treeText =
    (await tree.count()) === 1 &&
    (await tree.getAttribute("href"))?.endsWith(
      `/tree/${pack.commit}/${pack.path}`,
    )
      ? cut(await tree.textContent())
      : null;
  out.licence =
    (await licence.count()) === 1 &&
    (await licence.getAttribute("href"))?.endsWith(
      `/blob/${pack.commit}/${pack.path}/LICENSE`,
    )
      ? 1
      : 0;
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
  const main = cells.find((c) => c.cell?.browser === "chromium")?.result ?? {};
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
        main.autoMs != null &&
        !!main.restartMs &&
        Array.isArray(main.after) &&
        main.after.length === 0,
      detail: `config set: ${main.set?.code}; restarted by Den: ${main.autoMs != null ? `${main.autoMs} ms` : "no"}; running: ${!!main.restartMs}; pack folders after: ${JSON.stringify(main.after)}`,
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
