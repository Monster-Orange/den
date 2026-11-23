/* eslint-env browser */
// Live check for issue 402, the model set on 11-18: a pin is (company, project or none, person,
// item). The company and the person are the bed's own install and its person; the stored pin is
// { item, project }. Needs two active projects whose Services pages list a service the other's
// doesn't. A person's acts go through the page: the Services page's ☆/★, the rail, and the Undo
// in the toast. The view (the top bar's project) is set the way the menu sets it, POST /api/scope,
// so the CLI default never moves. Each cell starts with an empty save; the person's own pins, which
// a fixture save never removes (issue 946), are set aside and left out of every comparison, and
// their items are never tested. Teardown puts the person's pins and view back as they were.
export const issue = 402;
export const clauses = [
  "pinning records the project picked at that moment; pinned under All projects, the project is none",
  "rail, with a project picked: only the pins made for that project",
  "rail, with no project picked (All): every pin of this person, whatever its project",
  "the same item pinned in two projects is two pins: unpinning in one leaves the other, and ☆/★ follows the project in view, or any pin under All",
  "unpinning from ★ under All removes every pin of that item, and Undo restores exactly the pins removed",
  "pins saved before this change take the item's own project when it has exactly one, else none",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 180000;

const json = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const savePins = (ctx, pins) =>
  ctx.api("/api/settings", json({ shell: { pins } }));
const setView = (ctx, scope) => ctx.api("/api/scope", json({ scope }));
/**
 * The person's own pins: a save by the fixture person never removes them
 * (issue 946), so a bed that has some keeps them through every clause.
 * The check leaves them out of what it compares, and never tests their
 * items. Set at the start of each run, from what an empty save left.
 * Module-level is safe only because cells run one at a time, as they must:
 * every cell writes the same person's pins.
 */
let base = { keys: new Set(), items: new Set() };
const allPins = async (ctx) => {
  const p = (await ctx.api("/api/settings"))?.shell?.pins;
  return Array.isArray(p) ? p : null;
};
const storedPins = async (ctx) => {
  const p = await allPins(ctx);
  return p && p.filter((x) => !base.keys.has(key(x)));
};
const key = (p) =>
  typeof p === "string" ? `${p}@?` : `${p.item}@${p.project ?? ""}`;
const keys = (list) => (Array.isArray(list) ? list.map(key).sort() : null);
const same = (a, b) => JSON.stringify(keys(a)) === JSON.stringify(keys(b));
const sameSet = (a, b) =>
  JSON.stringify([...new Set(a)].sort()) ===
  JSON.stringify([...new Set(b)].sort());

/** The projects whose repos include the item's repo (the store's migration rule). */
function ownersOf(data, item) {
  const repo = String(item).split("/")[0];
  const out = [];
  for (const [slug, ws] of Object.entries(data?.workspaces ?? {})) {
    const repos = new Set(
      Object.keys(ws?.services ?? {}).map((k) => k.split("/")[0]),
    );
    for (const r of Object.keys(ws?.repos ?? {})) repos.add(r);
    if (repos.has(repo)) out.push(slug);
  }
  return out;
}

export async function setup(ctx) {
  const s = {};
  s.pinsWas = await storedPins(ctx);
  s.viewWas = (await ctx.api("/api/scope"))?.scope ?? "all";
  const data = await ctx.api("/api/workspaces");
  s.data = data;
  const active = Array.isArray(data?.active)
    ? data.active
    : data?.active
      ? [data.active]
      : [];
  if (active.length >= 2) s.projects = [active[0], active[1]];
  return s;
}

/** The page's own state: the pins arrived from the server, and the project it reads as picked. */
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
const toggles = (ctx) =>
  ctx.page.evaluate(() =>
    [...document.querySelectorAll("[data-pin-toggle]")].map((b) => ({
      id: b.getAttribute("data-pin-toggle"),
      on: b.getAttribute("aria-pressed") === "true",
    })),
  );
const railPins = async (ctx) =>
  (
    await ctx.page.evaluate(() =>
      [...document.querySelectorAll(".den-rail .den-ni[data-pin]")].map(
        (r) => r.dataset.pin,
      ),
    )
  ).filter((i) => !base.items.has(i));

/** View `scope`, open Services, and wait until the page has the pins and reads the same project. */
async function open(ctx, scope) {
  await setView(ctx, scope);
  await ctx.goto(ctx.page, "/services");
  const want = scope === "all" ? null : scope;
  const ms = await ctx.until(async () => {
    const st = await pageState(ctx);
    return !!st && st.loaded && st.project === want;
  }, 15000);
  return ms !== null;
}

/** ☆/★ for `id` on this page: true, false, or null (no toggle for it here). */
async function starOf(ctx, id) {
  const t = (await toggles(ctx)).find((x) => x.id === id);
  return t ? t.on : null;
}
/** What every ☆/★ for `id` reads on this page (an item no toggle here shows). */
const pinnedHere = (ctx, id) =>
  ctx.page.evaluate((i) => window.denShell?.isPinned?.(i) === true, id);

/**
 * Press ☆/★ for `id` as a person does; with no toggle for it on this page (an item of another
 * project), the same call the toggle makes. Then wait for the store to be `want`.
 */
async function press(ctx, id, want) {
  const sel = `[data-pin-toggle="${id}"]`;
  let via = "click";
  if ((await ctx.page.locator(sel).count()) > 0)
    await ctx.page.locator(sel).first().click();
  else {
    via = "shell";
    await ctx.page.evaluate((i) => {
      const sh = window.denShell;
      if (sh.isPinned(i)) sh.unpin(i);
      else sh.pin(i);
    }, id);
  }
  const ms = await ctx.until(
    async () => same(await storedPins(ctx), want),
    10000,
  );
  return { via, ms, stored: await storedPins(ctx) };
}

/** The rail's pins once they are `want` (as a set), or what they were at the time limit. */
async function railWhen(ctx, want) {
  const ms = await ctx.until(
    async () => sameSet(await railPins(ctx), want),
    10000,
  );
  return { ms, pins: await railPins(ctx) };
}

export async function run(ctx, s) {
  if (!s.projects) return { skipped: "needs-two-projects" };
  const [A, B] = s.projects;
  const tag = `${ctx.browser}-${ctx.width}`;
  const r = { A, B };
  base = { keys: new Set(), items: new Set() };
  await savePins(ctx, []);
  // What an empty save leaves is the person's own (issue 946): kept aside.
  const own = (await allPins(ctx)) ?? [];
  base = {
    keys: new Set(own.map(key)),
    items: new Set(own.map((p) => (typeof p === "string" ? p : p.item))),
  };
  r.personsPins = own.map(key);

  // The items each project's Services page offers to pin.
  if (!(await open(ctx, A))) return { skipped: "needs-services-page" };
  const free = (list) =>
    list.map((x) => x.id).filter((i) => !base.items.has(i));
  const idsA = free(await toggles(ctx));
  await open(ctx, B);
  const idsB = free(await toggles(ctx));
  await open(ctx, "all");
  const idsAll = free(await toggles(ctx));
  const onlyA = idsA.find((i) => !idsB.includes(i));
  const onlyB = idsB.find((i) => !idsA.includes(i));
  if (!onlyA || !onlyB) return { skipped: "needs-two-projects" };
  const x = onlyA; // pinned under A and under B: one item, two pins
  const loose = idsAll.find((i) => i !== onlyA && i !== onlyB) ?? null;
  Object.assign(r, { onlyA, onlyB, x, loose });

  // Clause 2: each pin records the project picked when it was made.
  let want = [];
  await open(ctx, A);
  want = [{ item: onlyA, project: A }];
  r.pinA = await press(ctx, onlyA, want);
  await open(ctx, B);
  want = [...want, { item: onlyB, project: B }];
  r.pinB = await press(ctx, onlyB, want);
  want = [...want, { item: x, project: B }];
  r.pinXB = await press(ctx, x, want);
  if (loose) {
    await open(ctx, "all");
    want = [...want, { item: loose, project: null }];
    r.pinAll = await press(ctx, loose, want);
  }
  r.wantAfterPins = want;
  r.afterPins = await storedPins(ctx);

  // Clause 3: a project picked, only its pins. Clause 5: ★ for the project in view.
  await open(ctx, A);
  r.railA = await railWhen(ctx, [onlyA]);
  r.starXA = await starOf(ctx, x);
  await ctx.shot(`view-a-${tag}`);
  await open(ctx, B);
  r.railB = await railWhen(ctx, [onlyB, x]);
  await ctx.shot(`view-b-${tag}`);

  // Clause 4: All, every pin whatever its project, each item once.
  await open(ctx, "all");
  r.railAllWant = [onlyA, onlyB, ...(loose ? [loose] : [])];
  r.railAll = await railWhen(ctx, r.railAllWant);
  r.starXAll = await starOf(ctx, x);
  await ctx.shot(`view-all-${tag}`);

  // Clause 5: unpin x under A; B's pin of x stays, and ★ there.
  await open(ctx, A);
  const noXA = want.filter((p) => !(p.item === x && p.project === A));
  r.unpinXA = await press(ctx, x, noXA);
  r.starXAAfter = await starOf(ctx, x);
  await open(ctx, B);
  r.railBAfter = await railWhen(ctx, [onlyB, x]);
  r.starXBAfter = await pinnedHere(ctx, x);
  // Pin x under A again: two pins of one item.
  await open(ctx, A);
  r.repinXA = await press(ctx, x, want);

  // The decision: ★ under All unpins every pin of x; Undo puts exactly those back.
  await open(ctx, "all");
  const noX = want.filter((p) => p.item !== x);
  r.unpinAll = await press(ctx, x, noX);
  r.starXAllAfter = await starOf(ctx, x);
  await ctx.shot(`unpin-all-${tag}`);
  const undo = ctx.page.locator(".den-toast .den-tbtn");
  r.undoShown = (await undo.count()) > 0;
  if (r.undoShown) await undo.first().click();
  r.undoMs = await ctx.until(
    async () => same(await storedPins(ctx), want),
    10000,
  );
  r.afterUndo = await storedPins(ctx);
  r.wantAfterUndo = want;

  // Clause 6: an old id-only list (an older page's save) takes each item's one project, else none.
  const legacy = [onlyA, onlyB, ...(loose ? [loose] : [])];
  await savePins(ctx, legacy);
  r.migratedWant = legacy.map((item) => {
    const owners = ownersOf(s.data, item);
    return { item, project: owners.length === 1 ? owners[0] : null };
  });
  r.migrated = await storedPins(ctx);
  await open(ctx, A);
  r.railMigratedA = await railWhen(
    ctx,
    r.migratedWant.filter((p) => p.project === A).map((p) => p.item),
  );
  await ctx.shot(`migrated-a-${tag}`);
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
  const done = (p) => !!p && p.ms !== null;
  const show = (list) =>
    Array.isArray(list) ? list.map(key).join(", ") || "none" : String(list);
  return [
    {
      clause: clauses[0],
      ok: all(
        (r) =>
          done(r.pinA) &&
          done(r.pinB) &&
          done(r.pinXB) &&
          (!r.loose || done(r.pinAll)) &&
          same(r.afterPins, r.wantAfterPins),
      ),
      detail: d(
        (r) =>
          `stored ${show(r.afterPins)} (want ${show(r.wantAfterPins)}); ${r.x} under ${r.B} by ${r.pinXB?.via}`,
      ),
      evidence: shots("view-all"),
    },
    {
      clause: clauses[1],
      ok: all((r) => r.railA.ms !== null && r.railB.ms !== null),
      detail: d(
        (r) =>
          `${r.A}: rail ${r.railA.pins.join(", ") || "none"} (want ${r.onlyA}); ${r.B}: rail ${r.railB.pins.join(", ") || "none"} (want ${r.onlyB}, ${r.x})`,
      ),
      evidence: [...shots("view-a"), ...shots("view-b")],
    },
    {
      clause: clauses[2],
      ok: all((r) => r.railAll.ms !== null),
      detail: d(
        (r) =>
          `All: rail ${r.railAll.pins.join(", ") || "none"} (want ${r.railAllWant.join(", ")})`,
      ),
      evidence: shots("view-all"),
    },
    {
      clause: clauses[3],
      ok: all(
        (r) =>
          r.starXA === true &&
          r.starXAll === true &&
          done(r.unpinXA) &&
          r.starXAAfter === false &&
          r.railBAfter.ms !== null &&
          r.starXBAfter === true &&
          done(r.repinXA),
      ),
      detail: d(
        (r) =>
          `${r.x} pinned under ${r.A} and ${r.B}: ★ under ${r.A} ${r.starXA}, under All ${r.starXAll}; unpinned under ${r.A}: stored ${show(r.unpinXA?.stored)}, ★ under ${r.A} ${r.starXAAfter}, under ${r.B} ${r.starXBAfter}, ${r.B}'s rail ${r.railBAfter.pins.join(", ")}`,
      ),
      evidence: shots("view-b"),
    },
    {
      clause: clauses[4],
      ok: all(
        (r) =>
          done(r.unpinAll) &&
          r.starXAllAfter === false &&
          r.undoShown &&
          r.undoMs !== null,
      ),
      detail: d(
        (r) =>
          `★ under All: stored ${show(r.unpinAll?.stored)}, ☆ ${r.starXAllAfter === false}; Undo shown ${r.undoShown}, after it ${show(r.afterUndo)} (want ${show(r.wantAfterUndo)})`,
      ),
      evidence: shots("unpin-all"),
    },
    {
      clause: clauses[5],
      ok: all(
        (r) => same(r.migrated, r.migratedWant) && r.railMigratedA.ms !== null,
      ),
      detail: d(
        (r) =>
          `old ids saved: stored ${show(r.migrated)} (want ${show(r.migratedWant)}); ${r.A}'s rail ${r.railMigratedA.pins.join(", ") || "none"}`,
      ),
      evidence: shots("migrated-a"),
    },
  ];
}
