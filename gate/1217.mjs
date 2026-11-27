/* eslint-env browser */
// Live check for issue 1217: an old-format pin (an id-only entry, `shell.pins: [repo/service, …]`,
// as a page before 0.4.85 saved it) never vanishes. On load it goes to each project whose services
// or repos include its repo; with none, it's kept with no project, shown under All, and doctor lists
// it as kept. A bare id with no "/" follows the same rules. The old list is saved the way an older
// page saved it, through /api/settings; the view is set the way the menu sets it, POST /api/scope.
// The person's own pins, which a fixture save never removes (issue 946), are set aside and left out
// of every comparison. Teardown puts the person's pins and view back as they were.
// The clause "one bad entry is skipped and named in doctor" needs an entry /api/settings refuses at
// the boundary: it exists only after a hand edit of user.yml, so this check names it and skips it.
export const issue = 1217;
export const clauses = [
  "an old pin whose repo is in one project goes to that project",
  "an old pin whose repo is in two or more projects goes to each of them",
  "an old pin whose repo is in no project is kept with no project, shown under All, and doctor lists it as kept",
  "one bad entry is skipped and named in doctor, and the other pins stay",
  'a bare id with no "/" follows the same rules',
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 180000;

/** An item no project of any bed has: invented, a pin kept with no project. */
const UNOWNED = "gate1217-unowned/web";

const json = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const savePins = (ctx, pins) =>
  ctx.api("/api/settings", json({ shell: { pins } }));
const setView = (ctx, scope) => ctx.api("/api/scope", json({ scope }));

/** The person's own pins (issue 946), set aside at the start of each run. Cells run one at a time. */
let base = { keys: new Set(), items: new Set() };
const key = (p) =>
  typeof p === "string" ? `${p}@?` : `${p.item}@${p.project ?? ""}`;
const keys = (list) => (Array.isArray(list) ? list.map(key).sort() : null);
const same = (a, b) => JSON.stringify(keys(a)) === JSON.stringify(keys(b));
const allPins = async (ctx) => {
  const p = (await ctx.api("/api/settings"))?.shell?.pins;
  return Array.isArray(p) ? p : null;
};
const storedPins = async (ctx) => {
  const p = await allPins(ctx);
  return p && p.filter((x) => !base.keys.has(key(x)));
};

/** The projects whose services or repos include the item's repo (issue 1217's rule). */
function ownersOf(data, item) {
  const [repo] = String(item).split("/");
  const out = [];
  for (const [slug, ws] of Object.entries(data?.workspaces ?? {})) {
    const repos = new Set(
      Object.keys(ws?.services ?? {}).map((k) => k.split("/").shift()),
    );
    for (const r of Object.keys(ws?.repos ?? {})) repos.add(r);
    if (repos.has(repo)) out.push(slug);
  }
  return out;
}
/** What an old id becomes: a pin in each owner, else one with no project. */
const migrated = (data, item) => {
  const o = ownersOf(data, item);
  return o.length
    ? o.map((project) => ({ item, project }))
    : [{ item, project: null }];
};
/** Every item a bed's projects name: each service's key, and each repo. */
function itemsOf(data) {
  const out = new Set();
  for (const ws of Object.values(data?.workspaces ?? {})) {
    for (const k of Object.keys(ws?.services ?? {})) out.add(k);
    for (const r of Object.keys(ws?.repos ?? {})) out.add(r);
  }
  return [...out].sort();
}

export async function setup(ctx) {
  const s = {};
  s.pinsWas = await storedPins(ctx);
  s.viewWas = (await ctx.api("/api/scope"))?.scope ?? "all";
  s.data = await ctx.api("/api/workspaces");
  return s;
}

const pageState = (ctx) =>
  ctx.page.evaluate(() => {
    const st = window.denShell?.getState?.();
    return st
      ? {
          loaded: st.pinsLoaded === true && st.pinViewKnown === true,
          project: st.pinProject ?? null,
        }
      : null;
  });
const railPins = async (ctx) =>
  (
    await ctx.page.evaluate(() =>
      [...document.querySelectorAll("[data-pin][data-svpanel]")].map(
        (r) => r.dataset.pin,
      ),
    )
  ).filter((i) => !base.items.has(i));

/** View `scope`, open Services, and wait until the page has the pins and reads the same project. */
async function open(ctx, scope) {
  await setView(ctx, scope);
  await ctx.goto(ctx.page, "/services");
  const want = scope === "all" ? null : scope;
  return (
    (await ctx.until(async () => {
      const st = await pageState(ctx);
      return !!st && st.loaded && st.project === want;
    }, 15000)) !== null
  );
}
/** The rail's pins once they include every item of `want`, or what they were at the time limit. */
async function railWhen(ctx, want) {
  const ms = await ctx.until(async () => {
    const pins = await railPins(ctx);
    return want.every((i) => pins.includes(i));
  }, 10000);
  return { ms, pins: await railPins(ctx) };
}

export async function run(ctx, s) {
  const tag = `${ctx.browser}-${ctx.width}`;
  const data = s.data;
  const r = {};
  base = { keys: new Set(), items: new Set() };
  await savePins(ctx, []);
  const own = (await allPins(ctx)) ?? [];
  base = {
    keys: new Set(own.map(key)),
    items: new Set(own.map((p) => (typeof p === "string" ? p : p.item))),
  };
  r.personsPins = own.map(key);

  // The items: one whose repo is in one project, one in two or more, and
  // the bare repo of a one-project item (no "/").
  const free = itemsOf(data).filter((i) => !base.items.has(i));
  const n = (i) => ownersOf(data, i).length;
  r.one =
    free.find((i) => i.includes("/") && n(i) === 1) ??
    free.find((i) => n(i) === 1) ??
    null;
  r.two = free.find((i) => n(i) >= 2) ?? null;
  const bareOf = (i) => String(i).split("/").shift();
  r.bare =
    free.find((i) => !i.includes("/") && n(i) === 1 && i !== r.one) ??
    (r.one && r.one.includes("/") && !base.items.has(bareOf(r.one))
      ? bareOf(r.one)
      : null);
  r.none = ownersOf(data, UNOWNED).length ? null : UNOWNED;
  if (!r.one || !r.none) return { skipped: "needs-a-project-with-a-service" };

  // An older page's save: ids only.
  const legacy = [r.one, r.two, r.none, r.bare].filter(Boolean);
  r.legacy = legacy;
  await savePins(ctx, legacy);
  r.want = legacy.flatMap((i) => migrated(data, i));
  r.stored = await storedPins(ctx);

  // The rail: each clause's item in its own project's rail; under All, every
  // item. Each clause judges its own item only, so one clause's miss never
  // fails another.
  [r.A] = ownersOf(data, r.one);
  r.openA = await open(ctx, r.A);
  r.railA = await railWhen(ctx, [r.one]);
  await ctx.shot(`old-a-${tag}`);
  if (r.two) {
    r.twoOwners = ownersOf(data, r.two);
    r.railTwo = [];
    for (const p of r.twoOwners) {
      await open(ctx, p);
      const got = await railWhen(ctx, [r.two]);
      r.railTwo.push({ project: p, has: got.pins.includes(r.two), ms: got.ms });
    }
  }
  r.openAll = await open(ctx, "all");
  r.railAll = await railWhen(ctx, legacy);
  await ctx.shot(`old-all-${tag}`);

  // Doctor: the pin kept with no project is listed by its id.
  const d = ctx.cli(["doctor"]);
  r.doctorCode = d.code;
  r.doctorKept = String(d.out + d.err)
    .split("\n")
    .filter((l) => /kept, no project/.test(l))
    .map((l) => l.trim());

  await savePins(ctx, []);
  return r;
}

export async function teardown(ctx, s) {
  if (s?.pinsWas) await savePins(ctx, s.pinsWas);
  if (s?.viewWas) await setView(ctx, s.viewWas);
}

export function expect(cells) {
  const skipped = cells.map(({ result }) => result?.skipped).find(Boolean);
  if (skipped)
    return clauses.map((clause) => ({ clause, ok: null, skip: skipped }));
  const all = (f) => cells.every(({ result }) => f(result));
  const d = (f) =>
    cells
      .map(({ cell, result }) => `${cell?.browser}: ${f(result)}`)
      .join("; ");
  const shots = (n) =>
    cells.map(({ cell }) => `${n}-${cell?.browser}-${cell?.width}.png`);
  const show = (list) =>
    Array.isArray(list) ? list.map(key).join(", ") || "none" : String(list);
  const pinsOf = (r, item) => (r.stored ?? []).filter((p) => p.item === item);
  const storedAs = (r, item) =>
    same(
      pinsOf(r, item),
      r.want.filter((p) => p.item === item),
    );
  const twoSkip = cells.some(({ result }) => !result?.two);
  const bareSkip = cells.some(({ result }) => !result?.bare);
  return [
    {
      clause: clauses[0],
      ok: all((r) => storedAs(r, r.one) && r.openA && r.railA.ms !== null),
      detail: d(
        (r) =>
          `${r.one}: stored ${show(pinsOf(r, r.one))} (want ${r.one}@${r.A}); ${r.A}'s rail ${r.railA.pins.join(", ") || "none"}`,
      ),
      evidence: shots("old-a"),
    },
    twoSkip
      ? { clause: clauses[1], ok: null, skip: "needs-a-repo-in-two-projects" }
      : {
          clause: clauses[1],
          ok: all(
            (r) =>
              storedAs(r, r.two) &&
              pinsOf(r, r.two).length >= 2 &&
              r.railTwo.every((x) => x.has && x.ms !== null),
          ),
          detail: d(
            (r) =>
              `${r.two} in ${r.twoOwners.join(", ")}: stored ${show(pinsOf(r, r.two))}; in each project's rail: ${r.railTwo.map((x) => `${x.project} ${x.has}`).join(", ")}`,
          ),
          evidence: shots("old-all"),
        },
    {
      clause: clauses[2],
      ok: all(
        (r) =>
          storedAs(r, r.none) &&
          r.openAll &&
          r.railAll.pins.includes(r.none) &&
          r.doctorKept.some((l) => l.includes(r.none)),
      ),
      detail: d(
        (r) =>
          `${r.none}: stored ${show(pinsOf(r, r.none))}; under All the rail has it: ${r.railAll.pins.includes(r.none)}; doctor: ${r.doctorKept.join(" | ") || "no kept line"}`,
      ),
      evidence: shots("old-all"),
    },
    {
      clause: clauses[3],
      ok: null,
      skip: "needs-a-hand-edit",
      detail:
        "/api/settings refuses a bad entry at the boundary, so the bed can't make one; tests/unit/server/pins-old-1217.test.ts proves it",
    },
    bareSkip
      ? { clause: clauses[4], ok: null, skip: "needs-a-one-project-repo" }
      : {
          clause: clauses[4],
          ok: all((r) => storedAs(r, r.bare)),
          detail: d(
            (r) =>
              `${r.bare}: stored ${show(pinsOf(r, r.bare))} (want ${show(r.want.filter((p) => p.item === r.bare))})`,
          ),
          evidence: shots("old-a"),
        },
  ];
}
