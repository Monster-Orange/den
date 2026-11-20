/* eslint-env browser */
// Live check for issue 307: the rail's kind tag, drawn by the kit, on Den's side. A pinned service ends in
// the kit's SERVICE tag; a link into Hub in HUB; collapsed, the tooltip and the accessible name read
// "<name> · <Kind>"; ⌘K lists projects too; no tag names a machine; es and ja. If the person has no pin,
// the check pins one service and teardown puts the pins back as they were; the rail's collapse and the
// page's language are put back too. Hub's own rail (project and artifact pins, the Den link) is the other
// product's, and seeing it on a person's own rail is theirs.
export const issue = 307;
export const clauses = [
  "Den's pinned services end in the kit's SERVICE tag",
  'collapsed, the tooltip and the accessible name read "<name> · <Kind>"',
  "Den's link into Hub ends in the HUB tag",
  "⌘K lists projects too",
  "the tag never names a machine",
  "the tag's words in es and ja",
  "Hub's rail draws it from the kit: project pins (PROJECT, with the project's initial), artifact pins and the Den link (DEN)",
  'the person sees one "<name> · Project" and one "<name> · Den" on their rail',
];
export const matrix = { browsers: ["chromium"], widths: [1280] };
export const timeoutMs = 150000;

const KINDS = ["project", "den", "service", "hub"];
const WORDS = {
  en: { project: "Project", den: "Den", service: "Service", hub: "Hub" },
  es: { project: "Proyecto", den: "Den", service: "Servicio", hub: "Hub" },
  ja: { project: "プロジェクト", den: "Den", service: "サービス", hub: "Hub" },
};

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
const settings = (ctx, body) => ctx.fetch("/api/settings", post(body));

export async function setup(ctx) {
  const st = await get(ctx, "/api/settings");
  const s = {
    lang: st?.language ?? null,
    pinsWas: st?.shell?.pins ?? [],
    collapsedWas: !!st?.shell?.collapsed,
    machine: st?.machine_name ?? null,
  };
  const ws = (await get(ctx, "/api/workspaces"))?.workspaces ?? {};
  s.projects = Object.keys(ws);
  s.pin = s.pinsWas[0] ?? null;
  if (!s.pin)
    for (const w of Object.values(ws)) {
      const svc = Object.keys(w?.services ?? {})[0];
      if (svc) {
        s.pin = svc;
        s.pinned = true;
        await settings(ctx, { shell: { pins: [svc] } });
        break;
      }
    }
  return s;
}

/** Every rail entry with a kind: its kind, its tag's words, its name and tooltip. */
function readRail() {
  const text = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  return {
    lang: document.documentElement.lang || null,
    collapsed: document.body.classList.contains("den-rail-collapsed"),
    entries: [...document.querySelectorAll(".den-rail .den-ni")].map((a) => ({
      nav: a.getAttribute("data-nav"),
      pin: a.getAttribute("data-pin"),
      kind: a.getAttribute("data-nav-kind"),
      tag: text(a.querySelector(".den-ni-kind")) || null,
      tagLast: a.lastElementChild?.classList.contains("den-ni-kind") ?? false,
      label: text(a.querySelector(".den-lbl")),
      labelShown: (() => {
        const l = a.querySelector(".den-lbl");
        if (!l) return false;
        const b = l.getBoundingClientRect();
        // Collapsed, the kit keeps the label for screen readers only (1 px, clipped).
        return getComputedStyle(l).display !== "none" && b.width > 1;
      })(),
      aria: a.getAttribute("aria-label"),
      title: a.getAttribute("title"),
    })),
  };
}

async function rail(ctx) {
  await ctx.goto(ctx.page, "/agents");
  await ctx.page
    .waitForSelector(".den-rail .den-ni", { timeout: 20000 })
    .catch(() => {});
  return ctx.page.evaluate(readRail);
}

