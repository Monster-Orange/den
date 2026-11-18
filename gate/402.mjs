/* eslint-env browser */
// Live check for #402: "If I have pinned a service then when I filter by project, also filter it."
// It needs two active projects, each with a repo the other lacks. Setup pins one repo of each (only
// pins that were not there already) and teardown puts the person's pins and view back as they were.
export const issue = 402;
export const clauses = [
  "filtered to a project, a pinned service of another project is hidden in the rail",
  "filtered to a project, its own pinned services still show",
  "clearing the filter shows every pin again",
  "filtering never deletes or changes the pins",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;

const reposOf = (ws) => {
  const out = new Set();
  for (const k of Object.keys(ws?.services ?? {})) out.add(k.split("/")[0]);
  for (const k of Object.keys(ws?.repos ?? {})) out.add(k);
  return out;
};

async function setPins(ctx, pins) {
  return ctx.api("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shell: { pins } }),
  });
}

async function setView(ctx, scope) {
  return ctx.api("/api/scope", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope }),
  });
}

export async function setup(ctx) {
  const s = {};
  s.pinsWas = (await ctx.api("/api/settings"))?.shell?.pins ?? [];
  s.viewWas = (await ctx.api("/api/scope"))?.scope ?? "all";
  const data = await ctx.api("/api/workspaces");
  const active = Array.isArray(data?.active)
    ? data.active
    : data?.active
      ? [data.active]
      : [];
  // Two active projects, each with a repo the other doesn't have.
  for (const a of active)
    for (const b of active) {
      if (a === b || s.other) continue;
      const ra = reposOf(data.workspaces?.[a]);
      const rb = reposOf(data.workspaces?.[b]);
      const onlyA = [...ra].find((r) => !rb.has(r));
      const onlyB = [...rb].find((r) => !ra.has(r));
      if (onlyA && onlyB) {
        s.other = { project: a, pin: onlyA };
        s.mine = { project: b, pin: onlyB };
      }
    }
  if (!s.other) return s;
  s.pins = [...new Set([...s.pinsWas, s.other.pin, s.mine.pin])];
  await setPins(ctx, s.pins);
  return s;
}

async function railPins(ctx) {
  return ctx.page.evaluate(() =>
    [...document.querySelectorAll(".den-rail .den-ni[data-pin]")].map(
      (r) => r.dataset.pin,
    ),
  );
}

/** Opens Agents and waits until the rail's pins answer `ok` (the pill's model arrives on its own time). */
async function railWhen(ctx, ok) {
  await ctx.goto(ctx.page, "/agents");
  await ctx.page
    .waitForSelector(".den-rail .den-ni", { timeout: 10000 })
    .catch(() => {});
  const ms = await ctx.until(async () => ok(await railPins(ctx)), 10000);
  return { ms, pins: await railPins(ctx) };
}

export async function run(ctx, s) {
  if (!s.other) return { skipped: true };
  const tag = `${ctx.browser}-${ctx.width}`;
  const r = { other: s.other, mine: s.mine };
  await setView(ctx, s.mine.project);
  r.filtered = await railWhen(ctx, (p) => !p.includes(s.other.pin));
  await ctx.shot(`filtered-${tag}`);
  r.pinsAfterFilter = (await ctx.api("/api/settings"))?.shell?.pins ?? null;
  await setView(ctx, "all");
  r.cleared = await railWhen(
    ctx,
    (p) => p.includes(s.other.pin) && p.includes(s.mine.pin),
  );
  await ctx.shot(`cleared-${tag}`);
  r.pinsAfterClear = (await ctx.api("/api/settings"))?.shell?.pins ?? null;
  r.pinsSet = s.pins;
  return r;
}

export async function teardown(ctx, s) {
  if (s?.pinsWas) await setPins(ctx, s.pinsWas);
  if (s?.viewWas) await setView(ctx, s.viewWas);
}

export function expect(cells) {
  if (cells.some(({ result }) => result?.skipped))
    return clauses.map((clause) => ({
      clause,
      ok: null,
      skip: "needs-two-projects",
    }));
  const all = (f) => cells.every(({ result }) => f(result));
  const d = (f) =>
    cells.map(({ cell, result }) => `${cell.browser}: ${f(result)}`).join("; ");
  const shots = (n) =>
    cells.map(({ cell }) => `${n}-${cell.browser}-${cell.width}.png`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return [
    {
      clause: clauses[0],
      ok: all((r) => !r.filtered.pins.includes(r.other.pin)),
      detail: d(
        (r) =>
          `view ${r.mine.project}: rail pins ${r.filtered.pins.join(", ") || "none"} (${r.other.pin} of ${r.other.project} hidden: ${!r.filtered.pins.includes(r.other.pin)})`,
      ),
      evidence: shots("filtered"),
    },
    {
      clause: clauses[1],
      ok: all((r) => r.filtered.pins.includes(r.mine.pin)),
      detail: d(
        (r) =>
          `view ${r.mine.project}: ${r.mine.pin} shown ${r.filtered.pins.includes(r.mine.pin)}`,
      ),
      evidence: shots("filtered"),
    },
    {
      clause: clauses[2],
      ok: all((r) => r.cleared.ms !== null),
      detail: d(
        (r) =>
          `All active: rail pins ${r.cleared.pins.join(", ") || "none"} (${r.cleared.ms} ms)`,
      ),
      evidence: shots("cleared"),
    },
    {
      clause: clauses[3],
      ok: all(
        (r) =>
          same(r.pinsAfterFilter, r.pinsSet) &&
          same(r.pinsAfterClear, r.pinsSet),
      ),
      detail: d(
        (r) =>
          `saved pins after the filter ${same(r.pinsAfterFilter, r.pinsSet) ? "unchanged" : JSON.stringify(r.pinsAfterFilter)}, after clearing ${same(r.pinsAfterClear, r.pinsSet) ? "unchanged" : JSON.stringify(r.pinsAfterClear)}`,
      ),
      evidence: shots("filtered"),
    },
  ];
}
