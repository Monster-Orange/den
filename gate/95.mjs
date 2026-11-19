/* eslint-env browser */
// Live check for issue 95: the UI kit (den-ui) ships with Den and Den's pages are drawn by it: the tokens,
// the global shell (top bar, rail, ☰'s drawer on a phone), the version chip and What's new, the Report
// button and form, the working pop-up, the update pill, and from 0.7.0 the bell, ◐ ▾ and My reports.
// Read only: What's new and Report are opened and closed (Report with Esc, nothing typed, nothing sent).
// The kit's own files are compared with the files Den serves at /kit/, and Den's own public files are
// checked for a byte copy of one (the parity rule, on the installed Den).
export const issue = 95;
export const clauses = [
  "the kit ships inside Den's npm package, and Den serves its files unchanged",
  "every page uses the kit's tokens, fonts and base",
  "the global shell is the kit's: the top bar, the left rail with collapse, and ☰'s drawer on a phone",
  "the version chip says the running version, and What's new opens from it, the kit's",
  "the Report button is on every page and opens the kit's Report form",
  "the working pop-up is the kit's",
  "the update pill is the kit's",
  "from den-ui 0.7.0: the bell, the theme and mode choice (◐ ▾) and My reports are the kit's",
  "Den keeps no copy of a kit file of its own",
];
export const matrix = { browsers: ["chromium"], widths: [1280, 390] };
export const timeoutMs = 180000;

const PAGES = ["/agents", "/settings", "/services"];
const KIT_FILES = [
  "tokens.css",
  "fonts.css",
  "base.css",
  "busy.js",
  "report.js",
  "whatsnew.js",
  "shell.css",
  "kit.js",
  "update-pill.js",
];

async function get(ctx, path) {
  try {
    const r = await ctx.fetch(path);
    return r.status === 200 ? r.body : null;
  } catch {
    return null;
  }
}
const asText = (b) =>
  b === null || b === undefined
    ? null
    : typeof b === "string"
      ? b
      : JSON.stringify(b);

/** The engine's folder in the bed: its dependency named <scope>/den, from the bed's package.json. */
function engineDir(ctx) {
  try {
    const p = JSON.parse(ctx.readBed("package.json") ?? "{}");
    const name = Object.keys({
      ...p.dependencies,
      ...p.devDependencies,
    }).find((n) => /^@[^/]+\/den$/.test(n));
    return name ? `node_modules/${name}` : null;
  } catch {
    return null;
  }
}

export async function setup(ctx) {
  const engine = engineDir(ctx);
  const s = { engine, info: await get(ctx, "/api/server-info") };
  if (!engine) return s;
  try {
    s.kitPkg = JSON.parse(
      ctx.readBed(`${engine}/packages/den-ui/package.json`) ?? "null",
    );
  } catch {
    s.kitPkg = null;
  }
  // Each kit file as installed, and as Den serves it.
  s.served = {};
  for (const f of KIT_FILES) {
    const r = await ctx.fetch(`/kit/${f}`).catch(() => null);
    const mine = ctx.readBed(`${engine}/packages/den-ui/src/${f}`);
    s.served[f] = {
      status: r?.status ?? null,
      same: mine !== null && asText(r?.body)?.trim() === mine.trim(),
    };
  }
  // Den's working pop-up wrapper, as served.
  s.busyDen = asText((await ctx.fetch("/busy-den.js").catch(() => null))?.body);
  // The parity rule on the installed Den: no file of Den's own with the bytes of a kit file.
  const kit = {};
  for (const f of ctx.listBed(`${engine}/packages/den-ui/src`) ?? [])
    if (/\.(js|css)$/.test(f))
      kit[f] = ctx.readBed(`${engine}/packages/den-ui/src/${f}`);
  s.copies = [];
  const pub = `${engine}/src/ui/server/public`;
  for (const f of ctx.listBed(pub) ?? []) {
    if (!/\.(js|css)$/.test(f)) continue;
    const t = ctx.readBed(`${pub}/${f}`);
    for (const [k, v] of Object.entries(kit))
      if (t !== null && v !== null && t === v) s.copies.push(`${f} = kit ${k}`);
  }
  s.scanned = Object.keys(kit).length;
  s.diverge = ctx.readBed(`${engine}/DIVERGE.md`) !== null;
  return s;
}

