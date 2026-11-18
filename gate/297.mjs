/* eslint-env browser */
// Live check for #297: Settings, and every page the rail links, is free of the three axe rules Settings
// failed (aria-required-children, empty-table-header, heading-order), in light and dark.
// The harness has no axe, so the three rules are checked here by their definitions, inside <main>. Read only.
export const issue = 297;
export const clauses = [
  "Settings no longer fails aria-required-children, empty-table-header or heading-order",
  "every page in the nav registry passes those rules, in light and dark, Chromium and WebKit",
  "the a11y test takes its pages from the nav registry, and fails when a registry page has no a11y run",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 240000;

// The three rules, as axe defines them (visible elements only).
function audit() {
  const main = document.querySelector("main") || document.body;
  const shown = (e) =>
    !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) &&
    getComputedStyle(e).visibility !== "hidden";
  const name = (e) =>
    (
      e.getAttribute("aria-label") ||
      e.getAttribute("title") ||
      e.textContent ||
      ""
    ).trim() ||
    (e.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join("");
  const out = [];
  const NEEDS = {
    list: ["listitem"],
    tablist: ["tab"],
    menu: ["menuitem", "menuitemcheckbox", "menuitemradio", "group"],
    menubar: ["menuitem", "menuitemcheckbox", "menuitemradio", "group"],
    listbox: ["option", "group"],
    tree: ["treeitem", "group"],
    grid: ["row", "rowgroup"],
    table: ["row", "rowgroup"],
    row: ["cell", "gridcell", "columnheader", "rowheader"],
    radiogroup: ["radio"],
  };
  for (const e of main.querySelectorAll("[role]")) {
    const role = e.getAttribute("role");
    if (!NEEDS[role] || !shown(e) || e.getAttribute("aria-busy") === "true")
      continue;
    const implicit = (c) =>
      c.getAttribute("role") ||
      {
        LI: "listitem",
        TR: "row",
        TD: "cell",
        TH: "columnheader",
        OPTION: "option",
        TBODY: "rowgroup",
        THEAD: "rowgroup",
        TFOOT: "rowgroup",
      }[c.tagName] ||
      (c.tagName === "INPUT" && c.type === "radio" ? "radio" : null);
    // Owned: the nearest descendants with a role; elements with none (or presentation) are walked through.
    const owned = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (!shown(c)) continue;
        const r = implicit(c);
        if (!r || r === "presentation" || r === "none" || r === "generic")
          walk(c);
        else owned.push(r === "rowgroup" || r === "group" ? (walk(c), r) : r);
      }
    };
    walk(e);
    const kids = owned;
    if (
      kids.some(
        (k) => !NEEDS[role].includes(k) && k !== "rowgroup" && k !== "group",
      )
    )
      out.push(
        `aria-required-children: role=${role} has ${kids.join(",") || "none"}`,
      );
  }
  for (const th of main.querySelectorAll(
    'th, [role="columnheader"], [role="rowheader"]',
  ))
    if (shown(th) && !name(th)) out.push("empty-table-header");
  let last = 0;
  for (const h of main.querySelectorAll(
    'h1, h2, h3, h4, h5, h6, [role="heading"]',
  )) {
    if (!shown(h)) continue;
    const lv = Number(h.getAttribute("aria-level") || h.tagName.slice(1)) || 2;
    if (last && lv > last + 1)
      out.push(
        `heading-order: h${last} then h${lv} "${h.textContent.trim().slice(0, 30)}"`,
      );
    last = lv;
  }
  return out;
}

export async function setup() {
  return {};
}

export async function run(ctx) {
  await ctx.goto(ctx.page, "/agents");
  const pages = await ctx.page.evaluate(() => [
    ...new Set(
      [
        ...document.querySelectorAll(
          'nav a[href^="/"], [data-nav] a[href^="/"], a[data-nav][href^="/"]',
        ),
      ].map((a) => new URL(a.href).pathname),
    ),
  ]);
  if (!pages.includes("/settings")) pages.push("/settings");
  const found = {};
  for (const scheme of ["light", "dark"]) {
    await ctx.page.emulateMedia({ colorScheme: scheme });
    for (const p of pages) {
      await ctx.goto(ctx.page, p).catch(() => {});
      await ctx.page
        .waitForSelector("main", { timeout: 10000 })
        .catch(() => {});
      await ctx.sleep(500);
      const bad = await ctx.page
        .evaluate(audit)
        .catch((e) => [`audit failed: ${String(e).slice(0, 80)}`]);
      if (bad.length) found[`${p} ${scheme}`] = [...new Set(bad)].slice(0, 6);
      if (p === "/settings")
        await ctx.shot(`settings-${scheme}-${ctx.browser}-${ctx.width}`);
    }
  }
  return { pages, found };
}

export function expect(cells) {
  const settings = (r) =>
    Object.entries(r.found).filter(([k]) => k.startsWith("/settings "));
  const d = (f) =>
    cells.map(({ cell, result }) => `${cell.browser}: ${f(result)}`).join("; ");
  return [
    {
      clause: clauses[0],
      ok: cells.every(({ result }) => settings(result).length === 0),
      detail: d((r) =>
        settings(r).length
          ? JSON.stringify(Object.fromEntries(settings(r)))
          : "clean in light and dark",
      ),
      evidence: cells.flatMap(({ cell }) =>
        ["light", "dark"].map(
          (s) => `settings-${s}-${cell.browser}-${cell.width}.png`,
        ),
      ),
    },
    {
      clause: clauses[1],
      ok: cells.every(
        ({ result }) =>
          result.pages.length > 1 && Object.keys(result.found).length === 0,
      ),
      detail: d(
        (r) =>
          `${r.pages.length} pages (${r.pages.join(" ")}); ${Object.keys(r.found).length ? JSON.stringify(r.found) : "all clean"}`,
      ),
    },
    {
      clause: clauses[2],
      ok: null,
      skip: "needs-test-suite",
      detail: "the test's page list is CI's, not a bed's",
    },
  ];
}