/** ⌘K, a project's name typed: the rows as listed, then Esc. */
async function palette(ctx, ws) {
  const p = ctx.page;
  await p.click("#den-search").catch(() => {});
  const open = await p
    .waitForSelector("#den-pal-q", { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!open) return { open, rows: [] };
  await p.fill("#den-pal-q", ws);
  await p.waitForTimeout(300).catch(() => {});
  const rows = await p.evaluate(() =>
    [...document.querySelectorAll("#den-pal-list li[role=option]")].map(
      (li) => ({
        label: (li.querySelector(".den-pal-l")?.textContent ?? "").trim(),
        kind: (li.querySelector(".den-kind")?.textContent ?? "").trim(),
      }),
    ),
  );
  await ctx.shot("palette-project");
  await p.keyboard.press("Escape").catch(() => {});
  return { open, rows };
}

export async function run(ctx, s) {
  const r = { ...s };
  r.wide = await rail(ctx);
  await ctx.shot("rail-kinds");
  r.palette = s.projects[0]
    ? await palette(ctx, s.projects[0])
    : { open: null, rows: [] };
  try {
    await settings(ctx, { shell: { collapsed: true } });
    r.collapsed = await rail(ctx);
    await ctx.shot("rail-collapsed");
  } finally {
    await settings(ctx, { shell: { collapsed: s.collapsedWas } }).catch(
      () => {},
    );
  }
  r.words = {};
  try {
    for (const l of ["es", "ja"]) {
      const set = await settings(ctx, { language: l });
      if (set.status !== 200)
        throw new Error(`language ${l}: HTTP ${set.status}`);
      r.words[l] = await rail(ctx);
      await ctx.shot(`rail-${l}`);
    }
  } catch (e) {
    r.words.error = String(e?.message ?? e);
  } finally {
    await settings(ctx, { language: s.lang }).catch(() => {});
  }
  return r;
}

export async function teardown(ctx, s) {
  if (s?.pinned)
    await settings(ctx, { shell: { pins: s.pinsWas } }).catch(() => {});
}

export function expect(cells) {
  const r = cells[0]?.result ?? {};
  const rows = [];
  const add = (i, ok, detail, evidence) =>
    rows.push({
      clause: clauses[i],
      ok,
      detail,
      ...(evidence ? { evidence: evidence.map((n) => `${n}.png`) } : {}),
    });
  const skip = (i, why, detail) =>
    rows.push({ clause: clauses[i], ok: null, skip: why, detail });
  const find = (view, f) => (view?.entries ?? []).find(f);
  const named = (e, lang) =>
    e?.label === WORDS[lang][e?.kind]
      ? e.label
      : `${e?.label} · ${WORDS[lang][e?.kind]}`;
  const pinOf = (view) => find(view, (e) => e.pin === r.pin);

  // 0. A pinned service and its tag.
  const pin = pinOf(r.wide);
  if (!r.pin)
    for (const i of [0, 1])
      skip(i, "needs-service", "the bed has no service to pin and no pin");
  else {
    add(
      0,
      pin?.kind === "service" &&
        pin?.tag === "Service" &&
        pin?.tagLast === true,
      `pin ${r.pin}${r.pinned ? " (pinned by the check)" : ""}: ${JSON.stringify(pin ?? null)}`,
      ["rail-kinds"],
    );
    // 1. Collapsed: the label is hidden, and the tooltip and name still say the kind.
    const c = pinOf(r.collapsed);
    const want = pin ? named(pin, "en") : null;
    add(
      1,
      r.collapsed?.collapsed === true &&
        !!c &&
        c.labelShown === false &&
        c.aria === want &&
        c.title === want,
      `collapsed ${r.collapsed?.collapsed}; ${r.pin}: label shown ${c?.labelShown}, name "${c?.aria}", tooltip "${c?.title}" (want "${want}")`,
      ["rail-collapsed"],
    );
  }

  // 2. Hub.
  const hub = find(r.wide, (e) => e.nav === "hub");
  if (!hub)
    skip(
      2,
      "needs-hub",
      "the bed's rail has no link into Hub (no Hub address)",
    );
  else
    add(
      2,
      hub.kind === "hub" &&
        hub.tag === "Hub" &&
        hub.tagLast === true &&
        (hub.aria ?? "").startsWith(named(hub, "en")),
      `Hub link: ${JSON.stringify(hub)}`,
    );

  // 3. ⌘K lists projects.
  const ws = r.projects?.[0];
  const pr = (r.palette?.rows ?? []).find((x) => x.label.includes(ws ?? "\0"));
  if (!ws) skip(3, "needs-project", "the bed has no project");
  else
    add(
      3,
      r.palette?.open === true && !!pr,
      `⌘K opened ${r.palette?.open}; typed "${ws}": ${JSON.stringify((r.palette?.rows ?? []).slice(0, 6))}`,
      ["palette-project"],
    );

  // 4. No tag names a machine: every kind is one of the kit's, in its words.
  const tagged = [r.wide, r.words?.es, r.words?.ja].flatMap((v) =>
    (v?.entries ?? [])
      .filter((e) => e.kind || e.tag)
      .map((e) => ({ ...e, lang: v.lang })),
  );
  const bad = tagged.filter(
    (e) =>
      !(KINDS.includes(e.kind) || e.kind === "artifact") ||
      (KINDS.includes(e.kind) && e.tag !== WORDS[e.lang]?.[e.kind]) ||
      (!!r.machine &&
        (e.tag ?? "").toLowerCase().includes(String(r.machine).toLowerCase())),
  );
  if (!tagged.length)
    skip(
      4,
      "needs-service",
      "no rail entry with a kind on the bed (no pin, no Hub)",
    );
  else
    add(
      4,
      bad.length === 0,
      `${tagged.length} tagged entries (${[...new Set(tagged.map((e) => `${e.lang}:${e.tag}`))].join(", ")}); machine name ${r.machine ?? "none set"}; not a kit kind: ${JSON.stringify(bad)}`,
    );

  // 5. es and ja.
  const w = r.words ?? {};
  if (!r.pin)
    skip(5, "needs-service", "the bed has no service to pin and no pin");
  else {
    const per = ["es", "ja"].map((l) => {
      const e = pinOf(w[l]);
      return {
        l,
        ok:
          w[l]?.lang === l &&
          e?.tag === WORDS[l].service &&
          e?.aria === named(e, l),
        e,
      };
    });
    add(
      5,
      !w.error && per.every((x) => x.ok),
      w.error
        ? `language switch: ${w.error}`
        : per
            .map((x) => `${x.l}: tag "${x.e?.tag}", name "${x.e?.aria}"`)
            .join("; "),
      ["rail-es", "rail-ja"],
    );
  }

  skip(6, "needs-hub", "Hub's rail is the other product's; the bed has no Hub");
  skip(7, "person", "what the person sees on their own rail");
  return rows.sort(
    (a, b) => clauses.indexOf(a.clause) - clauses.indexOf(b.clause),
  );
}