/** The page's shell, read in the page. */
function readShell() {
  const q = (s) => document.querySelector(s);
  const text = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  const sheet = (href) => {
    const l = q(`link[rel="stylesheet"][href="${href}"]`);
    try {
      return !!l?.sheet && l.sheet.cssRules.length > 0;
    } catch {
      return false;
    }
  };
  const css = getComputedStyle(document.documentElement);
  return {
    tokens: sheet("/kit/tokens.css"),
    fonts: sheet("/kit/fonts.css"),
    base: sheet("/kit/base.css"),
    sans: css.getPropertyValue("--sans").trim(),
    shellScript: !!q('script[src="/den-ui-shell.js"]'),
    kitShell: typeof window.DenUIShell === "object" && !!window.DenUIShell,
    top: !!q("header.den-top"),
    rail: !!q(".den-rail"),
    railItems: document.querySelectorAll(".den-rail .den-ni").length,
    collapse: !!q(".den-collapse-btn"),
    menuBtn: !!q("#den-menu-btn"),
    chip: text(q("#version-pill .v-txt")),
    report: !!q("button.den-rb[data-den-report]"),
    bell: !!q("#den-bell.den-bell"),
    appearance: !!q("#appearance-btn.appearance-btn"),
    update: !!q(".den-upd .upd-pill"),
    brand: text(q(".den-top .den-title")),
  };
}

async function settle(p) {
  await p.waitForSelector("header.den-top", { timeout: 20000 }).catch(() => {});
  // What's new may open by itself over a page: closed by its ×, as a person does.
  if (
    await p
      .locator("#cl-overlay.open")
      .count()
      .catch(() => 0)
  ) {
    await p.click("#cl-close-btn").catch(() => {});
    await p.waitForTimeout(300).catch(() => {});
  }
}

