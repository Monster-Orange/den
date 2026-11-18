/* eslint-env browser */
// Live check for #101: the bell opens on "Needs you", and a question goes to the project's lead.
// Bed stub agents only, made as gate-101-* and removed in teardown. Answering is a person's act and is not run.
export const issue = 101;
export const clauses = [
  'things waiting on a person show first in the bell ("Needs you", then "Earlier")',
  "asks across teams go to the team's lead",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;
const WAIT = "gate-101-wait";
const LEAD = "gate-101-lead";
const ASK = "gate-101-ask";
const IDS = [ASK, LEAD, WAIT];

// A finished item (an ask the lead took) is in Updates, not the groups.
const items = (n, id) =>
  [...(n.groups || []), ...(n.updates?.groups || [])]
    .flatMap((g) => g.subjects || [])
    .filter((s) => s.subject === `agent:${id}`)
    .flatMap((s) => s.items || []);

export async function setup(ctx) {
  const s = {};
  // Finished items are off in the bell by default: on for this check, the person's value back in teardown.
  s.bellKindsWas = (await ctx.api("/api/settings"))?.bell_kinds ?? null;
  await ctx.api("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bell_kinds: { ...(s.bellKindsWas || {}), finished: true },
    }),
  });
  // A permission prompt always goes to the person (never to a lead).
  const w = ctx.agent(WAIT);
  w.start("tester");
  s.waitRunMs = await w.running(20000);
  await ctx.sleep(2500);
  w.permissionRequest("Bash");
  s.waitRaiseMs = await ctx.until(
    async () => (await w.waiting("permission")).length > 0,
    10000,
  );

  // Lead routing: a running orchestrator in the project, then another agent asks.
  const lead = ctx.agent(LEAD);
  s.leadStart = lead.start("orchestrator").code;
  s.leadRunMs = await lead.running(20000);
  const ask = ctx.agent(ASK);
  ask.start("tester");
  s.askRunMs = await ask.running(20000);
  await ctx.sleep(2500);
  ask.askHuman("Gate check 101: which one?");
  s.routedMs = await ctx.until(
    async () =>
      items(await ctx.api("/api/notifications"), ASK).some((i) =>
        /asked the lead/.test(i.text || ""),
      ),
    15000,
  );
  const n = await ctx.api("/api/notifications");
  s.askItems = items(n, ASK).map((i) => ({ kind: i.kind, text: i.text }));
  return s;
}

export async function run(ctx, s) {
  const tag = `${ctx.browser}-${ctx.width}`;
  await ctx.goto(ctx.page, "/agents");
  // Bell rows exist only while the panel is open (bell.js): open it, read, close.
  await ctx.page.click("#den-bell").catch(() => {});
  await ctx.page
    .waitForSelector(".den-bell-row", { timeout: 5000 })
    .catch(() => {});
  const r = await ctx.page.evaluate(
    ([wait, ask]) => {
      const secs = [
        ...document.querySelectorAll("#den-bell-pop .den-bell-sec"),
      ];
      const rowsOf = (sec, id) =>
        sec
          ? [...sec.querySelectorAll(".den-bell-row[data-kind]")].filter(
              (e) =>
                (
                  e
                    .querySelector('a[data-bell="open"]')
                    ?.getAttribute("href") || ""
                ).includes(`agent=${id}`) || e.innerText.includes(id),
            )
          : [];
      const needs =
        secs.find((e) => e.getAttribute("data-sec") === "needs") || null;
      return {
        order: secs.map((e) => e.getAttribute("data-sec")),
        headings: secs.map(
          (e) => e.querySelector("h3")?.textContent?.trim() ?? null,
        ),
        needsWaiting: rowsOf(needs, wait).filter(
          (e) => e.getAttribute("data-kind") === "waiting",
        ).length,
        needsMarkRead: needs
          ? needs.querySelectorAll('[data-bell="scope"]').length
          : null,
        askInNeeds: rowsOf(needs, ask).length,
      };
    },
    [WAIT, ASK],
  );
  await ctx.shot(`bell-${tag}`);
  await ctx.page.keyboard.press("Escape").catch(() => {});
  return { ...s, ...r };
}

export function expect(cells) {
  const all = (f) => cells.every(({ result }) => f(result));
  const d = (f) =>
    cells.map(({ cell, result }) => `${cell.browser}: ${f(result)}`).join("; ");
  const shots = cells.map(
    ({ cell }) => `bell-${cell.browser}-${cell.width}.png`,
  );
  return [
    {
      clause: clauses[0],
      ok: all(
        (r) =>
          r.waitRaiseMs !== null &&
          r.order[0] === "needs" &&
          r.order.includes("earlier") &&
          r.needsWaiting > 0 &&
          r.needsMarkRead === 0,
      ),
      detail: d(
        (r) =>
          `sections ${r.order.join(",")} (${r.headings.join(" / ")}), waiting rows under Needs you ${r.needsWaiting}, Mark read there ${r.needsMarkRead}`,
      ),
      evidence: shots,
    },
    {
      clause: clauses[1],
      ok: all(
        (r) =>
          r.leadRunMs !== null &&
          r.routedMs !== null &&
          r.askInNeeds === 0 &&
          !r.askItems.some((i) => i.kind === "waiting"),
      ),
      detail: d(
        (r) =>
          `lead start ${r.leadStart}, running ${r.leadRunMs} ms; routed ${r.routedMs} ms (${r.askItems.map((i) => `${i.kind}: ${i.text}`).join(" | ") || "no rows"}); asker rows under Needs you ${r.askInNeeds}`,
      ),
      evidence: shots,
    },
  ];
}

export async function teardown(ctx, s) {
  for (const id of IDS) if (ctx.agent(id).state()) ctx.agent(id).remove();
  if (s && "bellKindsWas" in s)
    await ctx
      .api("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bell_kinds: s.bellKindsWas }),
      })
      .catch(() => {});
}