/** Opens What's new from the chip: whether it opened, its title, and whether × closed it. */
async function whatsNew(ctx) {
  const p = ctx.page;
  await p.click("#version-pill").catch(() => {});
  const open = await p
    .waitForSelector("#cl-overlay.open #cl-title", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  const title = open ? await p.locator("#cl-title").textContent() : null;
  await ctx.shot(`whats-new-${ctx.width}`);
  await p.click("#cl-close-btn").catch(() => {});
  const closed = await p
    .waitForSelector("#cl-overlay.open", { state: "detached", timeout: 5000 })
    .then(() => true)
    .catch(async () => !(await p.locator("#cl-overlay.open").count()));
  return { open, title: title?.trim() ?? null, closed };
}

/** Opens Report from its button, reads the form, then Esc (nothing typed: nothing to discard). */
async function report(ctx) {
  const p = ctx.page;
  await p.locator("button.den-rb[data-den-report]").first().click();
  const open = await p
    .waitForSelector("dialog.fb-dlg[open]", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  const mine = await p.locator('dialog.fb-dlg [data-act="mine"]').count();
  const kind = await p.locator("dialog.fb-dlg #fb-kind").count();
  await ctx.shot(`report-${ctx.width}`);
  await p.keyboard.press("Escape").catch(() => {});
  const discard = p.locator('dialog.fb-dlg [data-act="discard"]');
  if (await discard.count().catch(() => 0)) await discard.first().click();
  const closed = await p
    .waitForSelector("dialog.fb-dlg[open]", {
      state: "detached",
      timeout: 5000,
    })
    .then(() => true)
    .catch(async () => !(await p.locator("dialog.fb-dlg[open]").count()));
  return { open, mine: mine > 0, kind: kind > 0, closed };
}

/** ◐ ▾: its menu opens with the mode and the theme, then Esc. */
async function appearance(ctx) {
  const p = ctx.page;
  await p.click("#appearance-btn").catch(() => {});
  const items = await p
    .waitForSelector('.den-pop[role="menu"] [role="menuitemradio"]', {
      timeout: 5000,
    })
    .then(() =>
      p.locator('.den-pop[role="menu"] [role="menuitemradio"]').count(),
    )
    .catch(() => 0);
  await p.keyboard.press("Escape").catch(() => {});
  return { items };
}

/** ☰'s state and the rail's box, read in the page. */
function drawerState() {
  const b = document.querySelector("#den-menu-btn");
  const r = document.querySelector(".den-rail");
  const box = r?.getBoundingClientRect();
  return {
    expanded: b?.getAttribute("aria-expanded") ?? null,
    shown: !!box && box.width > 0 && box.right > 0,
  };
}

/** On a phone: ☰ opens the rail as a drawer, and Esc closes it. */
async function drawer(ctx) {
  const p = ctx.page;
  await p.click("#den-menu-btn").catch(() => {});
  await p.waitForTimeout(400).catch(() => {});
  const open = await p.evaluate(drawerState);
  await ctx.shot("drawer-390");
  await p.keyboard.press("Escape").catch(() => {});
  await p.waitForTimeout(400).catch(() => {});
  return { ...open, after: (await p.evaluate(drawerState)).expanded };
}

export async function run(ctx, setupState) {
  const p = ctx.page;
  const r = { width: ctx.width, pages: {}, setup: setupState };
  if (ctx.width < 600) {
    await ctx.goto(p, PAGES[0]);
    await settle(p);
    r.pages[PAGES[0]] = await p.evaluate(readShell);
    r.drawer = await drawer(ctx);
    return r;
  }
  for (const path of PAGES) {
    await ctx.goto(p, path);
    await settle(p);
    r.pages[path] = await p.evaluate(readShell);
    await ctx.shot(`shell${path.replace(/\//g, "-")}`);
  }
  r.whatsNew = await whatsNew(ctx);
  r.report = await report(ctx);
  r.appearance = await appearance(ctx);
  return r;
}

export function expect(cells) {
  const wide = cells.find((c) => c.cell.width >= 600)?.result ?? {};
  const phone = cells.find((c) => c.cell.width < 600)?.result ?? {};
  // setup's state reaches expect only through run's result.
  const s = wide.setup ?? phone.setup ?? {};
  const pages = Object.entries(wide.pages ?? {});
  const all = (f) =>
    pages.length === PAGES.length && pages.every(([, v]) => f(v));
  const list = (f) => pages.map(([k, v]) => `${k}: ${f(v)}`).join("; ");
  const version = s.info?.version ?? null;
  const rows = [];
  const row = (i, ok, detail, evidence) =>
    rows.push({
      clause: clauses[i],
      ok,
      detail,
      ...(evidence ? { evidence: evidence.map((n) => `${n}.png`) } : {}),
    });

  // 0. Shipped and served unchanged.
  const served = Object.entries(s.served ?? {});
  if (!s.engine)
    rows.push({
      clause: clauses[0],
      ok: null,
      skip: "needs-engine-files",
      detail: "the bed's package.json names no <scope>/den dependency",
    });
  else
    row(
      0,
      /\/den-ui$/.test(s.kitPkg?.name ?? "") &&
        !!s.kitPkg?.version &&
        served.length === KIT_FILES.length &&
        served.every(([, v]) => v.status === 200 && v.same),
      `kit ${s.kitPkg?.name}@${s.kitPkg?.version} in ${s.engine}/packages/den-ui; ` +
        served
          .map(
            ([f, v]) => `/kit/${f} ${v.status}${v.same ? " same" : " differs"}`,
          )
          .join(", "),
    );

  // 1. Tokens, fonts and base on every page.
  row(
    1,
    all((v) => v.tokens && v.fonts && v.base && !!v.sans),
    list(
      (v) =>
        `tokens ${v.tokens}, fonts ${v.fonts}, base ${v.base}, --sans "${v.sans}"`,
    ),
  );

  // 2. The shell, and the drawer on a phone.
  const ph = phone.pages?.[PAGES[0]] ?? {};
  const d = phone.drawer ?? {};
  row(
    2,
    all(
      (v) =>
        v.shellScript &&
        v.kitShell &&
        v.top &&
        v.rail &&
        v.railItems > 0 &&
        v.collapse,
    ) &&
      ph.top === true &&
      ph.menuBtn === true &&
      d.expanded === "true" &&
      d.shown === true &&
      d.after === "false",
    `${list((v) => `kit shell ${v.shellScript && v.kitShell}, top ${v.top}, rail ${v.rail} (${v.railItems} items), collapse ${v.collapse}`)}; phone: ☰ ${ph.menuBtn}, drawer open ${d.expanded}/${d.shown}, Esc → ${d.after}`,
    PAGES.map((x) => `shell${x.replace(/\//g, "-")}`).concat("drawer-390"),
  );

  // 3. The chip and What's new.
  const w = wide.whatsNew ?? {};
  row(
    3,
    !!version &&
      all((v) => v.chip === `v${String(version).replace(/^v/, "")}`) &&
      w.open === true &&
      !!w.title &&
      w.closed === true,
    `running ${version}; chips ${list((v) => `"${v.chip}"`)}; What's new opened ${w.open} ("${w.title}"), closed ${w.closed}`,
    ["whats-new-1280"],
  );

  // 4. Report on every page, and its form.
  const rp = wide.report ?? {};
  row(
    4,
    all((v) => v.report) &&
      rp.open === true &&
      rp.kind === true &&
      rp.closed === true,
    `${list((v) => `Report ${v.report}`)}; form opened ${rp.open}, kind field ${rp.kind}, closed with Esc ${rp.closed} (nothing typed, nothing sent)`,
    ["report-1280"],
  );

  // 5. The working pop-up: Den's wrapper is the kit's busy.js, with no element of its own.
  const b = s.busyDen ?? "";
  row(
    5,
    /from\s+["']\/kit\/busy\.js["']/.test(b) &&
      !/customElements\.define\(\s*["']den-busy/.test(b) &&
      s.served?.["busy.js"]?.same === true,
    `/busy-den.js imports /kit/busy.js: ${/from\s+["']\/kit\/busy\.js["']/.test(b)}; defines its own <den-busy>: ${/customElements\.define\(\s*["']den-busy/.test(b)}; /kit/busy.js as installed: ${s.served?.["busy.js"]?.same}`,
  );

  // 6. The update pill shows only when a newer Den waits.
  if (!s.info?.engineStale)
    rows.push({
      clause: clauses[6],
      ok: null,
      skip: "needs-pending-update",
      detail: `no newer Den waits on the bed (engineStale ${s.info?.engineStale}); /kit/update-pill.js ${s.served?.["update-pill.js"]?.status}`,
    });
  else
    row(
      6,
      all((v) => v.update) && s.served?.["update-pill.js"]?.same === true,
      list((v) => `pill ${v.update}`),
    );

  // 7. 0.7.0's parts.
  const ap = wide.appearance ?? {};
  row(
    7,
    all((v) => v.bell && v.appearance) && ap.items >= 2 && rp.mine === true,
    `${list((v) => `bell ${v.bell}, ◐ ▾ ${v.appearance}`)}; ◐ ▾ menu choices ${ap.items}; My reports in Report ${rp.mine}`,
  );

  // 8. No byte copy of a kit file in Den's own public files.
  if (!s.engine || !s.scanned)
    rows.push({
      clause: clauses[8],
      ok: null,
      skip: "needs-engine-files",
      detail: "the installed kit's files could not be listed",
    });
  else
    row(
      8,
      (s.copies ?? []).length === 0,
      `${s.scanned} kit files against Den's public files: ${(s.copies ?? []).length ? s.copies.join(", ") : "no copy"}${s.diverge ? "; DIVERGE.md present" : ""}`,
    );
  return rows;
}
